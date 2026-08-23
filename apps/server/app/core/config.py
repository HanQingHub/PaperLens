import os
from functools import lru_cache
from pathlib import Path

DEFAULT_DATA_DIR = r"D:\PaperLens"
DEFAULT_PORT = 8737
DEFAULT_BCRYPT_COST = 12
DEFAULT_FILE_TOKEN_TTL = 300
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
]


class Settings:
    def __init__(self) -> None:
        raw = os.environ.get("PAPERLENS_DATA_DIR")
        if not raw:
            if not os.path.isdir(os.path.splitdrive(DEFAULT_DATA_DIR)[0] or "/"):
                raw = os.path.join(os.environ.get("LOCALAPPDATA", ""), "PaperLens")
            else:
                raw = DEFAULT_DATA_DIR
        self.data_dir = Path(raw)
        # 模型写目录固定为数据目录 models/；PAPERLENS_MODELS_DIR 仅作内置只读模型目录（随安装包分发）
        self.models_dir = self.data_dir / "models"
        models_env = os.environ.get("PAPERLENS_MODELS_DIR")
        self.bundled_models_dir = Path(models_env) if models_env else None
        ecdict_env = os.environ.get("PAPERLENS_ECDICT_PATH")
        self.bundled_ecdict_path = Path(ecdict_env) if ecdict_env else None
        self.skip_migrate = os.environ.get("PAPERLENS_SKIP_MIGRATE") == "1"
        self.port = int(os.environ.get("PAPERLENS_PORT", str(DEFAULT_PORT)))
        self.bcrypt_cost = int(os.environ.get("PAPERLENS_BCRYPT_COST", str(DEFAULT_BCRYPT_COST)))
        self.file_token_ttl = int(os.environ.get("PAPERLENS_FILE_TOKEN_TTL", str(DEFAULT_FILE_TOKEN_TTL)))
        raw_origins = os.environ.get("PAPERLENS_CORS_ORIGINS")
        self.cors_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] if raw_origins else CORS_ORIGINS

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

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.models_dir, self.files_dir, self.ocr_dir, self.backups_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()