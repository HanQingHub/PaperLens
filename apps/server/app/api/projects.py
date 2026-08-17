from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.util import now_iso
from app.models import Paper, Project, User
from app.api.deps import get_current_user

router = APIRouter(prefix="/projects", tags=["projects"])


def project_dict(p: Project) -> dict:
    return {"id": p.id, "name": p.name, "sort_order": p.sort_order, "created_at": p.created_at}


class ProjectIn(BaseModel):
    name: str
    sort_order: int = 0


class ProjectPatch(BaseModel):
    name: str | None = None
    sort_order: int | None = None


@router.get("")
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Project).filter(Project.user_id == user.id)
        .order_by(Project.sort_order, Project.id)
        .all()
    )
    return [project_dict(p) for p in rows]


@router.post("", status_code=201)
def create_project(body: ProjectIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="项目名不能为空")
    p = Project(user_id=user.id, name=name, sort_order=body.sort_order, created_at=now_iso())
    db.add(p)
    db.commit()
    return project_dict(p)


def _owned_project(db: Session, user: User, project_id: int) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


@router.patch("/{project_id}")
def patch_project(project_id: int, body: ProjectPatch, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    p = _owned_project(db, user, project_id)
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="项目名不能为空")
        p.name = body.name.strip()
    if body.sort_order is not None:
        p.sort_order = body.sort_order
    db.commit()
    return project_dict(p)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _owned_project(db, user, project_id)
    if db.query(Paper).filter(Paper.project_id == p.id).count() > 0:
        raise HTTPException(status_code=409, detail="项目下仍有论文，无法删除")
    db.delete(p)
    db.commit()
    return None
