import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core import db as db_mod
from app.core.db import init_engine
from app.services.llm_service import llm_service
from app.services.ocr_manager import OCRManager

logger = logging.getLogger(__name__)

# 脏库自愈的最低锚点：alembic 首个 revision。库结构上找不到任何较新标记时，
# stamp 到这里让 upgrade 从 3f9 起补跑（已是 bd14 形态的表由索引迁移等增量
# 幂等处理，冲突走 ensure_migrated 的兜底路径）。
_BASE_REVISION = "bd14f5e2e468"


def _alembic_config():
    from pathlib import Path

    from alembic.config import Config

    server_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    return cfg


def run_migrations() -> None:
    """Alembic 管理 DDL；应用启动自动 upgrade head。"""
    from alembic import command

    command.upgrade(_alembic_config(), "head")


def _scan_migration_chain():
    """扫描 migrations/versions 目录，返回 (全部 revision 集合, head 集合)。

    任何不确定（脚本解析失败 / 多 head）返回 None，由调用方回退保守路径。
    """
    import ast
    from pathlib import Path

    server_dir = Path(__file__).resolve().parents[1]
    versions_dir = server_dir / "migrations" / "versions"
    revisions: set[str] = set()
    down_revisions: set[str] = set()
    try:
        for f in versions_dir.glob("*.py"):
            tree = ast.parse(f.read_text(encoding="utf-8"))
            rev = None
            down = None
            for node in ast.walk(tree):
                # alembic 模板生成带注解赋值（revision: str = "..."），是
                # AnnAssign 而非 Assign——两种形态都要接住
                if isinstance(node, ast.Assign):
                    targets, value = node.targets, node.value
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    targets, value = [node.target], node.value
                else:
                    continue
                for target in targets:
                    if not isinstance(target, ast.Name):
                        continue
                    if not (isinstance(value, ast.Constant) and isinstance(value.value, str)):
                        continue
                    if target.id == "revision":
                        rev = value.value
                    elif target.id == "down_revision":
                        down = value.value
            if rev is None:
                return None
            revisions.add(rev)
            if down is not None:
                down_revisions.add(down)
            # down_revision 非 str 常量（None 首节点 / merge 元组）不收集：
            # merge 点会改变 head 集合，交由完整 alembic 处理
    except (OSError, SyntaxError):
        return None

    heads = revisions - down_revisions
    if len(heads) != 1:
        return None
    return revisions, heads


def _migration_up_to_date() -> bool:
    """迁移快速路径：DB 版本已等于目录唯一 head 时可跳过 alembic。

    任何不确定（脚本解析失败 / 多 head / 版本表缺失或含未知版本）一律返回
    False 回退完整 alembic upgrade——宁可慢不可错。
    """
    import sqlite3
    from pathlib import Path

    chain = _scan_migration_chain()
    if chain is None:
        return False
    head = next(iter(chain[1]))

    db_path = get_settings().db_path
    if not Path(db_path).exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT version_num FROM alembic_version").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return False
    return [r[0] for r in rows] == [head]


def _infer_revision_from_schema(con, tables: set[str]):
    """按标记列/表从新到旧反推库结构对应的 revision；推断不出返回 None。

    标记与迁移的对应关系（新 → 旧）：
      papers.file_type              → e8a1f2c3b4d5（加 file_type/orig_filename）
      word_groups 表                → d4e5f6a7b8c9d0（建 word_groups）
      words.group_name 或
      translate_history 表          → c3d4e5f6a7b8（加 group_name / 建翻译历史）
      papers.arxiv_id               → b5d2e8f41a76
      papers.sort_order             → e7a2c94f1b38
    新增迁移后在此追加标记；漏更只降低脏库推断精度（stamp 停在旧锚点，
    upgrade 会补跑新迁移，冲突由 ensure_migrated 兜底）。
    """
    def columns(table: str) -> set[str]:
        if table not in tables:
            return set()
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}

    papers_cols = columns("papers")
    if "file_type" in papers_cols:
        return "e8a1f2c3b4d5"
    if "word_groups" in tables:
        return "d4e5f6a7b8c9d0"
    if "group_name" in columns("words") or "translate_history" in tables:
        return "c3d4e5f6a7b8"
    if "arxiv_id" in papers_cols:
        return "b5d2e8f41a76"
    if "sort_order" in papers_cols:
        return "e7a2c94f1b38"
    return None


