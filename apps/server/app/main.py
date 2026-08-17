from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.db import init_engine
from app.services.llm_service import llm_service
from app.services.ocr_manager import OCRManager

CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
]


def run_migrations() -> None:
    """Alembic 管理 DDL；应用启动自动 upgrade head。"""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    server_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    command.upgrade(cfg, "head")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_dirs()
    init_engine(settings.db_path)
    if not settings.skip_migrate:
        run_migrations()

    app.state.ocr_manager = OCRManager(settings)
    app.state.ocr_manager.recover()
    app.state.ocr_manager.start_poll()

    llm_service.start_idle_watch()

    yield

    await app.state.ocr_manager.stop()
    await llm_service.stop()


app = FastAPI(title="PaperLens Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.api import (  # noqa: E402
    annotations, auth, backup, cache, dictionary, excerpts, glossary, llm, me,
    ocr, papers, projects, reading, settings as settings_api, stats, translate, words,
)

for router in (
    auth.router, me.router, projects.router, papers.router, translate.router,
    dictionary.router, glossary.router, words.router, annotations.router, ocr.router,
    reading.router, stats.router, excerpts.router, backup.router, settings_api.router,
    llm.router, cache.router,
):
    app.include_router(router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}
