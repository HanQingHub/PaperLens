import json

from conftest import auth, register, sse_read, upload_pdf


def make_paper(client, token, tmp_path):
    return upload_pdf(client, token, tmp_path, pages=(("Generic filler text for the document",),))


def test_layer1_wordbook_hit(client, tmp_path):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "Attention", "sentence": "the attention is high"},
                      token)
    assert [e["event"] for e in events] == ["hit", "done"]
    assert events[0]["data"]["layer"] == "wordbook"
    assert events[0]["data"]["translation"] == "注意力"
    assert "badge" not in events[0]["data"]


def test_layer1_user_correction_overrides_wordbook(client, tmp_path):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    client.post("/api/words", json={"lemma": "transformer", "translation": "变压器"}, headers=auth(token))
    client.post("/api/glossary/terms",
                json={"paper_id": paper["id"], "term": "transformer", "domain_translation": "变换器"},
                headers=auth(token))
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "transformer", "sentence": "..."}, token)
    assert [e["event"] for e in events] == ["hit", "done"]
    data = events[0]["data"]
    assert data["layer"] == "wordbook"
    assert data["translation"] == "变换器"  # 修正优先
    assert data["badge"] == "本文术语"


def test_layer2_glossary_hit_with_badge(client, tmp_path):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    client.post("/api/glossary/terms",
                json={"paper_id": paper["id"], "term": "gradient", "domain_translation": "梯度（本文）"},
                headers=auth(token))
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "gradient", "sentence": "..."}, token)
    assert [e["event"] for e in events] == ["hit", "done"]
    data = events[0]["data"]
    assert data["layer"] == "glossary"
    assert data["badge"] == "本文术语"
    assert data["source"] == "user"


def test_layer3_cache_hit(client, tmp_path, data_dir):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    from app.core.db import SessionLocal
    from app.models import TranslationCache

    db = SessionLocal()
    try:
        db.add(TranslationCache(user_id=1, paper_id=paper["id"], lemma="zzzunknown",
                                engine="llm-x", result_json=json.dumps({"translation": "缓存译法"})))
        db.commit()
    finally:
        db.close()
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "zzzunknown", "sentence": "..."}, token)
    assert [e["event"] for e in events] == ["hit", "done"]
    assert events[0]["data"]["layer"] == "cache"
    assert events[0]["data"]["translation"] == "缓存译法"


def test_layer4_ecdict_then_llm_stream(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "attention", "sentence": "the attention mechanism"},
                      token)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "hit"
    assert events[0]["data"]["layer"] == "ecdict"
    assert "注意力" in events[0]["data"]["gloss"]
    assert "delta" in kinds
    assert kinds[-1] == "done"
    assert events[-1]["data"] == {"engine": "llm-fake-1b", "cached": False}
    deltas = "".join(e["data"]["text"] for e in events if e["event"] == "delta")
    assert deltas == "【本文译法】注意力机制。"


def test_llm_result_written_to_cache_then_layer3(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    body = {"paper_id": paper["id"], "word": "attention", "sentence": "s"}
    sse_read(client, "/api/translate/word", body, token)
    from app.core.db import SessionLocal
    from app.models import TranslationCache

    db = SessionLocal()
    try:
        rows = db.query(TranslationCache).filter(TranslationCache.lemma == "attention").all()
        assert len(rows) == 1
        assert json.loads(rows[0].result_json)["translation"] == "【本文译法】注意力机制。"
    finally:
        db.close()
    events = sse_read(client, "/api/translate/word", body, token)  # 二次查询走缓存
    assert events[0]["data"]["layer"] == "cache"
    assert [e["event"] for e in events] == ["hit", "done"]


def test_no_ecdict_entry_llm_only(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    kinds = [e["event"] for e in events]
    assert kinds[0] != "hit" or events[0]["data"].get("layer") != "ecdict"
    assert "delta" in kinds and kinds[-1] == "done"


def test_llm_loading_timeout_error(client, tmp_path, monkeypatch):
    from app.services.llm_service import LLMLoadingTimeout

    class Broken:
        state = "unloaded"
        model_id = None

        async def chat_stream(self, messages, max_tokens=300):
            raise LLMLoadingTimeout("加载超时")
            yield  # pragma: no cover - 使其成为异步生成器

    monkeypatch.setattr("app.services.translate_service.llm_service", Broken())
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "attention", "sentence": "s"}, token)
    err = [e for e in events if e["event"] == "error"]
    assert err and err[0]["data"]["code"] == "llm_loading_timeout"