def _repair_dirty_db() -> None:
    """脏库自愈：业务表已存在而 alembic_version 缺失/失真的库。

    来源：手工拷贝、Base.metadata.create_all 直建、迁移中途崩溃半应用
    （alembic 对 SQLite 按非事务 DDL 执行，DDL 逐条自动提交——半应用时
    DDL 已落库而版本表仍旧值，batch 迁移还会遗留 _alembic_tmp_* 表）。
    处理：按 schema 反推 revision 重盖 alembic_version，让后续 upgrade
    只补跑真正缺失的增量。
    """
    import sqlite3
    from pathlib import Path

    db_path = get_settings().db_path
    if not Path(db_path).exists():
        return
    chain = _scan_migration_chain()
    if chain is None:
        return
    known_revisions, _heads = chain

    con = sqlite3.connect(str(db_path))
    try:
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if "users" not in tables:
            return  # 空库/非本应用库，交由 alembic 正常建表
        inferred = _infer_revision_from_schema(con, tables)

        raw_stored = None
        stored = None
        if "alembic_version" in tables:
            rows = con.execute("SELECT version_num FROM alembic_version").fetchall()
            if len(rows) == 1:
                raw_stored = rows[0][0]
                if raw_stored in known_revisions:
                    stored = raw_stored

        if inferred is not None:
            if stored == inferred:
                return
        elif stored is not None:
            # 版本表有效但与标记推断脱节（库早于全部标记）：交 alembic 正常升级
            return
        else:
            # 无任何标记且无有效版本表：stamp 最低锚点，让 upgrade 补跑全链
            inferred = _BASE_REVISION

        con.execute(
            "CREATE TABLE IF NOT EXISTS alembic_version "
            "(version_num VARCHAR(32) NOT NULL)"
        )
        con.execute("DELETE FROM alembic_version")
        con.execute("INSERT INTO alembic_version (version_num) VALUES (?)", (inferred,))
        con.commit()
        logger.warning(
            "版本表与库结构不一致（alembic_version=%s），已按库结构校正为 %s；"
            "若启动后出现 no such column 报错，请下载全量安装包覆盖安装修复",
            raw_stored, inferred,
        )
    finally:
        con.close()


def _drop_leaked_tmp_tables() -> None:
    """清理 batch 迁移中断遗留的 _alembic_tmp_* 表（非事务 DDL 的半应用残留，
    不清理会让重试再次撞 already exists）。"""
    import sqlite3

    con = sqlite3.connect(str(get_settings().db_path))
    try:
        rows = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        leaked = [r[0] for r in rows if r[0].startswith("_alembic_tmp_")]
        for name in leaked:
            logger.warning("清理迁移中断遗留的临时表 %s", name)
            con.execute(f'DROP TABLE "{name}"')
        if leaked:
            con.commit()
    finally:
        con.close()


def _stamp_head() -> None:
    from alembic import command

    command.stamp(_alembic_config(), "head")


def ensure_migrated() -> None:
    """启动迁移入口：脏库自愈 → 快速路径 → alembic upgrade（含兜底）。"""
    from sqlalchemy.exc import OperationalError

    if get_settings().skip_migrate:
        return
    _repair_dirty_db()
    if _migration_up_to_date():
        return
    try:
        run_migrations()
    except OperationalError as exc:
        # 脏库的两类冲突签名：建表/建索引撞已有对象（already exists）、
        # 低锚点 stamp 撞已有列（duplicate column）
        msg = str(exc).lower()
        if "already exists" not in msg and "duplicate column" not in msg:
            raise
        logger.exception("自动迁移失败（%s），清理遗留临时表后重试", exc)
        _drop_leaked_tmp_tables()
        try:
            run_migrations()
        except OperationalError:
            # 最终兜底：标记 head 让应用可启动。若库停在半应用态，缺失的列会在
            # 运行期报 no such column——CRITICAL 级日志（带异常详情）指引重装。
            logger.critical(
                "迁移重试仍失败，stamp head 兜底启动"
                "（库结构可能不完整，建议下载全量安装包覆盖安装修复）",
                exc_info=True,
            )
            _stamp_head()
            run_migrations()


