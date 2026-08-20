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
        assert version == "e7a2c94f1b38"
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
        assert version == "e7a2c94f1b38"
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