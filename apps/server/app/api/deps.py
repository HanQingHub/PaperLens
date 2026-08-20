from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import now_iso, parse_iso
from app.models import Paper
from app.models import Session as DbSession
from app.models import User

_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="未登录")
    session = db.get(DbSession, creds.credentials)
    if session is None:
        raise HTTPException(status_code=401, detail="会话无效")
    try:
        expired = parse_iso(session.expires_at) < parse_iso(now_iso())
    except ValueError:
        expired = True
    if expired:
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=401, detail="会话已过期")
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def owned_paper(db: Session, user: User, paper_id: int) -> Paper:
    p = db.get(Paper, paper_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="论文不存在")
    return p


def get_owned_paper(
    paper_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Paper:
    return owned_paper(db, user, paper_id)