def probe_port(port: int) -> bool:
    """探测端口是否空闲（在 uvicorn bind 之前调用）。"""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _wait_port_free(port: int, timeout: float = 5.0) -> bool:
    """等待端口空闲（旧实例优雅退出的竞态窗口）；超时返回 False。"""
    import time

    deadline = time.monotonic() + timeout
    while True:
        if probe_port(port):
            return True
        if time.monotonic() >= deadline:
            return False
        logger.warning("端口 %d 被占用，等待旧实例退出…", port)
        time.sleep(0.5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_dirs()
    # 文件日志：打包态排障不再依赖隐藏控制台
    try:
        import logging.handlers
        log_file = settings.logs_dir / "server.log"
        handler = logging.handlers.RotatingFileHandler(
            str(log_file), maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        for name in ("", "uvicorn.error", "uvicorn"):
            lg = logging.getLogger(name)
            if not any(isinstance(h, logging.handlers.RotatingFileHandler) and getattr(h, "baseFilename", None) == str(log_file) for h in lg.handlers):
                lg.addHandler(handler)
    except Exception:
        pass
    # 端口占用：旧实例优雅退出的竞态窗口内等待其退出（更新切换期常见），
    # 最多 5s；仍占用则带日志失败——uvicorn 在 lifespan startup 失败时于
    # bind 之前中止，不再出现"进程无声退出、前端 30s 超时"的静默故障。
    if not _wait_port_free(settings.port):
        logger.error(
            "端口 %d 持续被占用，PaperLens Server 无法启动"
            "（请结束旧的 PaperLens 进程，或设置 PAPERLENS_PORT 换端口）",
            settings.port,
        )
        raise RuntimeError(f"port {settings.port} busy")

    init_engine(settings.db_path)
    ensure_migrated()

    app.state.ocr_manager = OCRManager(settings, db_mod.SessionLocal)
    app.state.ocr_manager.recover()
    app.state.ocr_manager.start_poll()

    llm_service.start_idle_watch()

    yield

    await app.state.ocr_manager.stop()
    await llm_service.stop()
    # 收敛连接池：SQLite WAL/-shm 随连接关闭落盘合并（优雅退出验收项）
    if db_mod.engine is not None:
        db_mod.engine.dispose()


app = FastAPI(title="PaperLens Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("未处理异常: %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={
        "status": 500, "error": "Internal Server Error", "detail": "服务器内部错误",
    })


from app.api import (  # noqa: E402
    annotations, auth, backup, cache, data_dir, dictionary, excerpts, glossary, llm, me,
    ocr, papers, projects, reading, settings as settings_api, stats, translate, words,
)

for router in (
    auth.router, me.router, projects.router, papers.router, translate.router,
    dictionary.router, glossary.router, words.router, annotations.router, ocr.router,
    reading.router, stats.router, excerpts.router, backup.router, settings_api.router,
    llm.router, cache.router, data_dir.router,
):
    app.include_router(router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/shutdown")
async def shutdown_endpoint(request: Request, x_boot_token: str = Header(default="")):
    """壳层退出时的优雅关闭入口（DESIGN-004）。

    鉴权：X-Boot-Token 必须与 sidecar 启动注入的 env 一致；仅绑 127.0.0.1。
    返回 200 后延迟置 should_exit，让响应先落、lifespan 清理段后跑。
    """
    import asyncio
    import hmac
    import os

    expected = os.environ.get("PAPERLENS_BOOT_TOKEN", "")
    if not expected or not hmac.compare_digest(x_boot_token, expected):
        raise HTTPException(status_code=403, detail="forbidden")
    server = getattr(app.state, "uvicorn_server", None)
    if server is None:
        # dev 下 uvicorn CLI 直跑无实例引用；壳层会走强杀兜底
        raise HTTPException(status_code=503, detail="server handle unavailable")

    async def _delayed_exit():
        await asyncio.sleep(0.2)
        server.should_exit = True

    asyncio.create_task(_delayed_exit())
    return {"ok": True}