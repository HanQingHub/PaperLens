import shutil
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core import db as db_mod
from app.core.config import get_settings
from app.core.db import get_db, write_lock
from app.models import User
from app.api.deps import get_current_user
from app.services import backup_service

router = APIRouter(prefix="/backup", tags=["backup"])


@router.post("/export")
def export(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings = get_settings()
    path = backup_service.export_zip(db, user, settings.backups_dir)
    return FileResponse(path, media_type="application/zip",
                        filename=path.name)


@router.post("/import")
def import_backup(zip_file: UploadFile, user: User = Depends(get_current_user)):
    settings = get_settings()
    settings.ensure_dirs()
    if not zip_file.filename or not zip_file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持 zip 备份文件")
    tmp = settings.backups_dir / f".import-{uuid.uuid4().hex}.zip"
    try:
        with open(tmp, "wb") as out:
            shutil.copyfileobj(zip_file.file, out)
        with write_lock:
            report = backup_service.import_zip(tmp, settings.data_dir, db_mod.SessionLocal)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"备份导入失败：{e}")
    finally:
        tmp.unlink(missing_ok=True)
    return {"report": report}
