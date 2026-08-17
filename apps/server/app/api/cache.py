import shutil

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.models import OcrDoc, Paper, TranslationCache, User
from app.api.deps import get_current_user

router = APIRouter(prefix="/cache", tags=["cache"])


@router.delete("/{cache_type}")
def clear_cache(cache_type: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings = get_settings()
    if cache_type == "translate":
        n = db.query(TranslationCache).filter(TranslationCache.user_id == user.id).delete()
        db.commit()
        return {"freed_bytes": 0, "rows_deleted": n}
    if cache_type == "ocr":
        papers = db.query(Paper).filter(Paper.user_id == user.id).all()
        freed = 0
        for paper in papers:
            d = settings.ocr_dir / str(paper.id)
            if d.exists():
                for f in d.iterdir():
                    if f.is_file():
                        freed += f.stat().st_size
                shutil.rmtree(d, ignore_errors=True)
            paper.ocr_status = "none"
            doc = db.get(OcrDoc, paper.id)
            if doc is not None:
                db.delete(doc)
        db.commit()
        return {"freed_bytes": freed}
    raise HTTPException(status_code=400, detail="type 取值 ocr|translate")
