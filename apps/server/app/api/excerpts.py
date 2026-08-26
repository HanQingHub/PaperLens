import datetime
import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import now_iso
from app.models import Excerpt, Paper, User
from app.api.deps import get_current_user

router = APIRouter(prefix="/excerpts", tags=["excerpts"])


def excerpt_dict(e: Excerpt) -> dict:
    return {
        "id": e.id, "paper_id": e.paper_id, "page_no": e.page_no, "text": e.text,
        "translation": e.translation, "note": e.note, "created_at": e.created_at,
    }


class ExcerptIn(BaseModel):
    paper_id: int
    page_no: int | None = None
    text: str
    translation: str = ""
    note: str = ""


@router.get("")
def list_excerpts(paper_id: int | None = None, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    query = db.query(Excerpt).filter(Excerpt.user_id == user.id)
    if paper_id is not None:
        query = query.filter(Excerpt.paper_id == paper_id)
    rows = query.order_by(Excerpt.id.desc()).all()
    return [excerpt_dict(e) for e in rows]


@router.post("", status_code=201)
def create_excerpt(body: ExcerptIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    paper = db.get(Paper, body.paper_id)
    if paper is None or paper.user_id != user.id:
        raise HTTPException(status_code=404, detail="论文不存在")
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="摘录内容不能为空")
    e = Excerpt(user_id=user.id, paper_id=body.paper_id, page_no=body.page_no,
                text=body.text, translation=body.translation or None,
                note=body.note or None, created_at=now_iso())
    db.add(e)
    db.commit()
    return excerpt_dict(e)


@router.delete("/{excerpt_id}", status_code=204)
def delete_excerpt(excerpt_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    e = db.get(Excerpt, excerpt_id)
    if e is None or e.user_id != user.id:
        raise HTTPException(status_code=404, detail="摘录不存在")
    db.delete(e)
    db.commit()
    return None


@router.post("/export")
def export_md(paper_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(Excerpt).filter(Excerpt.user_id == user.id)
    if paper_id is not None:
        query = query.filter(Excerpt.paper_id == paper_id)
    rows = query.order_by(Excerpt.paper_id, Excerpt.page_no).all()
    titles = {}
    for pid in {r.paper_id for r in rows}:
        p = db.get(Paper, pid)
        titles[pid] = (p.title if p else None) or f"论文 #{pid}"
    lines = ["# PaperLens 摘录", ""]
    for e in rows:
        lines.append(f"## {titles[e.paper_id]} · p.{e.page_no}")
        lines.append("")
        lines.append(f"> {e.text}")
        lines.append("")
        if e.translation:
            lines.append(f"**译文**：{e.translation}")
            lines.append("")
        if e.note:
            lines.append(f"**笔记**：{e.note}")
            lines.append("")
        lines.append("---")
        lines.append("")
    data = "\n".join(lines).encode("utf-8")
    from app.core.util import content_disposition

    name = (f"excerpts_{datetime.datetime.now().date().isoformat()}")
    return StreamingResponse(io.BytesIO(data), media_type="text/markdown",
                             headers={"Content-Disposition": content_disposition(f"{name}_摘录.md")})
