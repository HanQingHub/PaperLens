import logging
import sys
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


def run_migrations() -> None:
    """Alembic 管理 DDL；应用启动自动 upgrade head。"""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    server_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    command.upgrade(cfg, "head")


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
    init_engine(settings.db_path)
    if not settings.skip_migrate:
        run_migrations()

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


_settings = get_settings()
if not _settings.skip_migrate and not probe_port(_settings.port):
    logger.error("端口 %d 已被占用，PaperLens Server 无法启动（可设置 PAPERLENS_PORT 换端口）", _settings.port)
    sys.exit(1)