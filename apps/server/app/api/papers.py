import asyncio
import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db, write_lock
from app.core.util import ensure_within, now_iso
from app.models import (
    Annotation, AppSetting, Excerpt, FileRef, GlossaryTerm, OcrDoc, Paper,
    Project, ReadingProgress, ReadingSession, TranslationCache, User, WordOccurrence,
)
from app.api.deps import get_current_user, get_owned_paper
from app.services import file_tokens, tfidf_service

router = APIRouter(prefix="/papers", tags=["papers"])


def paper_dict(p: Paper) -> dict:
    return {
        "id": p.id, "user_id": p.user_id, "project_id": p.project_id, "title": p.title,
        "authors": p.authors, "venue": p.venue, "year": p.year, "doi": p.doi,
        "file_hash": p.file_hash, "page_count": p.page_count, "open_count": p.open_count,
        "is_scanned": bool(p.is_scanned), "ocr_status": p.ocr_status,
        "tags": json.loads(p.tags) if p.tags else [],
        "note": p.note, "is_favorite": bool(p.is_favorite),
        "sort_order": p.sort_order,
        "created_at": p.created_at, "last_opened_at": p.last_opened_at,
    }


def extract_pdf_meta(path: Path) -> tuple[int, str | None, str | None]:
    """返回 (页数, 标题, 作者)。标题：PDF Info → 首页首行。"""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        n = len(doc)
        title = None
        authors = None
        try:
            meta = doc.get_metadata_dict()
            title = (meta.get("Title") or "").strip() or None
            authors = (meta.get("Author") or "").strip() or None
        except Exception:
            pass
        if not title and n > 0:
            page = doc[0]
            tp = page.get_textpage()
            try:
                text = tp.get_text_bounded()
                for line in text.splitlines():
                    line = line.strip()
                    if len(line) >= 3:
                        title = line[:200]
                        break
            finally:
                tp.close()
                page.close()
        return n, title, authors
    finally:
        doc.close()


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    project_id: int | None = Form(None),
    is_scanned: bool = Form(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")
    settings = get_settings()
    settings.ensure_dirs()
    if project_id is not None:
        proj = db.get(Project, project_id)
        if proj is None or proj.user_id != user.id:
            raise HTTPException(status_code=404, detail="项目不存在")

    import hashlib

    h = hashlib.sha256()
    tmp = settings.files_dir / f".upload-{uuid.uuid4().hex}"
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                h.update(chunk)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    digest = h.hexdigest()
    dest = settings.files_dir / f"{digest}.pdf"
    if dest.exists():
        tmp.unlink(missing_ok=True)  # 全局内容 hash 去重，跨账号共享物理文件
    else:
        tmp.rename(dest)

    page_count, title, authors = await asyncio.to_thread(extract_pdf_meta, dest)

    with write_lock:
        ref = db.get(FileRef, digest)
        if ref is None:
            db.add(FileRef(file_hash=digest, ref_count=1))
        else:
            ref.ref_count += 1
        # 组内（同 user + 同 project，含未分组）追加到末尾
        max_order = db.query(func.max(Paper.sort_order)).filter(
            Paper.user_id == user.id, Paper.project_id == project_id
        ).scalar()
        paper = Paper(
            user_id=user.id, project_id=project_id,
            title=title or Path(file.filename).stem,
            authors=authors, file_hash=digest, page_count=page_count,
            is_scanned=int(is_scanned),
            ocr_status="pending" if is_scanned else "none",
            tags="[]", created_at=now_iso(),
            sort_order=0 if max_order is None else max_order + 1,
        )
        db.add(paper)
        db.commit()
        db.refresh(paper)

    if is_scanned:
        from app.main import app

        app.state.ocr_manager.enqueue(paper.id, dest, page_count or 1)
    else:
        tfidf_service.schedule(paper.id)
    return {"paper": paper_dict(paper)}


@router.get("")
def list_papers(
    project_id: int | None = None,
    tag: str | None = None,
    favorite: bool | None = None,
    q: str | None = None,
    sort: str = "created",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Paper).filter(Paper.user_id == user.id)
    if project_id is not None:
        query = query.filter(Paper.project_id == project_id)
    if tag:
        query = query.filter(Paper.tags.like(f'%"{tag}"%'))
    if favorite:
        query = query.filter(Paper.is_favorite == 1)
    if q:
        like = f"%{q}%"
        query = query.filter((Paper.title.like(like)) | (Paper.authors.like(like)))
    if sort == "title":
        query = query.order_by(func.lower(Paper.title).asc())
    elif sort == "last_opened":
        query = query.order_by(Paper.last_opened_at.is_(None), Paper.last_opened_at.desc())
    elif sort == "manual":
        query = query.order_by(Paper.sort_order.asc(), Paper.id.asc())
    else:
        query = query.order_by(Paper.created_at.desc(), Paper.id.desc())
    return [paper_dict(p) for p in query.all()]


@router.get("/{paper_id}")
def get_paper(paper: Paper = Depends(get_owned_paper)):
    return paper_dict(paper)


class PaperPatch(BaseModel):
    title: str | None = None
    authors: str | None = None
    venue: str | None = None
    year: int | None = None
    doi: str | None = None
    tags: list[str] | None = None
    note: str | None = None
    is_favorite: bool | None = None
    project_id: int | None = None
    sort_order: int | None = None
    is_scanned: bool | None = None


@router.patch("/{paper_id}")
def patch_paper(paper_id: int, body: PaperPatch, user: User = Depends(get_current_user),
                db: Session = Depends(get_db), paper: Paper = Depends(get_owned_paper)):
    updates = body.model_dump(exclude_unset=True)
    if "title" in updates and updates["title"] is not None:
        paper.title = updates["title"]
    if "authors" in updates:
        paper.authors = updates["authors"]
    if "venue" in updates:
        paper.venue = updates["venue"]
    if "year" in updates:
        paper.year = updates["year"]
    if "doi" in updates:
        paper.doi = updates["doi"]
    if "tags" in updates and updates["tags"] is not None:
        paper.tags = json.dumps(updates["tags"], ensure_ascii=False)
    if "note" in updates:
        paper.note = updates["note"]
    if "is_favorite" in updates and updates["is_favorite"] is not None:
        paper.is_favorite = int(updates["is_favorite"])
    if "project_id" in updates:
        if updates["project_id"] is not None:
            proj = db.get(Project, updates["project_id"])
            if proj is None or proj.user_id != user.id:
                raise HTTPException(status_code=404, detail="项目不存在")
        paper.project_id = updates["project_id"]
    if "sort_order" in updates and updates["sort_order"] is not None:
        paper.sort_order = updates["sort_order"]
    if "is_scanned" in updates and updates["is_scanned"] is not None:
        new_val = int(updates["is_scanned"])
        if new_val and not paper.is_scanned:
            paper.is_scanned = 1
            _start_ocr(db, paper)
        elif not new_val and paper.is_scanned:
            paper.is_scanned = 0
            _skip_ocr(db, paper)
    db.commit()
    return paper_dict(paper)


def _start_ocr(db: Session, paper: Paper) -> None:
    from app.main import app

    settings = get_settings()
    pdf = settings.files_dir / f"{paper.file_hash}.pdf"
    paper.ocr_status = "pending"
    app.state.ocr_manager.enqueue(paper.id, pdf, paper.page_count or 1)


def _skip_ocr(db: Session, paper: Paper) -> None:
    from app.main import app

    paper.ocr_status = "none"
    doc = db.get(OcrDoc, paper.id)
    if doc is not None:
        doc.status = "none"
        doc.error = None
    app.state.ocr_manager.cancel(paper.id)


@router.delete("/{paper_id}", status_code=204)
def delete_paper(paper: Paper = Depends(get_owned_paper), db: Session = Depends(get_db)):
    from app.main import app

    with write_lock:
        app.state.ocr_manager.cancel(paper.id)
        tfidf_service.cancel(paper.id)
        file_tokens.revoke_paper(paper.id)
        # 级联删除业务数据（words 生词本体保留）
        for model in (Annotation, WordOccurrence, GlossaryTerm, TranslationCache,
                      ReadingProgress, ReadingSession, Excerpt, OcrDoc):
            db.query(model).filter(model.paper_id == paper.id).delete()
        ref = db.get(FileRef, paper.file_hash)
        if ref is not None:
            ref.ref_count -= 1
            if ref.ref_count <= 0:
                db.delete(ref)
                f = get_settings().files_dir / f"{paper.file_hash}.pdf"
                f.unlink(missing_ok=True)
        db.delete(paper)
        db.commit()
    return None


# ---- 文件访问（唯一免 Bearer 端点：一次性 token 查询参数）----

@router.post("/{paper_id}/file-token")
def issue_file_token(paper: Paper = Depends(get_owned_paper)):
    token = file_tokens.issue(paper.id, paper.user_id)
    return {"token": token, "expires_in": get_settings().file_token_ttl}


def _range_file(path: Path, request: Request, consume_token: bool, token: str, paper_id: int):
    if consume_token and not file_tokens.consume(token, paper_id, full_get=False):
        raise HTTPException(status_code=401, detail="文件 token 无效或已过期")

    def iter_file(start: int, end: int):
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    size = path.stat().st_size
    range_header = request.headers.get("range")
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="{path.name}"',
    }
    if range_header and range_header.startswith("bytes="):
        try:
            spec = range_header[6:].split(",")[0].strip()
            start_s, _, end_s = spec.partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                return StreamingResponse(iter([]), status_code=416, headers={"Content-Range": f"bytes */{size}"})
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            return StreamingResponse(iter_file(start, end), status_code=206, media_type="application/pdf", headers=headers)
        except ValueError:
            pass
    if consume_token:
        file_tokens.consume(token, paper_id, full_get=True)
    headers["Content-Length"] = str(size)
    return StreamingResponse(iter_file(0, size - 1), status_code=200, media_type="application/pdf", headers=headers)


@router.get("/{paper_id}/file")
def get_paper_file(paper_id: int, token: str = "", request: Request = None, db: Session = Depends(get_db)):
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")
    if not token:
        raise HTTPException(status_code=401, detail="缺少文件 token")
    settings = get_settings()
    path = ensure_within(settings.files_dir, settings.files_dir / f"{paper.file_hash}.pdf")
    if not path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    return _range_file(path, request, consume_token=True, token=token, paper_id=paper.id)
