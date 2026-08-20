import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.util import ensure_within, now_iso
from app.models import Annotation, User
from app.api.deps import get_current_user, owned_paper
from app.services import pdf_writeback

router = APIRouter(tags=["annotations"])


def annotation_dict(a: Annotation) -> dict:
    return {
        "id": a.id, "paper_id": a.paper_id, "page_no": a.page_no, "type": a.type,
        "anchor_json": a.anchor_json, "card_json": a.card_json, "color": a.color,
        "text": a.text, "created_at": a.created_at, "updated_at": a.updated_at,
    }


class AnnotationIn(BaseModel):
    page_no: int
    type: str
    anchor_json: str
    card_json: str | None = None
    color: str | None = None
    text: str | None = None


class AnnotationPatch(BaseModel):
    card_json: str | None = None
    color: str | None = None
    text: str | None = None
    page_no: int | None = None


@router.get("/papers/{paper_id}/annotations")
def list_annotations(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    owned_paper(db, user, paper_id)
    rows = (
        db.query(Annotation)
        .filter(Annotation.paper_id == paper_id)
        .order_by(Annotation.page_no, Annotation.id)
        .all()
    )
    return [annotation_dict(a) for a in rows]


@router.post("/papers/{paper_id}/annotations", status_code=201)
def create_annotation(paper_id: int, body: AnnotationIn, user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    owned_paper(db, user, paper_id)
    if body.type not in ("word_note", "sentence"):
        raise HTTPException(status_code=400, detail="type 取值 word_note|sentence")
    try:
        json.loads(body.anchor_json)
    except ValueError:
        raise HTTPException(status_code=400, detail="anchor_json 不是合法 JSON")
    now = now_iso()
    a = Annotation(user_id=user.id, paper_id=paper_id, page_no=body.page_no, type=body.type,
                   anchor_json=body.anchor_json, card_json=body.card_json, color=body.color,
                   text=body.text, created_at=now, updated_at=now)
    db.add(a)
    db.commit()
    return annotation_dict(a)


def _owned_annotation(db: Session, user: User, annotation_id: int) -> Annotation:
    a = db.get(Annotation, annotation_id)
    if a is None or a.user_id != user.id:
        raise HTTPException(status_code=404, detail="批注不存在")
    return a


@router.patch("/annotations/{annotation_id}")
def patch_annotation(annotation_id: int, body: AnnotationPatch, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    a = _owned_annotation(db, user, annotation_id)
    data = body.model_dump(exclude_unset=True)
    if "card_json" in data:
        a.card_json = data["card_json"]
    if "color" in data:
        a.color = data["color"]
    if "text" in data:
        a.text = data["text"]
    if "page_no" in data and data["page_no"] is not None:
        a.page_no = data["page_no"]
    a.updated_at = now_iso()
    db.commit()
    return annotation_dict(a)


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _owned_annotation(db, user, annotation_id)
    db.delete(a)
    db.commit()
    return None


@router.post("/papers/{paper_id}/export-annotations-pdf")
def export_pdf(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    paper = owned_paper(db, user, paper_id)
    rows = db.query(Annotation).filter(Annotation.paper_id == paper_id).order_by(Annotation.page_no).all()
    settings = get_settings()
    src = ensure_within(settings.files_dir, settings.files_dir / f"{paper.file_hash}.pdf")
    if not src.exists():
        raise HTTPException(status_code=404, detail="PDF 文件不存在")
    data = pdf_writeback.writeback(src, [
        {"page_no": a.page_no, "anchor_json": a.anchor_json, "color": a.color, "text": a.text}
        for a in rows
    ])
    import io

    from app.core.util import content_disposition

    name = (paper.title or f"paper_{paper_id}").replace("/", "_")
    return StreamingResponse(io.BytesIO(data), media_type="application/pdf",
                             headers={"Content-Disposition": content_disposition(f"{name}_批注版.pdf")})


@router.post("/papers/{paper_id}/export-annotations-md")
def export_md(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    paper = owned_paper(db, user, paper_id)
    rows = db.query(Annotation).filter(Annotation.paper_id == paper_id).order_by(Annotation.page_no).all()
    lines = [f"# {paper.title or '论文'} 批注", ""]
    for a in rows:
        try:
            anchor = json.loads(a.anchor_json)
            excerpt = (anchor.get("text") or "").strip()
        except ValueError:
            excerpt = ""
        lines.append(f"## p.{a.page_no} {'笔记' if a.type == 'word_note' else '高亮'}")
        lines.append("")
        if excerpt:
            lines.append(f"> {excerpt}")
            lines.append("")
        if a.text:
            lines.append(a.text)
            lines.append("")
    import io

    from app.core.util import content_disposition

    data = "\n".join(lines).encode("utf-8")
    name = (paper.title or f"paper_{paper_id}").replace("/", "_")
    return StreamingResponse(io.BytesIO(data), media_type="text/markdown",
                             headers={"Content-Disposition": content_disposition(f"{name}_批注.md")})