def test_llm_timeout_error(client, tmp_path, monkeypatch):
    from app.services.llm_service import LLMTimeout

    class Broken:
        state = "ready"
        model_id = "x"

        async def chat_stream(self, messages, max_tokens=300):
            raise LLMTimeout("首 token 超时")
            yield  # pragma: no cover - 使其成为异步生成器

    monkeypatch.setattr("app.services.translate_service.llm_service", Broken())
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "attention", "sentence": "s"}, token)
    hits = [e for e in events if e["event"] == "hit"]
    assert hits and hits[0]["data"]["layer"] == "ecdict"  # ECDICT 内容保留
    err = [e for e in events if e["event"] == "error"]
    assert err and err[0]["data"]["code"] == "llm_timeout"


def test_first_token_deadline_raises_llm_timeout(client, tmp_path, monkeypatch):
    import asyncio

    monkeypatch.setattr("app.services.translate_service.PING_INTERVAL", 0.05)
    monkeypatch.setattr("app.services.translate_service.FIRST_TOKEN_TIMEOUT", 0.15)

    class SlowFirst:
        state = "ready"
        model_id = "slow"

        async def chat_stream(self, messages, max_tokens=300):
            await asyncio.sleep(0.4)
            yield {"type": "delta", "text": "late"}

    monkeypatch.setattr("app.services.translate_service.llm_service", SlowFirst())
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    err = [e for e in events if e["event"] == "error"]
    assert err and err[0]["data"]["code"] == "llm_timeout"


def test_ping_keepalive(client, tmp_path, monkeypatch):
    import asyncio

    monkeypatch.setattr("app.services.translate_service.PING_INTERVAL", 0.05)

    class SlowFake:
        state = "ready"
        model_id = "slow"

        async def chat_stream(self, messages, max_tokens=300):
            yield {"type": "delta", "text": "a"}
            await asyncio.sleep(0.25)
            yield {"type": "delta", "text": "b"}

    monkeypatch.setattr("app.services.translate_service.llm_service", SlowFake())
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    pings = [e for e in events if e["event"] == "ping"]
    assert len(pings) >= 2  # 10s 无事件 → ping（测试缩短为 0.1s）


def test_sentence_translate_and_cache(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    body = {"paper_id": paper["id"], "text": "The model learns fast.", "prev": "", "next": ""}
    events = sse_read(client, "/api/translate/sentence", body, token)
    kinds = [e["event"] for e in events]
    assert "delta" in kinds and kinds[-1] == "done"
    assert events[-1]["data"]["cached"] is False
    # 二次命中句译缓存
    events = sse_read(client, "/api/translate/sentence", body, token)
    assert [e["event"] for e in events] == ["hit", "done"]
    assert events[0]["data"]["layer"] == "cache"


def test_word_not_owned_paper_404(client, tmp_path):
    ta = register(client, "alice")
    tb = register(client, "bob")
    paper = make_paper(client, ta, tmp_path)
    r = client.post("/api/translate/word",
                    json={"paper_id": paper["id"], "word": "attention", "sentence": "s"},
                    headers=auth(tb))
    assert r.status_code == 404


def test_word_too_long_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "x" * 200, "sentence": "s"}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "text_too_long"
    assert fake_llm.calls == []  # 未触发 LLM


def test_sentence_too_long_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/sentence",
                      {"paper_id": paper["id"], "text": "word " * 3000, "prev": "", "next": ""}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "text_too_long"
    assert fake_llm.calls == []


def test_context_cleaned_before_llm(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry",
                       "sentence": "long hyphen-\nated text\x01 with\nlines", "prev": "", "next": ""}, token)
    assert "delta" in [e["event"] for e in events]
    user = fake_llm.calls[0][1]["content"]
    cur = user.split("当前句: ", 1)[1].split("\n", 1)[0]
    assert "hyphenated" in cur  # 连字断行修复
    assert "\x01" not in cur  # 控制字符剥离
    assert "\n" not in cur  # 换行已折叠


def test_context_budget_truncated(client, tmp_path, fake_llm):
    from app.services.translate_service import _est_tokens

    token = register(client)
    paper = make_paper(client, token, tmp_path)
    long_sentence = "word " * 5000  # 20000 字符，远超预算
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry",
                       "sentence": long_sentence, "prev": "x" * 5000, "next": "y" * 5000}, token)
    assert "delta" in [e["event"] for e in events]
    user = fake_llm.calls[0][1]["content"]
    assert "…" in user  # 被保头尾截断
    sys_prompt = fake_llm.calls[0][0]["content"]
    total = _est_tokens(sys_prompt) + _est_tokens(user)
    assert total <= 1000


