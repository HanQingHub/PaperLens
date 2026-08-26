from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import User
from app.api.deps import get_current_user
from app.services import ecdict_service, translate_service

router = APIRouter(prefix="/dictionary", tags=["dictionary"])


@router.get("/{word}")
def lookup(word: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = ecdict_service.lookup(word)
    if entry is None or not entry.get("translation"):
        raise HTTPException(status_code=404, detail="词典未收录该词")
    translate_service.save_history(
        db, user.id, word=word.strip().lower(), mode="dict",
        result={"gloss": entry.get("translation"), "phonetic": entry.get("phonetic")},
    )
    return entry
