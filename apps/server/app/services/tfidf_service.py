"""术语表自举：TF-IDF（1-2gram 去停用词 top30）+ 后台批量预译（可取消）。"""
import asyncio
import json
import math
import re
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import GlossaryTerm, Paper
from app.services.llm_service import llm_service

STOPWORDS = set(
    """a an the and or but if then else of in on at to for from by with without within into onto
    is are was were be been being am do does did done have has had having can could should would
    will shall may might must not no nor so as than that this these those it its it's we our you
    your they their he she his her i me my us them who whom which what when where why how all any
    both each few more most other some such only own same too very s t just don now here there
    also however thus hence therefore moreover furthermore respectively via using used use uses
    based propose proposed proposes show shown shows shown result results paper papers study
    studies work works approach approaches method methods model models fig figure table section
    et al eg ie etc abstract introduction conclusion conclusions references acknowledgments
    between across during before after above below up down out off over under again further once
    because while until against through both during before after""".split()
)

_TOKEN_RE = re.compile(r"[a-z][a-z'-]+")
_tasks: dict[int, asyncio.Task] = {}


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if len(t) >= 3 and t not in STOPWORDS]


def tfidf_top30(pages_text: list[str]) -> list[tuple[str, float]]:
    """页为文档算 IDF，全篇算 TF。"""
    n_docs = max(1, len(pages_text))
    doc_tokens = [tokenize(p) for p in pages_text]
    df: dict[str, int] = {}
    for toks in doc_tokens:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
        for a, b in zip(toks, toks[1:]):
            g = f"{a} {b}"
            df[g] = df.get(g, 0) + 1
    total: dict[str, int] = {}
    for toks in doc_tokens:
        for t in toks:
            total[t] = total.get(t, 0) + 1
        for a, b in zip(toks, toks[1:]):
            total[f"{a} {b}"] = total.get(f"{a} {b}", 0) + 1
    n_tokens = max(1, sum(len(t) for t in doc_tokens))
    scored = []
    for term, cnt in total.items():
        tf = cnt / n_tokens
        idf = math.log((n_docs + 1) / (df.get(term, 0) + 1)) + 1
        scored.append((term, tf * idf))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored[:30]


def extract_pdf_pages(pdf_path: Path) -> list[str]:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        pages = []
        for page in doc:
            tp = page.get_textpage()
            try:
                pages.append(tp.get_text_bounded())
            finally:
                tp.close()
                page.close()
        return pages
    finally:
        doc.close()


def extract_ocr_pages(ndjson_path: Path) -> list[str]:
    pages: list[str] = []
    if not ndjson_path.exists():
        return pages
    with open(ndjson_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            pages.append(" ".join(b.get("text", "") for b in obj.get("blocks", [])))
    return pages


def upsert_terms(db: Session, paper_id: int, user_id: int, terms: list[tuple[str, float]]) -> None:
    existing = {
        r.term: r
        for r in db.query(GlossaryTerm).filter(GlossaryTerm.paper_id == paper_id).all()
    }
    max_score = max((s for _, s in terms), default=1.0) or 1.0
    for term, score in terms:
        row = existing.get(term)
        conf = round(score / max_score, 4)
        if row is not None:
            if row.source == "user":
                continue  # 用户修正优先，不被 tfidf 覆盖
            row.confidence = conf
        else:
            db.add(GlossaryTerm(
                user_id=user_id, paper_id=paper_id, term=term,
                domain_translation=None, confidence=conf, source="tfidf",
            ))
    db.commit()


def _parse_terms_json(raw: str) -> dict[str, str]:
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("无 JSON 数组")
    arr = json.loads(raw[start : end + 1])
    out = {}
    for item in arr:
        if isinstance(item, dict) and item.get("term"):
            out[str(item["term"])] = str(item.get("zh") or "")
    return out


async def _pre_translate(db: Session, paper_id: int) -> None:
    if llm_service.state != "ready":
        return  # 模型未加载不自动拉起（内存约束），划词时现查
    rows = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == paper_id, GlossaryTerm.source == "tfidf")
        .all()
    )
    pending = [r for r in rows if not r.domain_translation]
    for i in range(0, len(pending), 10):
        batch = pending[i : i + 10]
        terms = "\n".join(f"{j+1}. {r.term}" for j, r in enumerate(batch))
        messages = [
            {"role": "system", "content": "你是学术术语翻译。"},
            {"role": "user", "content": (
                "将下列英文术语译为中文，输出 JSON 数组 [{\"term\":\"...\",\"zh\":\"...\"}]，"
                "不要输出其他内容。\n" + terms)},
        ]
        try:
            raw = ""
            async for item in llm_service.chat_stream(messages, max_tokens=500):
                if item["type"] == "delta":
                    raw += item["text"]
            mapping = _parse_terms_json(raw)
            for r in batch:
                if mapping.get(r.term):
                    r.domain_translation = mapping[r.term]
            db.commit()
        except Exception:
            continue
        await asyncio.sleep(0.5)  # 低优先级，让路交互请求


async def _run(paper_id: int) -> None:
    from app.core.config import get_settings
    from app.core.db import SessionLocal

    db = SessionLocal()
    try:
        paper = db.get(Paper, paper_id)
        if paper is None:
            return
        settings = get_settings()
        if paper.is_scanned and paper.ocr_status == "done":
            pages = await asyncio.to_thread(
                extract_ocr_pages, settings.ocr_dir / str(paper_id) / "blocks.ndjson"
            )
        else:
            pages = await asyncio.to_thread(
                extract_pdf_pages, settings.files_dir / f"{paper.file_hash}.pdf"
            )
        if not any(p.strip() for p in pages):
            return
        terms = tfidf_top30(pages)
        upsert_terms(db, paper_id, paper.user_id, terms)
        await _pre_translate(db, paper_id)
    finally:
        db.close()


def schedule(paper_id: int) -> None:
    cancel(paper_id)
    try:
        task = asyncio.get_running_loop().create_task(_run(paper_id))
    except RuntimeError:
        return
    _tasks[paper_id] = task
    task.add_done_callback(lambda _t: _tasks.pop(paper_id, None))


def cancel(paper_id: int) -> None:
    task = _tasks.pop(paper_id, None)
    if task is not None and not task.done():
        task.cancel()
