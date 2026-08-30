def test_migrations_apply_all_and_create_indexes(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(data))
    monkeypatch.delenv("PAPERLENS_SKIP_MIGRATE", raising=False)
    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.main import run_migrations

    run_migrations()

    import sqlite3

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"users", "sessions", "projects", "papers", "review_logs",
                "glossary_terms", "alembic_version"}.issubset(tables)
        indexes = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"ix_papers_user_id", "ix_projects_user_id", "ix_review_logs_word_id"}.issubset(indexes)
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
    finally:
        con.close()


def test_migrations_idempotent(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(data))
    monkeypatch.delenv("PAPERLENS_SKIP_MIGRATE", raising=False)
    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.main import run_migrations

    run_migrations()
    run_migrations()  # 二次执行不报错

    import sqlite3

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
    finally:
        con.close()


def test_migration_sort_order_backfill(tmp_path, monkeypatch):
    """存量库升级：sort_order 按组内 (created_at desc, id desc) 回填 0..n-1；downgrade 删列。"""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(data))
    monkeypatch.delenv("PAPERLENS_SKIP_MIGRATE", raising=False)
    from app.core.config import get_settings

    get_settings.cache_clear()

    server_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))

    # 先停在上一版，造存量数据
    command.upgrade(cfg, "3f9e1c2a7d54")

    import sqlite3

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        con.execute("INSERT INTO users (id, username, password_hash, created_at)"
                    " VALUES (1, 'u1', 'x', '2026-01-01T00:00:00')")
        con.execute("INSERT INTO projects (id, user_id, name, sort_order, created_at)"
                    " VALUES (1, 1, 'P1', 0, '2026-01-01T00:00:00')")
        papers = [
            # (id, project_id, created_at) — 组内语义顺序为 (created desc, id desc)
            (1, 1, "2026-01-01T00:00:00"),   # A：项目组最旧 → 期望 2
            (2, 1, "2026-01-02T00:00:00"),   # B：同刻但 id 较小 → 期望 1
            (3, 1, "2026-01-02T00:00:00"),   # C：同刻 id 较大 → 期望 0
            (4, None, "2026-01-03T00:00:00"),  # D：未分组最新 → 期望 0
            (5, None, "2026-01-01T00:00:00"),  # E：未分组最旧 → 期望 1
        ]
        for pid, proj, created in papers:
            con.execute(
                "INSERT INTO papers (id, user_id, project_id, title, file_hash, open_count,"
                " is_scanned, ocr_status, tags, is_favorite, created_at)"
                " VALUES (?, 1, ?, 't', 'h'||?, 0, 0, 'none', '[]', 0, ?)",
                (pid, proj, pid, created),
            )
        con.commit()
    finally:
        con.close()

    # 升级到 head → 回填断言
    command.upgrade(cfg, "head")

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        expected = {1: 2, 2: 1, 3: 0, 4: 0, 5: 1}
        rows = dict(con.execute("SELECT id, sort_order FROM papers").fetchall())
        assert rows == expected
    finally:
        con.close()

    # 降级回上一版 → 列已删除
    command.downgrade(cfg, "3f9e1c2a7d54")

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(papers)").fetchall()}
        assert "sort_order" not in cols
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "3f9e1c2a7d54"
    finally:
        con.close()


# ---- 脏库自愈（ensure_migrated 生产同路径）----
import sqlite3


def _dirty_db_env(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(data))
    monkeypatch.delenv("PAPERLENS_SKIP_MIGRATE", raising=False)
    from app.core.config import get_settings

    get_settings.cache_clear()
    return data


def _alembic_cfg():
    from pathlib import Path

    from alembic.config import Config

    server_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    return cfg


def test_dirty_db_create_all_repairs(tmp_path, monkeypatch):
    """create_all 直建的无版本表库（手工拷贝/开发残留形态）→ 自动校正到 head。"""
    data = _dirty_db_env(tmp_path, monkeypatch)
    from app.core import db as db_mod
    from app.models import Base

    db_mod.init_engine(data / "paperlens.db")
    Base.metadata.create_all(db_mod.engine)
    db_mod.engine.dispose()

    from app.main import ensure_migrated

    ensure_migrated()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
    finally:
        con.close()


def test_dirty_db_stale_stamp_repairs(tmp_path, monkeypatch):
    """半写入的失真版本表（schema 已最新、stamp 停在 bd14）→ 按 schema 校正。"""
    data = _dirty_db_env(tmp_path, monkeypatch)
    from app.core import db as db_mod
    from app.models import Base

    db_mod.init_engine(data / "paperlens.db")
    Base.metadata.create_all(db_mod.engine)
    db_mod.engine.dispose()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        con.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        con.execute("INSERT INTO alembic_version VALUES ('bd14f5e2e468')")
        con.commit()
    finally:
        con.close()

    from app.main import ensure_migrated

    ensure_migrated()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
    finally:
        con.close()