# ---- 边界处理：怪文本 / 噪声 / 模型异常输出 ----

def test_unit_clean_normalizes_noise():
    from app.services.translate_service import _clean

    assert _clean("ﬁne\u200b") == "fine"  # 连字 ﬁ→fi + 零宽空格
    assert _clean("ＡＴtention") == "ATtention"  # 全角→半角
    assert _clean("soft\xadhyphen") == "softhyphen"  # 软连字符
    assert _clean("a\u202eb") == "ab"  # 双向控制符


def test_word_quoted_punctuation_stripped(client, tmp_path):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "“Attention,”", "sentence": "s"}, token)
    assert [e["event"] for e in events] == ["hit", "done"]
    assert events[0]["data"]["layer"] == "wordbook"  # 引号逗号剥离后命中词库


def test_ligature_word_reaches_llm_normalized(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "ﬁne", "sentence": "s"}, token)
    assert "delta" in [e["event"] for e in events]
    assert '解释单词 "fine"' in fake_llm.calls[0][1]["content"]


def test_pure_number_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "3.14%", "sentence": "s"}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "word_invalid"
    assert fake_llm.calls == []


def test_cjk_word_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "注意力机制", "sentence": "s"}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "word_invalid"
    assert fake_llm.calls == []


def test_blank_word_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "  “” ", "sentence": "s"}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "word_invalid"


def test_unit_stream_sanitizer_split_tags():
    from app.services.translate_service import _StreamSanitizer

    s = _StreamSanitizer()
    out = s.feed("a<th") + s.feed("ink>b</th") + s.feed("ink>c")
    assert out + s.flush() == "ac"  # <think>…</think> 跨 3 段被完整剥离


def test_unit_stream_sanitizer_unclosed_think_dropped():
    from app.services.translate_service import _StreamSanitizer

    s = _StreamSanitizer()
    out = s.feed("ok<think>still thinking")
    assert out == "ok"
    assert s.flush() == ""  # 流结束未闭合 → 思考内容全部丢弃


def test_llm_think_and_decoration_stripped(client, tmp_path, monkeypatch):
    from conftest import FakeLLM

    fake = FakeLLM(chunks=["<think>reasoning…</think>", "**【基", "本义】**测试**内容**"])
    monkeypatch.setattr("app.services.translate_service.llm_service", fake)
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    deltas = "".join(e["data"]["text"] for e in events if e["event"] == "delta")
    assert deltas == "【基本义】测试内容"
    assert [e["event"] for e in events][-1] == "done"


def test_llm_empty_output_error_and_no_cache(client, tmp_path, monkeypatch):
    from conftest import FakeLLM

    fake = FakeLLM(chunks=["<think>only thinks</think>"])
    monkeypatch.setattr("app.services.translate_service.llm_service", fake)
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    assert [e["event"] for e in events][-1] == "error"
    assert events[-1]["data"]["code"] == "llm_empty"
    from app.core.db import SessionLocal
    from app.models import TranslationCache

    db = SessionLocal()
    try:
        assert db.query(TranslationCache).filter(TranslationCache.lemma == "qqqnoentry").count() == 0
    finally:
        db.close()


def test_sentence_blank_rejected(client, tmp_path, fake_llm):
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    events = sse_read(client, "/api/translate/sentence",
                      {"paper_id": paper["id"], "text": "  \u200b ", "prev": "", "next": ""}, token)
    assert [e["event"] for e in events] == ["error"]
    assert events[0]["data"]["code"] == "text_invalid"
    assert fake_llm.calls == []


def test_max_tokens_forwarded_word_vs_sentence(client, tmp_path, monkeypatch):
    from conftest import FakeLLM

    seen = []

    class Recorder(FakeLLM):
        async def chat_stream(self, messages, max_tokens=300):
            seen.append(max_tokens)
            async for item in super().chat_stream(messages, max_tokens=max_tokens):
                yield item

    monkeypatch.setattr("app.services.translate_service.llm_service", Recorder())
    token = register(client)
    paper = make_paper(client, token, tmp_path)
    sse_read(client, "/api/translate/word",
             {"paper_id": paper["id"], "word": "qqqnoentry", "sentence": "s"}, token)
    sse_read(client, "/api/translate/sentence",
             {"paper_id": paper["id"], "text": "Hello world.", "prev": "", "next": ""}, token)
    assert seen == [300, 500]
