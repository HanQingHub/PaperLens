from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import json

from app.core.db import get_db
from app.models import TranslateHistory, User
from app.api.deps import get_current_user, owned_paper
from app.services import translate_service

router = APIRouter(prefix="/translate", tags=["translate"])


class WordIn(BaseModel):
    paper_id: int
    word: str
    sentence: str = ""
    prev: str = ""
    next: str = ""


class SentenceIn(BaseModel):
    paper_id: int
    text: str
    prev: str = ""
    next: str = ""


@router.post("/word")
async def translate_word(body: WordIn, request: Request, user: User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    paper = owned_paper(db, user, body.paper_id)
    gen = translate_service.word_stream(db, user.id, paper, body.model_dump(), request)
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers=translate_service.sse_response_headers())


@router.post("/sentence")
async def translate_sentence(body: SentenceIn, request: Request, user: User = Depends(get_current_user),
                             db: Session = Depends(get_db)):
    paper = owned_paper(db, user, body.paper_id)
    gen = translate_service.sentence_stream(db, user.id, paper, body.model_dump(), request)
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers=translate_service.sse_response_headers())


@router.get("/history")
def translate_history(limit: int = 50, user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    rows = (
        db.query(TranslateHistory)
        .filter(TranslateHistory.user_id == user.id)
        .order_by(TranslateHistory.id.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    out = []
    for r in rows:
        try:
            result = json.loads(r.result)
        except ValueError:
            result = {"translation": r.result}
        out.append({
            "id": r.id, "word": r.word, "sentence": r.sentence, "mode": r.mode,
            "result": result, "created_at": r.created_at,
        })
    return out
