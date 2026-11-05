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
# 版式噪声：URL / 邮箱 / DOI / arXiv 号 / 页脚域名。若不先剥离，
# "https" "arxiv" "org" 会被 TF-IDF 选成高频术语并预译成垃圾条目。
_NOISE_RE = re.compile(
    r"(?:https?://\S+|www\.\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|"
    r"\b10\.\d{4,9}/\S+|\barxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?|\b\d{4}\.\d{4,6}v\d+\b)",
    re.I,
)
# 这些词即使高频也不是本文术语（出版信息/常见工具名/泛化动词）
EXTRA_STOP = set(
    """arxiv http https www com org net edu gov github gitlab huggingface modelscope
    pdf doi url uri html htm png jpg tex bib dvi ieee acm cvpr iccv eccv neurips nips iclr icml
    acl emnlp naacl aaai ijcai kdd sigir www conference proceedings preprint journal volume
    accepted published submitted copyright license authors affiliation email corresponding
    figure figures table tables appendix equation equations algorithm algorithms
    """.split()
)
_tasks: dict[int, asyncio.Task] = {}
session_factory = None


def tokenize(text: str) -> list[str]:
    text = _NOISE_RE.sub(" ", text or "")
    return [
        t for t in _TOKEN_RE.findall(text.lower())
        if len(t) >= 3 and t not in STOPWORDS and t not in EXTRA_STOP
    ]


_CASE_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def _token_stream(text: str, lower_seen: set[str]) -> list[str]:
    """按原文大小写分词，并记录"曾以小写出现过"的词。

    学术 PDF 里的作者姓氏（Zhang/Liu/Wang…）只在引用处首字母大写，
    正文概念词必然有 mid-sentence 小写形态。用这个信号把姓氏挡在术语表外，
    同时放行全大写缩写（LLM/RAG）与含数字/连字符的方法名（JIT-Agent/GPT-4o）。
    """
    text = _NOISE_RE.sub(" ", text or "")
    out: list[str] = []
    for m in _CASE_TOKEN_RE.finditer(text):
        w = m.group(0)
        lw = w.lower()
        if len(lw) < 3 or lw in STOPWORDS or lw in EXTRA_STOP:
            continue
        if w[0].islower():
            lower_seen.add(lw)
        out.append(lw)
    return out


def _term_allowed(term: str, lower_seen: set[str], caps_seen: set[str], special: set[str]) -> bool:
    for part in term.split():
        if part in lower_seen or part in caps_seen or part in special:
            continue
        return False
    return True


