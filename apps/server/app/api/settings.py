from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import dump_setting, parse_setting
from app.models import AppSetting, User
from app.api.deps import get_current_user

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def get_settings_api(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(AppSetting).filter(AppSetting.user_id == user.id).all()
    return {row.key: parse_setting(row.value) for row in rows}


@router.put("")
def put_settings(body: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    for key, value in body.items():
        if not isinstance(key, str) or len(key) > 100:
            continue
        row = (
            db.query(AppSetting)
            .filter(AppSetting.user_id == user.id, AppSetting.key == key)
            .first()
        )
        if row is None:
            db.add(AppSetting(user_id=user.id, key=key, value=dump_setting(value) if value is not None else None))
        else:
            row.value = dump_setting(value) if value is not None else None
    db.commit()
    return get_settings_api(user, db)
