import os
from functools import lru_cache
from pathlib import Path

DEFAULT_DATA_DIR = r"D:\PaperLens"


class Settings:
    def __init__(self) -> None:
        raw = os.environ.get("PAPERLENS_DATA_DIR") or DEFAULT_DATA_DIR
        if not os.path.isdir(os.path.splitdrive(raw)[0] or "/") and raw == DEFAULT_DATA_DIR:
            raw = os.path.join(os.environ.get("LOCALAPPDATA", ""), "PaperLens")
        self.data_dir = Path(raw)
        models_env = os.environ.get("PAPERLENS_MODELS_DIR")
        self.models_dir = Path(models_env) if models_env else self.data_dir / "models"
        self.skip_migrate = os.environ.get("PAPERLENS_SKIP_MIGRATE") == "1"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "paperlens.db"

    @property
    def ecdict_path(self) -> Path:
        return self.data_dir / "ecdict.db"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def ocr_dir(self) -> Path:
        return self.data_dir / "ocr"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.models_dir, self.files_dir, self.ocr_dir, self.backups_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
