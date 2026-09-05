"""翻译链路：四层裁决 + SSE 事件流。

① 个人词库（术语表 source=user 修正优先 + 徽标）② 本文术语表 ③ 翻译缓存
④ ECDICT 毫秒级先出 + LLM 流式（仅 LLM 结果写缓存）。
"""
import asyncio
import hashlib
import json
import re
import time
import unicodedata
from typing import AsyncGenerator

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.util import now_iso
from app.models import GlossaryTerm, Paper, TranslateHistory, TranslationCache, Word
from app.services import ecdict_service
from app.services.llm_service import (
    LOAD_TIMEOUT, LLMLoadingTimeout, LLMInterrupted, LLMTimeout, llm_service,
)

PING_INTERVAL = 10.0  # 10s 无事件发 ping 心跳
LOAD_WAIT_PING = 5.0  # 模型加载等待中心跳间隔（< 前端 15s SSE 看门狗；冷加载 60s 窗口不断流）
FIRST_TOKEN_TIMEOUT = 30.0  # 首 token 30s 超时
SENT_MAX_TOKENS = 500  # 句译输出上限（词卡 300 不够长句）

INPUT_BUDGET_TOKENS = 1000  # 提示词总输入预算（N_CTX=4096，输出占 300，留足余量）
TITLE_BUDGET_TOKENS = 30  # 论文标题预算
GLOSSARY_BUDGET_TOKENS = 200  # 术语表（节选）预算
WORD_MAX_CHARS = 256  # 单词/短语上限，超长视为误选长文本

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# 零宽/双向控制/软连字符：OCR 与 PDF 提取常见不可见噪声
_ZW_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff\xad]")
# 划词首尾常见引号/标点（内部连字符等保留，state-of-the-art 不受影响）
_WORD_STRIP_CHARS = "\"'`´‘’“”„«»‹›…·.,;:!?()[]{}<>|/\\—–_-~^*#%@&+="
# 纯数字/符号（含百分号、运算符、范围号）无需查询
_PURE_SYMBOL_RE = re.compile(
    r"^[\d\s.,:%/×÷+\-—–°∝≈≤≥<>~=*#@$&^|!?'\"(){}\[\]]+$"
)
_LATIN_RE = re.compile(r"[A-Za-z]")


def _est_tokens(s: str) -> int:
    """粗略 token 估算：CJK 1 字/token，其他按 4 字符/token。"""
    if not s:
        return 0
    cjk = sum(1 for c in s if "\u4e00" <= c <= "\u9fff")
    return cjk + (len(s) - cjk + 3) // 4


