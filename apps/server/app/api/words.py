import csv
import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import now_iso
from app.models import Paper, ReviewLog, User, Word, WordOccurrence
from app.api.deps import get_current_user
from app.services import sm2_service

router = APIRouter(prefix="/words", tags=["words"])

STAGE_NAMES = {0: "陌生", 1: "学习中", 2: "已掌握"}


def word_dict(w: Word, sentence: str | None = None) -> dict:
    d = {
        "id": w.id, "lemma": w.lemma, "stage": w.stage, "translation": w.translation,
        "ease": w.ease, "interval_days": w.interval_days, "due_at": w.due_at,
        "review_count": w.review_count, "first_seen_at": w.first_seen_at,
        "last_seen_at": w.last_seen_at, "stage_name": STAGE_NAMES.get(w.stage, ""),
    }
    if sentence is not None:
        d["sentence"] = sentence
    return d


class WordIn(BaseModel):
    lemma: str
    translation: str = ""
    paper_id: int | None = None
    sentence: str = ""
    context: str = ""


class WordPatch(BaseModel):
    stage: int | None = None
    translation: str | None = None


class ReviewIn(BaseModel):
    q: int


@router.get("")
def list_words(stage: int | None = None, q: str | None = None, due: int | None = None,
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(Word).filter(Word.user_id == user.id)
    if stage is not None:
        query = query.filter(Word.stage == stage)
    if q:
        like = f"%{q.lower()}%"
        query = query.filter((Word.lemma.like(like)) | (Word.translation.like(like)))
    if due == 1:  # 到期复习队列（唯一到期查询入口）
        query = query.filter(Word.stage < 2, Word.due_at.isnot(None), Word.due_at <= now_iso())
        query = query.order_by(Word.due_at)
    else:
        query = query.order_by(Word.id.desc())
    return [word_dict(w) for w in query.all()]


@router.post("", status_code=201)
def add_word(body: WordIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lemma = body.lemma.strip().lower()
    if not lemma:
        raise HTTPException(status_code=400, detail="词条不能为空")
    if body.paper_id is not None:
        paper = db.get(Paper, body.paper_id)
        if paper is None or paper.user_id != user.id:
            raise HTTPException(status_code=404, detail="论文不存在")
    now = now_iso()
    word = db.query(Word).filter(Word.user_id == user.id, Word.lemma == lemma).first()
    if word is None:
        word = Word(user_id=user.id, lemma=lemma, stage=0, translation=body.translation or None,
                    first_seen_at=now, last_seen_at=now)
        db.add(word)
    else:
        word.last_seen_at = now
        if body.translation:
            word.translation = body.translation
    db.flush()
    if body.paper_id is not None and body.sentence:
        db.add(WordOccurrence(word_id=word.id, paper_id=body.paper_id,
                              sentence=body.sentence, context=body.context,
                              translation=body.translation, added_at=now))
    db.commit()
    db.refresh(word)
    return word_dict(word)


def _owned_word(db: Session, user: User, word_id: int) -> Word:
    w = db.get(Word, word_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(status_code=404, detail="词条不存在")
    return w


@router.patch("/{word_id}")
def patch_word(word_id: int, body: WordPatch, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    w = _owned_word(db, user, word_id)
    if body.stage is not None:
        if body.stage not in (0, 1, 2):
            raise HTTPException(status_code=400, detail="stage 取值 0|1|2")
        w.stage = body.stage
        if body.stage == 2:
            w.due_at = None
    if body.translation is not None:
        w.translation = body.translation
    db.commit()
    return word_dict(w)


@router.delete("/{word_id}", status_code=204)
def delete_word(word_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    w = _owned_word(db, user, word_id)
    db.query(WordOccurrence).filter(WordOccurrence.word_id == w.id).delete()
    db.query(ReviewLog).filter(ReviewLog.word_id == w.id).delete()
    db.delete(w)
    db.commit()
    return None


@router.post("/{word_id}/review")
def review_word(word_id: int, body: ReviewIn, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    if body.q not in (2, 3, 5):
        raise HTTPException(status_code=400, detail="q 取值 2|3|5")
    w = _owned_word(db, user, word_id)
    result = sm2_service.sm2_update(w.ease, w.interval_days, body.q)
    prev_interval = w.interval_days
    w.ease = result["ease"]
    w.interval_days = result["interval"]
    w.due_at = result["due_at"]
    w.review_count += 1
    w.last_seen_at = now_iso()
    if body.q == 2:  # 忘了：stage 降 1 级（不低于 0）
        w.stage = max(0, w.stage - 1)
    db.add(ReviewLog(user_id=user.id, word_id=w.id, reviewed_at=now_iso(), q=body.q,
                     prev_interval=prev_interval, next_interval=result["interval"]))
    db.commit()
    return {"next_due": result["due_at"], "interval": result["interval"]}


@router.get("/export")
def export_words(format: str = "csv", user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    words = db.query(Word).filter(Word.user_id == user.id).order_by(Word.lemma).all()
    occurrence = {}
    if words:
        rows = (
            db.query(WordOccurrence)
            .filter(WordOccurrence.word_id.in_([w.id for w in words]))
            .order_by(WordOccurrence.id)
            .all()
        )
        for occ in rows:
            occurrence.setdefault(occ.word_id, occ.sentence or "")
    if format == "anki":
        buf = io.StringIO()
        buf.write("#separator:tab\n#html:true\n")
        for w in words:
            fields = [w.lemma, w.translation or "", occurrence.get(w.id, "")]
            buf.write("\t".join(f.replace("\t", " ").replace("\n", " ") for f in fields) + "\n")
        data = buf.getvalue().encode("utf-8")
        return StreamingResponse(io.BytesIO(data), media_type="text/plain",
                                 headers={"Content-Disposition": 'attachment; filename="words_anki.txt"'})
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["lemma", "translation", "stage", "review_count", "due_at", "sentence"])
    for w in words:
        writer.writerow([w.lemma, w.translation or "", STAGE_NAMES.get(w.stage, ""),
                         w.review_count, w.due_at or "", occurrence.get(w.id, "")])
    data = b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")  # UTF-8 BOM，Excel 直开无乱码
    return StreamingResponse(io.BytesIO(data), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="words.csv"'})
