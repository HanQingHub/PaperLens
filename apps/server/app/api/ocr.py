from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.util import ensure_within
from app.models import OcrDoc, User
from app.api.deps import get_current_user, owned_paper

router = APIRouter(tags=["ocr"])


def _enqueue(db: Session, user: User, paper_id: int) -> dict:
    from app.main import app

    paper = owned_paper(db, user, paper_id)
    settings = get_settings()
    task_dir = settings.ocr_dir / str(paper_id)
    if (task_dir / "task.json").exists() or (task_dir / "task.claimed.json").exists():
        doc = db.get(OcrDoc, paper.id)
        return {"ocr_status": paper.ocr_status,
                "pages_done": doc.pages_done if doc else 0,
                "pages_total": doc.pages_total if doc else paper.page_count}
    pdf = settings.files_dir / f"{paper.file_hash}.pdf"
    paper.is_scanned = 1
    app.state.ocr_manager.enqueue(paper.id, pdf, paper.page_count or 1)
    db.commit()
    return {"ocr_status": "pending", "pages_done": 0, "pages_total": paper.page_count}


@router.post("/papers/{paper_id}/ocr", status_code=202)
def start_ocr(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _enqueue(db, user, paper_id)


@router.post("/papers/{paper_id}/ocr/retry", status_code=202)
def retry_ocr(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    paper = owned_paper(db, user, paper_id)
    if paper.ocr_status in ("pending", "running"):
        raise HTTPException(status_code=409, detail="任务进行中，无需重试")
    return _enqueue(db, user, paper_id)


@router.get("/papers/{paper_id}/ocr-status")
def ocr_status(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    paper = owned_paper(db, user, paper_id)
    doc = db.get(OcrDoc, paper.id)
    return {
        "status": paper.ocr_status,
        "pages_done": doc.pages_done if doc else 0,
        "pages_total": doc.pages_total if doc else paper.page_count,
        **({"error": doc.error} if doc and doc.error else {}),
    }


@router.get("/papers/{paper_id}/ocr-result")
def ocr_result(paper_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    owned_paper(db, user, paper_id)
    settings = get_settings()
    path = ensure_within(settings.ocr_dir, settings.ocr_dir / str(paper_id) / "blocks.ndjson")
    if not path.exists():
        raise HTTPException(status_code=404, detail="OCR 结果不存在")
    return FileResponse(path, media_type="application/x-ndjson",
                        headers={"Content-Disposition": f'attachment; filename="ocr_{paper_id}.ndjson"'})