def _clean(s: str) -> str:
    """清洗 PDF/OCR 噪声：兼容字符归一（连字ﬁ→fi、全角Ａ→A）、剥离控制/零宽字符、
    修复连字断行、折叠空白。"""
    s = s or ""
    try:
        s = unicodedata.normalize("NFKC", s)
    except ValueError:
        pass
    s = _ZW_RE.sub("", s)
    s = _CTRL_RE.sub("", s)
    s = re.sub(r"-\s*\n\s*", "", s)  # hyphen-\nated → hyphenated
    s = re.sub(r"\s*\n\s*", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _strip_word(w: str) -> str:
    """剥离划词首尾的引号/标点（PDF 划词常带 “word,” 或 (word) 等）。"""
    return w.strip(_WORD_STRIP_CHARS).strip()


def _validate_word(word: str) -> str | None:
    """词查询前置校验：返回错误 detail；None 表示可继续。"""
    if not word:
        return "未选中有效单词"
    if _PURE_SYMBOL_RE.match(word):
        return "数字或符号无需翻译"
    if _LATIN_RE.search(word) is None:
        return "暂只支持英文词句查询"
    return None


def _cut_head(s: str, budget: int) -> str:
    """从头部截取 ≤ budget token 的前缀。"""
    if budget <= 0 or not s:
        return ""
    if _est_tokens(s) <= budget:
        return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _est_tokens(s[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return s[:lo]


def _cut_middle(s: str, budget: int) -> str:
    """按预算保头尾截断（中间省略），供辅助上下文使用。"""
    if budget <= 0 or not s:
        return ""
    if _est_tokens(s) <= budget:
        return s
    head = _cut_head(s, max(1, int(budget * 0.6)))
    tail_budget = budget - _est_tokens(head) - 1
    if tail_budget <= 0:
        return head
    rest = s[len(head):]
    tail = _cut_head(rest[::-1], tail_budget)[::-1]
    return head + "…" + tail


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_response_headers() -> dict:
    return {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _decorate(text: str) -> str:
    """LLM 输出装饰规约：**【x】**/##【x】## → 【x】（分区标记的 markdown 变体）。"""
    return (
        text.replace("**【", "【").replace("】**", "】")
        .replace("##【", "【").replace("】##", "】")
        .replace("**", "")
    )


class _StreamSanitizer:
    """跨 delta 的流式清理器：剥离模型偶发输出的 <think>…</think> 思考块
    （Qwen3.5 模板异常时可能出现），并规约分区标记装饰。标记可能被 delta
    切断，故对疑似前缀的尾部保持挂起，待下一段到达后裁决。"""

    _OPEN = "<think>"
    _CLOSE = "</think>"

    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False

    @staticmethod
    def _tail_overlap(s: str, tag: str) -> int:
        n = min(len(s), len(tag) - 1)
        for k in range(n, 0, -1):
            if s.endswith(tag[:k]):
                return k
        return 0

    def feed(self, delta: str) -> str:
        self._buf += delta
        out: list[str] = []
        while True:
            if self._in_think:
                i = self._buf.find(self._CLOSE)
                if i < 0:
                    keep = self._tail_overlap(self._buf, self._CLOSE)
                    self._buf = self._buf[len(self._buf) - keep:] if keep else ""
                    break
                self._buf = self._buf[i + len(self._CLOSE):]
                self._in_think = False
            else:
                i = self._buf.find(self._OPEN)
                if i < 0:
                    keep = self._tail_overlap(self._buf, self._OPEN)
                    cut = len(self._buf) - keep
                    out.append(self._buf[:cut])
                    self._buf = self._buf[cut:]
                    break
                out.append(self._buf[:i])
                self._buf = self._buf[i + len(self._OPEN):]
                self._in_think = True
        return _decorate("".join(out))

    def flush(self) -> str:
        rest, self._buf = self._buf, ""
        return "" if self._in_think else _decorate(rest)


def _find_glossary(db: Session, paper_id: int, term: str) -> GlossaryTerm | None:
    if not term:
        return None
    row = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == paper_id, GlossaryTerm.term == term)
        .first()
    )
    if row is None and term != term.lower():
        row = (
            db.query(GlossaryTerm)
            .filter(GlossaryTerm.paper_id == paper_id, GlossaryTerm.term == term.lower())
            .first()
        )
    return row


def _glossary_hits_text(db: Session, paper_id: int, budget: int = GLOSSARY_BUDGET_TOKENS) -> str:
    rows = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.paper_id == paper_id, GlossaryTerm.domain_translation.isnot(None))
        .order_by(func.coalesce(GlossaryTerm.confidence, 0).desc(), GlossaryTerm.id)
        .limit(8)
        .all()
    )
    parts: list[str] = []
    total = 0
    for r in rows:
        part = f"{r.term}={r.domain_translation}"
        t = _est_tokens(part)
        if total + t > budget:
            break
        parts.append(part)
        total += t
    return "; ".join(parts) or "（无）"


def _word_cache_get(db: Session, user_id: int, paper_id: int, lemma: str, engine: str) -> dict | None:
    row = (
        db.query(TranslationCache)
        .filter(
            TranslationCache.user_id == user_id,
            TranslationCache.paper_id == paper_id,
            TranslationCache.lemma == lemma,
            TranslationCache.engine == engine,
        )
        .order_by(TranslationCache.id.desc())
        .first()
    )
    if row is None:
        return None
    try:
        data = json.loads(row.result_json)
    except ValueError:
        return None
    data.setdefault("translation", "")
    return data


