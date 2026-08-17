from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import hash_password, new_token, verify_password
from app.core.util import now_iso
from app.models import Session as DbSession
from app.models import User
from app.api.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)


class RegisterIn(BaseModel):
    username: str
    password: str


class LoginIn(BaseModel):
    username: str
    password: str
    remember: bool = False


def user_dict(user: User) -> dict:
    return {"id": user.id, "username": user.username, "display_name": user.display_name, "created_at": user.created_at}


def _create_session(db: Session, user_id: int, days: int) -> str:
    token = new_token()
    expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="microseconds")
    db.add(DbSession(token=token, user_id=user_id, expires_at=expires_at, created_at=now_iso()))
    return token


@router.post("/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    username = body.username.strip()
    if not username or len(username) > 50:
        raise HTTPException(status_code=400, detail="用户名长度需在 1-50 之间")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    if db.query(User).filter(User.username == username).first() is not None:
        raise HTTPException(status_code=409, detail="用户名已存在")
    user = User(username=username, password_hash=hash_password(body.password),
                display_name=username, created_at=now_iso())
    db.add(user)
    db.flush()
    token = _create_session(db, user.id, days=1)
    db.commit()
    return {"token": token, "user": user_dict(user)}


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username.strip()).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = _create_session(db, user.id, days=30 if body.remember else 1)
    db.commit()
    return {"token": token, "user": user_dict(user)}


@router.post("/logout", status_code=204)
def logout(creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
           db: Session = Depends(get_db)):
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="未登录")
    session = db.get(DbSession, creds.credentials)
    if session is not None:
        db.delete(session)
        db.commit()
    return None
