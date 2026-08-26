import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db, write_lock
from app.core.util import ensure_within, like_escape, now_iso
from app.models import (
    Annotation, Excerpt, FileRef, GlossaryTerm, OcrDoc, Paper,
    Project, ReadingProgress, ReadingSession, TranslationCache, User, WordOccurrence,
)
from app.api.deps import get_current_user, get_owned_paper
from app.services import file_tokens, tfidf_service

router = APIRouter(prefix="/papers", tags=["papers"])


def paper_dict(p: Paper, annotation_count: int | None = None) -> dict:
    d = {
        "id": p.id, "user_id": p.user_id, "project_id": p.project_id, "title": p.title,
        "authors": p.authors, "venue": p.venue, "year": p.year, "doi": p.doi,
        "arxiv_id": p.arxiv_id,
        "file_hash": p.file_hash, "page_count": p.page_count, "open_count": p.open_count,
        "is_scanned": bool(p.is_scanned), "ocr_status": p.ocr_status,
        "tags": json.loads(p.tags) if p.tags else [],
        "note": p.note, "is_favorite": bool(p.is_favorite),
        "sort_order": p.sort_order,
        "created_at": p.created_at, "last_opened_at": p.last_opened_at,
    }
    if annotation_count is not None:
        d["annotation_count"] = annotation_count
    return d


# ── 首页文本元数据提取（纯本地启发式；识别不到即为 None，不虚构）──
_YEAR_RE = re.compile(r"\b(19[89]\d|20[0-3]\d)\b")
_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+")
_ARXIV_NEW_RE = re.compile(r"arXiv[:\s]*(\d{4}\.\d{4,5})(?:v\d+)?")
_ARXIV_OLD_RE = re.compile(r"arXiv[:\s]*([a-z-]+(?:\.[A-Z]{2})?/\d{7})")
# arXiv 官方水印固定形态（含 [分类] 与日期尾部）——参考文献引用不带此尾部，
# 可安全全文搜索（pypdfium2 文本对象顺序里水印常排在正文之后，不能限前 N 字符）
_ARXIV_WATERMARK_NEW_RE = re.compile(
    r"arXiv[:\s]*(\d{4}\.\d{4,5})(?:v\d+)?\s+\[[a-zA-Z.\-]+\]\s+\d{1,2}\s+[A-Z][a-z]{2}\s+(\d{4})"
)
_ARXIV_WATERMARK_OLD_RE = re.compile(
    r"arXiv[:\s]*([a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?\s+\[[a-zA-Z.\-]+\]\s+\d{1,2}\s+[A-Z][a-z]{2}\s+(\d{4})"
)
_NOISE_LINE_RE = re.compile(r"https?://|www\.|@", re.IGNORECASE)
_NUMONLY_LINE_RE = re.compile(r"[\d\s\-–—./]+")
_DOI_LINE_RE = re.compile(r"^10\.\d{4,9}/")


@dataclass
class PdfMeta:
    page_count: int
    title: str | None
    authors: str | None
    year: int | None
    doi: str | None
    arxiv_id: str | None


def _extract_watermark(text: str) -> tuple[str | None, int | None]:
    """arXiv 官方水印 → (arxiv_id, 提交年份)。水印日期是 year 最可靠来源
    （首页前部的引用/脚注年份会造成首个匹配误报，实测 DeepSeek-R1 误报 2020）。"""
    m = _ARXIV_WATERMARK_NEW_RE.search(text)
    if m:
        return m.group(1), int(m.group(2))
    m = _ARXIV_WATERMARK_OLD_RE.search(text)
    if m:
        return m.group(1), int(m.group(2))
    # 兜底：页眉区（前 600 字符）的裸 ID（作者自制 PDF 首行标注场景），无年份
    head = text[:600]
    m = _ARXIV_NEW_RE.search(head)
    if m:
        return m.group(1), None
    m = _ARXIV_OLD_RE.search(head)
    if m:
        return m.group(1), None
    return None, None