def _sentence_cache_get(db: Session, user_id: int, paper_id: int, text: str, engine: str) -> dict | None:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    row = (
        db.query(TranslationCache)
        .filter(
            TranslationCache.user_id == user_id,
            TranslationCache.paper_id == paper_id,
            TranslationCache.sentence_hash == h,
            TranslationCache.engine == engine,
        )
        .first()
    )
    if row is None:
        return None
    try:
        return json.loads(row.result_json)
    except ValueError:
        return None


def _cache_put(
    db: Session, user_id: int, paper_id: int, *, lemma: str | None,
    sentence_hash: str | None, engine: str, result: dict,
) -> None:
    row = None
    if lemma is not None:
        row = (
            db.query(TranslationCache)
            .filter(
                TranslationCache.user_id == user_id,
                TranslationCache.paper_id == paper_id,
                TranslationCache.lemma == lemma,
                TranslationCache.engine == engine,
            )
            .first()
        )
    elif sentence_hash is not None:
        row = (
            db.query(TranslationCache)
            .filter(
                TranslationCache.user_id == user_id,
                TranslationCache.paper_id == paper_id,
                TranslationCache.sentence_hash == sentence_hash,
            TranslationCache.engine == engine,
            )
            .first()
        )
    payload = json.dumps(result, ensure_ascii=False)
    if row is not None:
        row.result_json = payload
    else:
        db.add(TranslationCache(
            user_id=user_id, paper_id=paper_id, lemma=lemma, sentence_hash=sentence_hash,
            engine=engine, result_json=payload,
        ))
    db.commit()


HISTORY_KEEP = 50  # 每用户翻译历史保留条数（word/sentence/dict 共用）

def save_history(db: Session, user_id: int, *, word: str, mode: str,
                 result: dict, sentence: str | None = None) -> None:
    """查词历史落库：失败静默（历史是附属功能，绝不影响翻译主流程）。"""
    try:
        db.add(TranslateHistory(
            user_id=user_id, word=word, sentence=sentence, mode=mode,
            result=json.dumps(result, ensure_ascii=False), created_at=now_iso(),
        ))
        db.flush()  # 必需：session autoflush=False，无 flush 新行不可见致误删
        keep_ids = [
            r for (r,) in db.query(TranslateHistory.id)
            .filter(TranslateHistory.user_id == user_id)
            .order_by(TranslateHistory.id.desc())
            .limit(HISTORY_KEEP)
            .all()
        ]
        if keep_ids:
            db.query(TranslateHistory).filter(
                TranslateHistory.user_id == user_id,
                ~TranslateHistory.id.in_(keep_ids),
            ).delete(synchronize_session=False)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


SYSTEM_PROMPT = "你是学术翻译助手。只输出规定内容，不要解释。上下文仅供理解，不要翻译或输出它们。"


def word_prompt(paper: Paper, glossary: str, word: str, sentence: str, prev: str, nxt: str) -> str:
    lines = [f"论文标题: {_cut_head(paper.title or '', TITLE_BUDGET_TOKENS) or '（无）'}"]
    if glossary and glossary != "（无）":
        lines.append(f"本文术语表(节选): {glossary}")
    if sentence:
        lines.append(f"当前句: {sentence}")
    if prev:
        lines.append(f"上文: {prev}")
    if nxt:
        lines.append(f"下文: {nxt}")
    lines.append("")
    lines.append(f'解释单词 "{word}"，只输出两个分区：')
    lines.append("【基本义】该词的核心含义")
    lines.append("【文中意】结合上下文在本句中最贴切的中文译法（一句话）")
    lines.append("若上下文含公式或乱码，忽略噪声，按可辨识内容判断。")
    return "\n".join(lines)


