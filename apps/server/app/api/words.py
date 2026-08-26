import csv
import io
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import like_escape, now_iso
from app.models import Paper, ReviewLog, TranslationCache, User, Word, WordOccurrence
from app.api.deps import get_current_user
from app.services import ecdict_service, sm2_service

router = APIRouter(prefix="/words", tags=["words"])

STAGE_NAMES = {0: "陌生", 1: "学习中", 2: "已掌握"}


def word_dict(w: Word, sentence: str | None = None) -> dict:
    d = {
        "id": w.id, "lemma": w.lemma, "stage": w.stage, "translation": w.translation,
        "group_name": w.group_name,
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
    group_name: str | None = None


class WordPatch(BaseModel):
    stage: int | None = None
    translation: str | None = None
    group_name: str | None = None  # 空串 = 移出分组；None = 不改动


class ReviewIn(BaseModel):
    q: int


@router.get("/groups")
def list_groups(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """生词分组名列表（非空组名，按成员数降序）。"""
    rows = (
        db.query(Word.group_name, func.count(Word.id).label("c"))
        .filter(Word.user_id == user.id, Word.group_name.isnot(None), Word.group_name != "")
        .group_by(Word.group_name)
        .order_by(func.count(Word.id).desc())
        .all()
    )
    return [{"name": name, "count": c} for name, c in rows]


@router.get("")
def list_words(stage: int | None = None, q: str | None = None, due: int | None = None,
               group: str | None = None, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    query = db.query(Word).filter(Word.user_id == user.id)
    if stage is not None:
        query = query.filter(Word.stage == stage)
    if q:
        like = f"%{like_escape(q.lower())}%"
        query = query.filter((Word.lemma.like(like, escape="\\")) | (Word.translation.like(like, escape="\\")))
    if group is not None:
        if group == "":
            query = query.filter(Word.group_name.is_(None) | (Word.group_name == ""))
        else:
            query = query.filter(Word.group_name == group)
    if due == 1:  # 到期复习队列（唯一到期查询入口）
        query = query.filter(Word.stage < 2, Word.due_at.isnot(None), Word.due_at <= now_iso())
        query = query.order_by(Word.due_at)
    else:
        query = query.order_by(Word.id.desc())
    return [word_dict(w) for w in query.all()]


def _auto_translation(db: Session, user_id: int, lemma: str) -> str | None:
    """入库释义自动补齐：LLM 翻译缓存（跨论文取最新）优先，其次 ECDICT 词典。
    都没有则返回 None（宁缺勿错）。"""
    cached = (
        db.query(TranslationCache)
        .filter(TranslationCache.user_id == user_id, TranslationCache.lemma == lemma)
        .order_by(TranslationCache.id.desc())
        .first()
    )
    if cached:
        try:
            data = json.loads(cached.result_json)
            text = (data.get("translation") or "").strip()
            if text:
                return text
        except ValueError:
            pass
    if " " not in lemma:  # 短语跳过词典（与 translate_service 的 is_phrase 规则一致）
        entry = ecdict_service.lookup(lemma)
        if entry and entry.get("translation"):
            return " ".join(str(entry["translation"]).split())
    return None


@router.post("", status_code=201)
def add_word(body: WordIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lemma = body.lemma.strip().lower()
    if not lemma:
        raise HTTPException(status_code=400, detail="词条不能为空")
    if body.paper_id is not None:
        paper = db.get(Paper, body.paper_id)
        if paper is None or paper.user_id != user.id:
            raise HTTPException(status_code=404, detail="论文不存在")
    translation = body.translation.strip() or _auto_translation(db, user.id, lemma) or None
    group = (body.group_name or "").strip() or None if body.group_name is not None else None
    now = now_iso()
    word = db.query(Word).filter(Word.user_id == user.id, Word.lemma == lemma).first()
    if word is None:
        word = Word(user_id=user.id, lemma=lemma, stage=0, translation=translation,
                    group_name=group, first_seen_at=now, last_seen_at=now)
        db.add(word)
    else:
        word.last_seen_at = now
        if translation:
            word.translation = translation
        if body.group_name is not None:
            word.group_name = group
    db.flush()
    if body.paper_id is not None and body.sentence:
        db.add(WordOccurrence(word_id=word.id, paper_id=body.paper_id,
                              sentence=body.sentence, context=body.context,
                              translation=translation, added_at=now))
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
    if body.group_name is not None:
        name = body.group_name.strip()
        w.group_name = name or None  # 空串 = 移出分组
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
    db.refresh(w)
    # word 字段供前端回写词库 stageMap（正文高亮即时反映复习结果）
    return {"next_due": result["due_at"], "interval": result["interval"], "word": word_dict(w)}


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
