from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import Paper, User
from app.api.deps import get_current_user
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


def _owned_paper(db: Session, user: User, paper_id: int) -> Paper:
    p = db.get(Paper, paper_id)
    if p is None or p.user_id != user.id:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="论文不存在")
    return p


@router.post("/word")
async def translate_word(body: WordIn, request: Request, user: User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    paper = _owned_paper(db, user, body.paper_id)
    gen = translate_service.word_stream(db, user.id, paper, body.model_dump(), request)
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers=translate_service.sse_response_headers())


@router.post("/sentence")
async def translate_sentence(body: SentenceIn, request: Request, user: User = Depends(get_current_user),
                             db: Session = Depends(get_db)):
    paper = _owned_paper(db, user, body.paper_id)
    gen = translate_service.sentence_stream(db, user.id, paper, body.model_dump(), request)
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers=translate_service.sse_response_headers())