def sentence_prompt(paper: Paper, glossary: str, text: str, prev: str, nxt: str) -> str:
    lines = [f"论文标题: {_cut_head(paper.title or '', TITLE_BUDGET_TOKENS) or '（无）'}"]
    if glossary and glossary != "（无）":
        lines.append(f"本文术语表(节选): {glossary}")
    if prev:
        lines.append(f"上文: {prev}")
    if nxt:
        lines.append(f"下文: {nxt}")
    lines.append("")
    lines.append("将下面的英文翻译为中文，只输出译文，不要解释：")
    lines.append(text)
    return "\n".join(lines)


WORD_FRAME_TOKENS = 120  # word 提示词固定文字 + word 本体（≤256 字符）缓冲
SENT_FRAME_TOKENS = 60  # sentence 提示词固定文字缓冲


def _fixed_tokens(glossary: str, title: str, frame: int) -> int:
    """提示词固定开销：system + 标题 + 术语表 + 框架文字，剩余预算全部留给上下文。"""
    return _est_tokens(SYSTEM_PROMPT) + _est_tokens(title) + _est_tokens(glossary) + frame


def _budget_contexts(*, fixed: int, sentence: str, prev: str, nxt: str) -> tuple[str, str, str]:
    """总输入预算内按权重分配：sentence 60%，prev/nxt 各 20%（辅助上下文，超限截断）。"""
    rest = max(0, INPUT_BUDGET_TOKENS - fixed)
    s = _cut_middle(sentence, max(0, int(rest * 0.6)))
    p = _cut_head(prev, max(0, int(rest * 0.2)))
    n = _cut_head(nxt, max(0, int(rest * 0.2)))
    return s, p, n


async def _stream_llm(request, messages: list[dict], max_tokens: int = 300) -> AsyncGenerator[tuple[str, str], None]:
    """驱动 LLM 流：yield (kind, text)；kind ∈ delta|ping；处理 ping 心跳、首 token
    超时与客户端断开（断开即终止生成，推理队列取下一任务）。"""
    # 冷加载等待放在首 token 计时窗之外（ensure_loaded 失败显式抛出，
    # 避免静默落入 chat_stream 内部二次等待）。
    # 等待期间每 LOAD_WAIT_PING 发 ping 保活：前端 SSE 看门狗 15s 无事件即掐流，
    # 2B 模型 mmap 冷起常超 15s，不保活则流死在加载窗内（ping 属既有契约，前端吞掉）。
    loaded = False
    load_task = asyncio.ensure_future(llm_service.ensure_loaded(LOAD_TIMEOUT))
    try:
        while True:
            try:
                loaded = await asyncio.wait_for(asyncio.shield(load_task), LOAD_WAIT_PING)
                break
            except asyncio.TimeoutError:
                if request is not None and await request.is_disconnected():
                    return
                yield "ping", ""
    finally:
        if not load_task.done():
            load_task.cancel()
            try:
                await load_task
            except (asyncio.CancelledError, Exception):
                pass
    if not loaded:
        raise LLMLoadingTimeout("模型加载超时或不可用")
    agen = llm_service.chat_stream(messages, max_tokens=max_tokens)
    started = time.monotonic()
    first = True
    fut: asyncio.Future | None = None
    try:
        while True:
            if fut is None:
                fut = asyncio.ensure_future(anext(agen))
            try:
                item = await asyncio.wait_for(asyncio.shield(fut), PING_INTERVAL)
            except asyncio.TimeoutError:
                if first and time.monotonic() - started >= FIRST_TOKEN_TIMEOUT:
                    raise LLMTimeout("LLM 首 token 超时")
                if request is not None and await request.is_disconnected():
                    return
                yield "ping", ""
                continue
            except StopAsyncIteration:
                break
            fut = None
            if request is not None and await request.is_disconnected():
                return
            if item["type"] == "delta":
                first = False
                yield "delta", item["text"]
    finally:
        if fut is not None and not fut.done():
            try:
                await asyncio.shield(fut)
            except Exception:
                pass
        await agen.aclose()


