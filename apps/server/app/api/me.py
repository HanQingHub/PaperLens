from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import parse_setting
from app.models import AppSetting, User
from app.api.auth import user_dict
from app.api.deps import get_current_user

router = APIRouter(tags=["me"])


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings = {row.key: parse_setting(row.value) for row in db.query(AppSetting).filter(AppSetting.user_id == user.id).all()}
    return {"user": user_dict(user), "settings": settings}
