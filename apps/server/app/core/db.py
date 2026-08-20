import threading
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

engine = None
SessionLocal = None

# SQLite 单写队列：多语句事务（上传去重、删除级联、备份导入）在持有该锁的事务内完成
write_lock = threading.RLock()


def init_engine(db_path: Path):
    global engine, SessionLocal
    if engine is not None:
        engine.dispose()
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(engine, "connect")
    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    from app.services import llm_service as _llm_mod, tfidf_service as _tfidf_mod

    _llm_mod.llm_service.session_factory = SessionLocal
    _tfidf_mod.session_factory = SessionLocal
    return engine


def get_db():
    db = SessionLocal()
    try:
        yield db
        if db.dirty or db.new or db.deleted:
            db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