async def word_stream(db: Session, user_id: int, paper: Paper, body: dict, request) -> AsyncGenerator[str, None]:
    word = _strip_word(_clean(body.get("word") or ""))
    lemma = word.lower()
    sentence = _clean(body.get("sentence") or "")
    prev = _clean(body.get("prev") or "")
    nxt = _clean(body.get("next") or "")
    if len(word) > WORD_MAX_CHARS:
        yield sse_event("error", {
            "code": "text_too_long",
            "detail": f"选中文本过长（>{WORD_MAX_CHARS} 字符），请缩小选择范围后再查",
        })
        return
    invalid = _validate_word(word)
    if invalid is not None:
        yield sse_event("error", {"code": "word_invalid", "detail": invalid})
        return
    is_phrase = " " in word
    term_match = word if is_phrase else lemma

    try:
        glossary = _find_glossary(db, paper.id, term_match)
        word_row = None
        if not is_phrase:
            word_row = db.query(Word).filter(Word.user_id == user_id, Word.lemma == lemma).first()

        # ① 个人词库（source=user 修正优先；FR-4 要求且带译法才短路）
        if word_row is not None and word_row.translation:
            user_fix = glossary is not None and glossary.source == "user" and glossary.domain_translation
            translation = glossary.domain_translation if user_fix else word_row.translation
            hit = {"layer": "wordbook", "translation": translation or "", "stage": word_row.stage}
            if user_fix:
                hit["badge"] = "本文术语"
                hit["term"] = glossary.term
            yield sse_event("hit", hit)
            yield sse_event("done", {"layer": "wordbook", "cached": True})
            return

        # ② 本文术语表（需已有译法才出卡；预译留空的词划词时现查）
        if glossary is not None and glossary.domain_translation:
            yield sse_event("hit", {
                "layer": "glossary", "translation": glossary.domain_translation or "",
                "source": glossary.source, "term": glossary.term, "badge": "本文术语",
            })
            yield sse_event("done", {"layer": "glossary", "cached": True})
            return

        # ③ 翻译缓存
        engine = f"llm-{llm_service.model_id}"
        cached = _word_cache_get(db, user_id, paper.id, lemma, engine)
        if cached is not None:
            yield sse_event("hit", {"layer": "cache", **cached})
            yield sse_event("done", {"layer": "cache", "cached": True})
            return

        # ④ ECDICT 先出 + LLM 流式
        entry = None if is_phrase else ecdict_service.lookup(lemma)
        if entry is not None:
            yield sse_event("hit", {
                "layer": "ecdict", "pos": entry.get("pos"), "phonetic": entry.get("phonetic"),
                "gloss": entry.get("translation"), "lemma": entry.get("lemma"),
            })

        glossary_text = _glossary_hits_text(db, paper.id)
        title = _cut_head(paper.title or "", TITLE_BUDGET_TOKENS) or "（无）"
        fixed = _fixed_tokens(glossary_text if glossary_text != "（无）" else "", title, WORD_FRAME_TOKENS)
        sentence, prev, nxt = _budget_contexts(fixed=fixed, sentence=sentence, prev=prev, nxt=nxt)
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": word_prompt(paper, glossary_text, word, sentence, prev, nxt)},
        ]
        full = ""
        san = _StreamSanitizer()
        async for kind, text in _stream_llm(request, messages):
            if kind == "ping":
                yield sse_event("ping", {})
                continue
            piece = san.feed(text)
            if piece:
                full += piece
                yield sse_event("delta", {"text": piece})
        tail = san.flush()
        if tail:
            full += tail
            yield sse_event("delta", {"text": tail})
        if not full.strip():
            yield sse_event("error", {
                "code": "llm_empty",
                "detail": "模型未返回有效内容，可点击重试",
            })
            return
        engine = f"llm-{llm_service.model_id}"
        _cache_put(db, user_id, paper.id, lemma=lemma, sentence_hash=None,
                   engine=engine, result={"translation": full})
        save_history(db, user_id, word=lemma, mode="word",
                     result={"translation": full}, sentence=sentence or None)
        yield sse_event("done", {"engine": engine, "cached": False})
    except LLMLoadingTimeout as e:
        yield sse_event("error", {"code": "llm_loading_timeout", "detail": str(e)})
    except LLMInterrupted as e:
        # 中断（卸载/停止）的半截结果不得入缓存
        yield sse_event("error", {"code": "interrupted", "detail": str(e)})
    except LLMTimeout as e:
        yield sse_event("error", {"code": "llm_timeout", "detail": str(e)})
    except Exception as e:  # noqa: BLE001
        yield sse_event("error", {"code": "internal", "detail": str(e)})