def test_dirty_db_keeps_data_b5d2_to_head(tmp_path, monkeypatch):
    """v0.5.0 形态脏库（b5d2 schema、无版本表）→ 补跑 c3d4/d4e/e8a 且数据保留。"""
    from alembic import command

    data = _dirty_db_env(tmp_path, monkeypatch)
    cfg = _alembic_cfg()
    command.upgrade(cfg, "b5d2e8f41a76")

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        con.execute("INSERT INTO users (id, username, password_hash, created_at)"
                    " VALUES (1, 'u1', 'x', '2026-01-01T00:00:00')")
        con.execute(
            "INSERT INTO papers (id, user_id, project_id, title, file_hash, open_count,"
            " is_scanned, ocr_status, tags, is_favorite, sort_order, arxiv_id, created_at)"
            " VALUES (1, 1, NULL, '保留题名', 'h1', 3, 0, 'none', '[]', 1, 0, '2401.00001',"
            " '2026-01-02T00:00:00')")
        con.execute(
            "INSERT INTO words (id, user_id, lemma, stage, ease, interval_days,"
            " review_count) VALUES (1, 1, 'quantum', 0, 2.5, 0.0, 0)")
        # 模拟脏库：版本表整个缺失
        con.execute("DROP TABLE alembic_version")
        con.commit()
    finally:
        con.close()

    from app.main import ensure_migrated

    ensure_migrated()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
        # 原数据保留 + e8a 的 file_type 按默认值回填
        row = con.execute("SELECT title, open_count, file_type, arxiv_id FROM papers").fetchone()
        assert row == ("保留题名", 3, "pdf", "2401.00001")
        # c3d4 的 group_name 可空
        assert con.execute("SELECT group_name FROM words").fetchone() == (None,)
    finally:
        con.close()


def test_dirty_db_leaked_tmp_table_repairs(tmp_path, monkeypatch):
    """batch 迁移中断遗留 _alembic_tmp_* 表：不阻断升级，且可显式清理。

    alembic 1.12+ 对纯 add_column 的 batch 走原生 ALTER（recreate="auto"），
    不会触碰同名遗留表；重建型 batch（未来 drop/alter column）才会撞
    already exists 并走 ensure_migrated 的清理重试兜底。
    """
    from alembic import command

    data = _dirty_db_env(tmp_path, monkeypatch)
    cfg = _alembic_cfg()
    command.upgrade(cfg, "d4e5f6a7b8c9d0")

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        con.execute("DROP TABLE alembic_version")
        con.execute("CREATE TABLE _alembic_tmp_papers (id INTEGER)")
        con.commit()
    finally:
        con.close()

    from app.main import _drop_leaked_tmp_tables, ensure_migrated

    ensure_migrated()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
        cols = {r[1] for r in con.execute("PRAGMA table_info(papers)").fetchall()}
        assert {"file_type", "orig_filename"}.issubset(cols)
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # 当前迁移链无重建型 batch，遗留表原样保留、不构成阻断
        assert "_alembic_tmp_papers" in tables
    finally:
        con.close()

    # 清理兜底：只删 _alembic_tmp_* 前缀，不动业务表
    _drop_leaked_tmp_tables()
    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "_alembic_tmp_papers" not in tables
        assert "papers" in tables
    finally:
        con.close()


def test_ensure_migrated_retry_on_already_exists(tmp_path, monkeypatch):
    """except 分支（无法用真实迁移自然触发，monkeypatch 模拟）：
    首跑撞 already exists → 清理遗留临时表 → 重试成功。"""
    data = _dirty_db_env(tmp_path, monkeypatch)
    from app.core import db as db_mod
    from app.models import Base

    db_mod.init_engine(data / "paperlens.db")
    Base.metadata.create_all(db_mod.engine)
    db_mod.engine.dispose()

    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        con.execute("CREATE TABLE _alembic_tmp_papers (id INTEGER)")
        con.commit()
    finally:
        con.close()

    import app.main as main_mod
    from sqlalchemy.exc import OperationalError

    calls = {"n": 0}
    real_run = main_mod.run_migrations

    def flaky_run():
        calls["n"] += 1
        if calls["n"] == 1:
            raise OperationalError(
                "INSERT", {}, Exception("table file_refs already exists"))
        real_run()

    monkeypatch.setattr(main_mod, "run_migrations", flaky_run)
    monkeypatch.setattr(main_mod, "_migration_up_to_date", lambda: False)

    main_mod.ensure_migrated()

    assert calls["n"] == 2  # 首跑失败 + 重试成功
    con = sqlite3.connect(str(data / "paperlens.db"))
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "_alembic_tmp_papers" not in tables
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert version == "e8a1f2c3b4d5"
    finally:
        con.close()


def test_ensure_migrated_reraises_other_errors(tmp_path, monkeypatch):
    """非脏库签名（如 database is locked）原样冒泡，不进 stamp 兜底。"""
    _dirty_db_env(tmp_path, monkeypatch)
    import app.main as main_mod
    from sqlalchemy.exc import OperationalError

    def locked():
        raise OperationalError("INSERT", {}, Exception("database is locked"))

    monkeypatch.setattr(main_mod, "run_migrations", locked)
    monkeypatch.setattr(main_mod, "_migration_up_to_date", lambda: False)
    stamp_calls = []
    monkeypatch.setattr(main_mod, "_stamp_head", lambda: stamp_calls.append(1))

    import pytest

    with pytest.raises(OperationalError):
        main_mod.ensure_migrated()
    assert stamp_calls == []