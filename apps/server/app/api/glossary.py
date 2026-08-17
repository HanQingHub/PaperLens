from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import GlossaryTerm, Paper, User
from app.api.deps import get_current_user

router = APIRouter(tags=["glossary"])


def _owned_paper(db: Session, user: User, paper_id: int) -> Paper:
    p = db.get(Paper, paper_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="论文不存在")
    return p


@router.get("/papers/{paper_id}/glossary")
def list_glossary(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_paper(db, user, paper_id)
    rows = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == paper_id)
        .order_by(GlossaryTerm.confidence.desc())
        .all()
    )
    return [
        {"id": r.id, "term": r.term, "domain_translation": r.domain_translation,
         "confidence": r.confidence, "source": r.source}
        for r in rows
    ]


class TermIn(BaseModel):
    paper_id: int
    term: str
    domain_translation: str


@router.post("/glossary/terms", status_code=201)
def upsert_term(body: TermIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_paper(db, user, body.paper_id)
    term = body.term.strip()
    if not term:
        raise HTTPException(status_code=400, detail="术语不能为空")
    row = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == body.paper_id, GlossaryTerm.term == term)
        .first()
    )
    if row is None:
        row = GlossaryTerm(user_id=user.id, paper_id=body.paper_id, term=term,
                           source="user", confidence=1.0)
        db.add(row)
    else:  # 用户修正覆盖同 term 的 tfidf 行
        row.source = "user"
        row.confidence = 1.0
    row.domain_translation = body.domain_translation
    db.commit()
    return {"id": row.id, "term": row.term, "domain_translation": row.domain_translation, "source": row.source}


@router.delete("/glossary/terms/{term_id}", status_code=204)
def delete_term(term_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(GlossaryTerm, term_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="术语不存在")
    db.delete(row)
    db.commit()
    return None