async def sentence_stream(db: Session, user_id: int, paper: Paper, body: dict, request) -> AsyncGenerator[str, None]:
    text = _clean(body.get("text") or "")
    prev = _clean(body.get("prev") or "")
    nxt = _clean(body.get("next") or "")
    if not text:
        yield sse_event("error", {"code": "text_invalid", "detail": "未选中有效文本"})
        return
    try:
        glossary_text = _glossary_hits_text(db, paper.id)
        title = _cut_head(paper.title or "", TITLE_BUDGET_TOKENS) or "（无）"
        fixed = _fixed_tokens(glossary_text if glossary_text != "（无）" else "", title, SENT_FRAME_TOKENS)
        rest = max(0, INPUT_BUDGET_TOKENS - fixed)
        if _est_tokens(text) > int(rest * 0.7):
            yield sse_event("error", {"code": "text_too_long", "detail": "文本过长，请分段选择后再翻译"})
            return
        h = hashlib.sha256(text.encode("utf-8")).hexdigest()
        engine = f"llm-{llm_service.model_id}"
        cached = _sentence_cache_get(db, user_id, paper.id, text, engine)
        if cached is not None:
            yield sse_event("hit", {"layer": "cache", **cached})
            yield sse_event("done", {"layer": "cache", "cached": True})
            return
        prev = _cut_head(prev, max(0, int(rest * 0.15)))
        nxt = _cut_head(nxt, max(0, int(rest * 0.15)))
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": sentence_prompt(paper, glossary_text, text, prev, nxt)},
        ]
        full = ""
        san = _StreamSanitizer()
        async for kind, chunk in _stream_llm(request, messages, max_tokens=SENT_MAX_TOKENS):
            if kind == "ping":
                yield sse_event("ping", {})
                continue
            piece = san.feed(chunk)
            if piece:
                full += piece
                yield sse_event("delta", {"text": piece})
        tail = san.flush()
        if tail:
            full += tail
            yield sse_event("delta", {"text": tail})
        if not full.strip():
            yield sse_event("error", {
                "code": "llm_empty",
                "detail": "模型未返回有效译文，可点击重试",
            })
            return
        engine = f"llm-{llm_service.model_id}"
        _cache_put(db, user_id, paper.id, lemma=None, sentence_hash=h,
                   engine=engine, result={"translation": full})
        save_history(db, user_id, word=_cut_head(text, 80), mode="sentence",
                     result={"translation": full}, sentence=text)
        yield sse_event("done", {"engine": engine, "cached": False})
    except LLMLoadingTimeout as e:
        yield sse_event("error", {"code": "llm_loading_timeout", "detail": str(e)})
    except LLMInterrupted as e:
        # 中断（卸载/停止）的半截结果不得入缓存
        yield sse_event("error", {"code": "interrupted", "detail": str(e)})
    except LLMTimeout as e:
        yield sse_event("error", {"code": "llm_timeout", "detail": str(e)})
    except Exception as e:  # noqa: BLE001
        yield sse_event("error", {"code": "internal", "detail": str(e)})