def _extract_year(text: str, watermark_year: int | None) -> int | None:
    if watermark_year is not None:
        return watermark_year
    # 版权/页眉区（前 800 字符）优先取首个；否则取首页文本内最后一个匹配
    m = _YEAR_RE.search(text[:800])
    if m:
        return int(m.group(1))
    matches = _YEAR_RE.findall(text)
    return int(matches[-1]) if matches else None


def _extract_doi(text: str) -> str | None:
    m = _DOI_RE.search(text)
    if m is None:
        return None
    return m.group(0).rstrip(".,;)'\">]")


def _title_from_text(text: str) -> str | None:
    """已废弃的文本启发式保留说明：最长行法在真实论文集上大量误识别
    （作者行/摘要句更长且 pypdfium2 为文本对象顺序），已被 _title_from_font 取代。"""
    return None


def _title_from_font(page) -> str | None:
    """字体大小启发式：标题字号显著大于正文/作者行，几何信号与文本顺序无关。
    raw API 取字符（get_text_range 逐字符存在索引错位陷阱，pypdfium2 文档明示）。"""
    from pypdfium2.raw import FPDFText_GetFontSize, FPDFText_GetUnicode

    tp = page.get_textpage()
    try:
        n = tp.count_chars()
        if n < 8:
            return None
        chars = []  # (char, x0, x1, y_mid, size)
        for i in range(n):
            try:
                uni = FPDFText_GetUnicode(tp.raw, i)
                if not uni:
                    continue
                ch = chr(uni)
                if ch.isspace():
                    continue
                size = FPDFText_GetFontSize(tp.raw, i)
                x0, bottom, x1, top = tp.get_charbox(i)
            except Exception:
                continue
            if size <= 0:
                continue
            chars.append((ch, x0, x1, (bottom + top) / 2, size))
        if len(chars) < 8:
            return None

        # y 降序（页面顶部在前）聚类成行：相邻字符 y 间隙 ≤ 较小字号×0.45 归同行
        # （用 min 防大字号容差吞掉相邻小字行；行内同字号微差远小于此阈值）
        chars.sort(key=lambda c: -c[3])
        lines: list[list] = []
        cur = [chars[0]]
        for c in chars[1:]:
            if abs(cur[-1][3] - c[3]) <= min(cur[-1][4], c[4]) * 0.45:
                cur.append(c)
            else:
                lines.append(cur)
                cur = [c]
        lines.append(cur)

        def line_text(group) -> tuple[str, bool]:
            """返回 (行文本, 是否可靠)。x 逆序比例高 = 旋转/复杂排版，不可靠。"""
            ordered = sorted(group, key=lambda c: c[1])
            parts: list[str] = []
            prev_x0 = prev_x1 = None
            inversions = nonws = 0
            for c in ordered:
                if prev_x0 is not None and c[1] < prev_x0:
                    inversions += 1
                nonws += 1
                # x 间隙超过字号 22% 处还原词间空格（空格字符已在采集时跳过）
                if prev_x1 is not None and c[1] - prev_x1 > c[4] * 0.22:
                    parts.append(" ")
                parts.append(c[0])
                prev_x0, prev_x1 = c[1], c[2]
            reliable = nonws == 0 or inversions / nonws <= 0.2
            return re.sub(r"\s+", " ", "".join(parts)).strip(), reliable

        def cjk_ratio(s: str) -> float:
            if not s:
                return 0.0
            return sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff") / len(s)

        rows = []
        for g in lines:
            text, reliable = line_text(g)
            if not text or not reliable:
                continue
            sizes = sorted(c[4] for c in g)
            med = sizes[len(sizes) // 2]
            y_mid = sum(c[3] for c in g) / len(g)
            rows.append({"text": text, "size": med, "y": y_mid})
        rows = [r for r in rows if r["text"] and len(r["text"]) >= 4]
        if len(rows) < 3:
            return None

        ys = [r["y"] for r in rows]
        page_top, page_bottom = max(ys), min(ys)
        span = page_top - page_bottom
        median_size = sorted(r["size"] for r in rows)[len(rows) // 2]
        threshold = median_size * 1.22

        candidates = [
            r for r in rows
            if r["size"] >= threshold
            and r["y"] >= page_bottom + span * 0.3  # 页面上半部
            and not _NOISE_LINE_RE.search(r["text"])
            and not _DOI_LINE_RE.search(r["text"])
            and not _NUMONLY_LINE_RE.fullmatch(r["text"])
            and "arXiv" not in r["text"]
            # 摘要标记行字号常与标题相近，拼接会混入尾部（实测 67/69/70）
            and not re.match(r"(?i)^(abstract|摘要)\b", r["text"])
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda r: -r["size"])
        head = candidates[0]
        # 拼接跨行标题：字号差 ≤15% 的相邻候选，按 y 降序（视觉上→下），
        # 连接符 CJK 直连、英文空格
        group = [head]
        for r in sorted(candidates, key=lambda r: -r["y"]):
            if r is head:
                continue
            if abs(r["size"] - head["size"]) <= head["size"] * 0.15 and len(group) < 3:
                group.append(r)
        group.sort(key=lambda r: -r["y"])
        sep = "" if cjk_ratio(group[0]["text"]) > 0.3 else " "
        title = sep.join(r["text"] for r in group)
        min_len = 4 if cjk_ratio(title) > 0.3 else 8
        if not (min_len <= len(title) <= 300):
            return None
        if _NOISE_LINE_RE.search(title) or _NUMONLY_LINE_RE.fullmatch(title):
            return None
        return title
    finally:
        tp.close()


def extract_pdf_meta(path: Path) -> PdfMeta:
    """Info 元数据优先；缺失字段从首页文本启发式提取（识别不到即为 None，不虚构）。"""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        n = len(doc)
        title = authors = None
        try:
            meta = doc.get_metadata_dict()
            title = (meta.get("Title") or "").strip() or None
            authors = (meta.get("Author") or "").strip() or None
        except Exception:
            pass
        first_text = ""
        font_title = None
        if n > 0:
            page = doc[0]
            tp = page.get_textpage()
            try:
                first_text = tp.get_text_bounded()
                if not title:
                    font_title = _title_from_font(page)
            finally:
                tp.close()
                page.close()
        if not title:
            title = font_title
        arxiv_id, watermark_year = _extract_watermark(first_text) if first_text else (None, None)
        return PdfMeta(
            page_count=n,
            title=title,
            authors=authors,
            year=_extract_year(first_text, watermark_year) if first_text else None,
            doi=_extract_doi(first_text) if first_text else None,
            arxiv_id=arxiv_id,
        )
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
    paper = await _import_pdf_bytes(
        await file.read(), user, db, project_id=project_id, is_scanned=is_scanned,
        filename=file.filename,
    )
    return {"paper": paper_dict(paper)}


async def _import_pdf_bytes(
    data: bytes,
    user: User,
    db: Session,
    *,
    project_id: int | None = None,
    is_scanned: bool = False,
    filename: str | None = None,
) -> Paper:
    """上传管道共用入口（upload 与 arXiv 导入）：写盘+hash 去重 → 元数据提取 →
    FileRef/Paper 落库 → OCR/tfidf 分派。阻塞段（解析/提取）卸载到线程。"""
    settings = get_settings()
    settings.ensure_dirs()
    if project_id is not None:
        proj = db.get(Project, project_id)
        if proj is None or proj.user_id != user.id:
            raise HTTPException(status_code=404, detail="项目不存在")

    import hashlib

    digest = hashlib.sha256(data).hexdigest()
    dest = settings.files_dir / f"{digest}.pdf"
    if not dest.exists():
        dest.write_bytes(data)

    meta = await asyncio.to_thread(extract_pdf_meta, dest)

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
        title_fallback = Path(filename).stem if filename else (f"arXiv {meta.arxiv_id}" if meta.arxiv_id else "未命名论文")
        paper = Paper(
            user_id=user.id, project_id=project_id,
            title=meta.title or title_fallback,
            authors=meta.authors, file_hash=digest, page_count=meta.page_count,
            year=meta.year, doi=meta.doi, arxiv_id=meta.arxiv_id,
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

        app.state.ocr_manager.enqueue(paper.id, dest, meta.page_count or 1)
    else:
        tfidf_service.schedule(paper.id)
    return paper


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
        query = query.filter(Paper.tags.like(f'%"{like_escape(tag)}"%', escape="\\"))
    if favorite:
        query = query.filter(Paper.is_favorite == 1)
    if q:
        like = f"%{like_escape(q)}%"
        query = query.filter(
            Paper.title.like(like, escape="\\")
            | Paper.authors.like(like, escape="\\")
            | Paper.tags.like(like, escape="\\")
        )
    if sort == "title":
        query = query.order_by(func.lower(Paper.title).asc())
    elif sort == "last_opened":
        query = query.order_by(Paper.last_opened_at.is_(None), Paper.last_opened_at.desc())
    elif sort == "manual":
        query = query.order_by(Paper.sort_order.asc(), Paper.id.asc())
    else:
        query = query.order_by(Paper.created_at.desc(), Paper.id.desc())
    # 批注计数一次聚合（每 paper 一行的子查询，outerjoin 不产生行膨胀）
    from app.models import Annotation

    count_sq = (
        db.query(Annotation.paper_id, func.count(Annotation.id).label("c"))
        .filter(Annotation.user_id == user.id)
        .group_by(Annotation.paper_id)
        .subquery()
    )
    rows = (
        query.outerjoin(count_sq, count_sq.c.paper_id == Paper.id)
        .with_entities(Paper, func.coalesce(count_sq.c.c, 0))
        .all()
    )
    return [paper_dict(p, c) for p, c in rows]


@router.get("/tags")
def list_tags(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """全库标签聚合（不受当前筛选影响），按使用次数降序。"""
    from collections import Counter

    counter: Counter = Counter()
    rows = db.query(Paper.tags).filter(Paper.user_id == user.id, Paper.tags.isnot(None), Paper.tags != "[]").all()
    for (tags_json,) in rows:
        try:
            for t in json.loads(tags_json):
                if t:
                    counter[t] += 1
        except ValueError:
            continue
    return [{"name": t, "count": n} for t, n in counter.most_common()]


class ArxivIn(BaseModel):
    arxiv_id: str


@router.post("/arxiv", status_code=201)
async def import_arxiv(body: ArxivIn, user: User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """arXiv ID 粘贴导入：联网下载 PDF 后走标准上传管道。"""
    import httpx

    aid = body.arxiv_id.strip()
    if not re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?", aid):
        raise HTTPException(status_code=422, detail="arXiv ID 格式应为 2401.12345")
    base_id = aid.split("v")[0]
    dup = db.query(Paper).filter(Paper.user_id == user.id, Paper.arxiv_id == base_id).first()
    if dup is not None:
        raise HTTPException(status_code=409, detail=f"该 arXiv 论文已在库（{dup.title}）")
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(f"https://arxiv.org/pdf/{aid}")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="无法连接 arXiv（请检查网络）")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"arXiv 下载失败（HTTP {resp.status_code}）")
    if len(resp.content) < 1024 or not resp.content[:5] == b"%PDF-":
        raise HTTPException(status_code=502, detail="arXiv 返回内容不是有效 PDF")
    paper = await _import_pdf_bytes(resp.content, user, db, filename=f"arXiv {base_id}.pdf")
    return paper_dict(paper)


@router.get("/{paper_id}")
def get_paper(paper: Paper = Depends(get_owned_paper)):
    return paper_dict(paper)


@router.post("/{paper_id}/extract-meta")
async def extract_meta(paper: Paper = Depends(get_owned_paper), db: Session = Depends(get_db)):
    """从论文 PDF 重跑元数据提取；仅填充当前为空（None/空串）的字段，绝不覆盖已有值。"""
    path = get_settings().files_dir / f"{paper.file_hash}.pdf"
    if not path.exists():
        raise HTTPException(status_code=404, detail="PDF 文件缺失，无法识别")
    meta = await asyncio.to_thread(extract_pdf_meta, path)
    for field, val in (
        ("title", meta.title), ("authors", meta.authors), ("year", meta.year),
        ("doi", meta.doi), ("arxiv_id", meta.arxiv_id),
    ):
        cur = getattr(paper, field)
        if (cur is None or cur == "") and val is not None:
            setattr(paper, field, val)
    db.commit()
    db.refresh(paper)
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
