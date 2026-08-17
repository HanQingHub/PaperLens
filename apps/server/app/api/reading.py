from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import now_iso, parse_iso
from app.models import Paper, ReadingProgress, ReadingSession, User
from app.api.deps import get_current_user

router = APIRouter(tags=["reading"])


def _owned_paper(db: Session, user: User, paper_id: int) -> Paper:
    p = db.get(Paper, paper_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="论文不存在")
    return p


class ProgressIn(BaseModel):
    page_no: int = 1
    scroll_y: float = 0.0
    open: bool = False


@router.get("/reading-progress/{paper_id}")
def get_progress(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_paper(db, user, paper_id)
    row = db.get(ReadingProgress, paper_id)
    if row is None:
        return {"paper_id": paper_id, "page_no": 1, "scroll_y": 0.0, "updated_at": None}
    return {"paper_id": row.paper_id, "page_no": row.page_no, "scroll_y": row.scroll_y, "updated_at": row.updated_at}


@router.put("/reading-progress/{paper_id}")
def put_progress(paper_id: int, body: ProgressIn, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    paper = _owned_paper(db, user, paper_id)
    row = db.get(ReadingProgress, paper_id)
    if row is None:
        row = ReadingProgress(paper_id=paper_id, user_id=user.id)
        db.add(row)
    row.page_no = body.page_no
    row.scroll_y = body.scroll_y
    row.updated_at = now_iso()
    if body.open:
        paper.open_count += 1
        paper.last_opened_at = now_iso()
    db.commit()
    return {"paper_id": row.paper_id, "page_no": row.page_no, "scroll_y": row.scroll_y, "updated_at": row.updated_at}


class SessionIn(BaseModel):
    paper_id: int
    start_at: str
    end_at: str


@router.post("/reading-sessions", status_code=201)
def create_session(body: SessionIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_paper(db, user, body.paper_id)
    try:
        start = parse_iso(body.start_at)
        end = parse_iso(body.end_at)
    except ValueError:
        raise HTTPException(status_code=400, detail="时间格式需为 ISO8601")
    duration = max(0, int((end - start).total_seconds()))
    row = ReadingSession(user_id=user.id, paper_id=body.paper_id,
                         start_at=body.start_at, end_at=body.end_at, duration_s=duration)
    db.add(row)
    db.commit()
    return {"id": row.id, "duration_s": row.duration_s}