def _dedupe_plural(terms: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """单复数去重：harness/harnesses、agent/agents 同时入选时只保留分数更高者。"""
    present = {t for t, _ in terms}
    out: list[tuple[str, float]] = []
    dropped: set[str] = set()
    for term, score in terms:  # 已按分数降序
        if term in dropped:
            continue
        if " " not in term and term.endswith("s"):
            singles = [term[:-1]]
            if term.endswith("es"):
                singles.append(term[:-2])
            if any(s in present for s in singles):
                dropped.add(term)
                continue
        out.append((term, score))
    return out


def tfidf_top30(pages_text: list[str]) -> list[tuple[str, float]]:
    """页为文档算 IDF，全篇算 TF。仅保留出现 ≥2 次的候选：
    单次出现的 token 多为排版噪声/公式碎片，进术语表只会拖累划词命中质量。"""
    n_docs = max(1, len(pages_text))
    lower_seen: set[str] = set()
    caps_seen: set[str] = set()
    special: set[str] = set()
    for p in pages_text:
        for m in _CASE_TOKEN_RE.finditer(_NOISE_RE.sub(" ", p or "")):
            w = m.group(0)
            if w.isupper() and 2 <= len(w) <= 8:
                caps_seen.add(w.lower())
            if any(c.isdigit() for c in w) or "-" in w:
                special.add(w.lower())
    doc_tokens = [_token_stream(p, lower_seen) for p in pages_text]
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
        if cnt < 2:
            continue
        if not _term_allowed(term, lower_seen, caps_seen, special):
            continue
        tf = cnt / n_tokens
        idf = math.log((n_docs + 1) / (df.get(term, 0) + 1)) + 1
        # 双词术语更接近"学术术语"，同分下优先
        boost = 1.12 if " " in term else 1.0
        scored.append((term, tf * idf * boost))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return _dedupe_plural(scored[:34])[:30]


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
    """解析模型输出的术语对照。优先 JSON 数组；被截断/漏括号时退化为逐行
    `term: 译名` 与 `"term":"...","zh":"..."` 片段匹配（2B 模型常见两种都给不全）。"""
    start, end = raw.find("["), raw.rfind("]")
    if start >= 0 and end > start:
        try:
            arr = json.loads(raw[start : end + 1])
            out = {}
            for item in arr:
                if isinstance(item, dict) and item.get("term"):
                    out[str(item["term"]).strip().lower()] = str(item.get("zh") or "").strip()
            if out:
                return out
        except ValueError:
            pass
    out: dict[str, str] = {}
    for m in re.finditer(r'"term"\s*:\s*"([^"]+)"\s*,\s*"zh"\s*:\s*"([^"]*)"', raw):
        out[m.group(1).strip().lower()] = m.group(2).strip()
    if out:
        return out
    for line in raw.splitlines():
        m = re.match(r"^\s*\d+[.、)]\s*([A-Za-z][\w' -]{1,40}?)\s*[:：\-–]\s*(\S.*)$", line)
        if m:
            out[m.group(1).strip().lower()] = m.group(2).strip().strip('",')
    return out


def _sample_sentence(pages: list[str], term: str, budget: int = 150) -> str:
    """取术语在正文中的首个出现句（截断到 budget 字符），供预译提示词消歧。
    术语表预译的最大质量杀手是"脱离语境直译"（harness → 驾驭/利用），
    给一句真实用例即可把 2B 模型拉回论文语义。"""
    pat = re.compile(r"(?<![A-Za-z0-9])" + re.escape(term) + r"(?![A-Za-z0-9])", re.I)
    for page in pages:
        text = re.sub(r"\s+", " ", page)
        m = pat.search(text)
        if not m:
            continue
        start = max(0, m.start() - 70)
        end = min(len(text), m.end() + 70)
        frag = text[start:end].strip()
        # 向两侧扩到句界（找不到就保持截断）
        left = text.rfind(". ", 0, m.start())
        if left >= 0 and m.start() - left < 120:
            frag = text[left + 2 : end].strip()
        right = text.find(". ", m.end())
        if right >= 0 and right - m.end() < 120:
            frag = text[start:right + 1].strip()
        return frag[:budget]
    return ""


async def _pre_translate(db: Session, paper_id: int, pages: list[str] | None = None,
                         title: str = "") -> None:
    if llm_service.state != "ready":
        return  # 模型未加载不自动拉起（内存约束），划词时现查
    rows = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == paper_id, GlossaryTerm.source == "tfidf")
        .all()
    )
    pending = [r for r in rows if not r.domain_translation]
    pages = pages or []
    # 批大小 6：每词带一句示例后 prompt 明显变长，10 词会超 500 token 上限被截断，
    # 截断的 JSON 解析失败 → 整批留空（划词时现查，术语表形同虚设）
    for i in range(0, len(pending), 6):
        batch = pending[i : i + 6]
        lines: list[str] = []
        for j, r in enumerate(batch):
            sample = _sample_sentence(pages, r.term)
            lines.append(f"{j+1}. {r.term}" + (f" —— 例: {sample}" if sample else ""))
        messages = [
            {"role": "system", "content": "你是学术论文术语翻译。只输出 JSON，不要解释。"},
            {"role": "user", "content": (
                (f"论文标题: {title[:80]}\n" if title else "")
                + "下列术语出自该论文，请结合示例句给出论文语境下的中文译名"
                "（名词性短语，2-8 字；方法名/模型名保留英文）。\n"
                + "\n".join(lines)
                + "\n只输出 JSON 数组，格式 [{\"term\":\"...\",\"zh\":\"...\"}]，不要输出其他内容。")},
        ]
        try:
            raw = ""
            async for item in llm_service.chat_stream(messages, max_tokens=800):
                if item["type"] == "delta":
                    raw += item["text"]
            mapping = _parse_terms_json(raw)
            for r in batch:
                zh = mapping.get(r.term.strip().lower())
                if zh:
                    r.domain_translation = zh[:40]
            db.commit()
        except Exception:
            continue
        await asyncio.sleep(0.5)  # 低优先级，让路交互请求


async def _run(paper_id: int) -> None:
    from app.core.config import get_settings

    factory = session_factory
    if factory is None:
        from app.core.db import SessionLocal

        factory = SessionLocal
    db = factory()
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
        await _pre_translate(db, paper_id, pages, paper.title or "")
    finally:
        db.close()


def schedule(paper_id: int, loop: asyncio.AbstractEventLoop | None = None) -> None:
    cancel(paper_id)
    if loop is None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(_run(paper_id))
    else:
        task = asyncio.run_coroutine_threadsafe(_run(paper_id), loop)
    _tasks[paper_id] = task
    task.add_done_callback(lambda _t: _tasks.pop(paper_id, None))


def cancel(paper_id: int) -> None:
    task = _tasks.pop(paper_id, None)
    if task is not None and not task.done():
        task.cancel()
