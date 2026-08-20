from pathlib import Path

from app.core.config import CORS_ORIGINS, DEFAULT_BCRYPT_COST, DEFAULT_FILE_TOKEN_TTL, DEFAULT_PORT, Settings


def test_settings_env_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPERLENS_PORT", "9999")
    monkeypatch.setenv("PAPERLENS_BCRYPT_COST", "10")
    monkeypatch.setenv("PAPERLENS_FILE_TOKEN_TTL", "60")
    monkeypatch.setenv("PAPERLENS_CORS_ORIGINS", "http://a, http://b,,")
    monkeypatch.setenv("PAPERLENS_SKIP_MIGRATE", "1")
    s = Settings()
    assert s.data_dir == Path(str(tmp_path))
    assert s.port == 9999
    assert s.bcrypt_cost == 10
    assert s.file_token_ttl == 60
    assert s.cors_origins == ["http://a", "http://b"]
    assert s.skip_migrate is True


def test_settings_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(tmp_path))
    for k in ("PAPERLENS_PORT", "PAPERLENS_BCRYPT_COST", "PAPERLENS_FILE_TOKEN_TTL",
              "PAPERLENS_CORS_ORIGINS", "PAPERLENS_SKIP_MIGRATE"):
        monkeypatch.delenv(k, raising=False)
    s = Settings()
    assert s.port == DEFAULT_PORT
    assert s.bcrypt_cost == DEFAULT_BCRYPT_COST
    assert s.file_token_ttl == DEFAULT_FILE_TOKEN_TTL
    assert s.cors_origins == CORS_ORIGINS
    assert s.skip_migrate is False
    assert s.ocr_dir == tmp_path / "ocr"