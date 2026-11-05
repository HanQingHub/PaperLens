"""提示词产出归一（三分区解析 / 句译清洗）单测。"""
from app.services.translate_service import (
    normalize_sentence_output,
    normalize_word_output,
    sentence_prompt,
    word_prompt,
)


class _P:
    title = "Just-in-Time Harness"


def test_word_output_canonical():
    raw = "【词性】n.\n【基本义】注意力；关注\n【文中意】注意力机制"
    assert normalize_word_output(raw) == raw


def test_word_output_aliases_and_markdown():
    raw = "**词性：** n.\n## 【本文译法】## 注意力机制\n- 【释义】注意；关注"
    out = normalize_word_output(raw)
    assert "【词性】n." in out
    assert "【文中意】注意力机制" in out
    assert "【基本义】注意；关注" in out
    assert "**" not in out and "##" not in out


def test_word_output_missing_context_section_falls_back_to_gloss():
    raw = "【基本义】梯度；斜率"
    out = normalize_word_output(raw)
    assert "【文中意】梯度" in out


def test_word_output_plain_text_passthrough():
    raw = "注意力机制"
    assert normalize_word_output(raw) == "注意力机制"


def test_word_output_multiline_gloss_merged():
    raw = "【词性】n.\n【基本义】注意\n关注\n【文中意】注意力"
    out = normalize_word_output(raw)
    assert "【基本义】注意 关注" in out


def test_sentence_output_strips_prefix_and_quotes():
    raw = "译文： “本文提出一种新的注意力机制。”"
    assert normalize_sentence_output(raw) == "本文提出一种新的注意力机制。"


def test_sentence_output_drops_echoed_source():
    raw = "原文：We propose X.\n译文：我们提出 X。"
    assert normalize_sentence_output(raw) == "我们提出 X。"


def test_sentence_output_keeps_inner_quotes_and_citations():
    raw = "模型被称为“元代理”，在 [12] 中验证。"
    assert normalize_sentence_output(raw) == raw


def test_prompts_keep_glossary_and_context():
    wp = word_prompt(_P, "harness=执行外壳", "harness", "The harness rewrites itself.", "prev", "next")
    assert "harness=执行外壳" in wp
    assert "当前句: The harness rewrites itself." in wp
    assert "【文中意】" in wp
    sp = sentence_prompt(_P, "harness=执行外壳", "The harness rewrites itself.", "", "")
    assert "只输出中文译文" in sp
    assert "The harness rewrites itself." in sp


def test_force_flag_skips_shortcut_layers(client, tmp_path, fake_llm):
    """force=1 必须跳过词库/术语表/缓存，走 LLM（AI 重译通路）。"""
    from conftest import auth, register, upload_pdf, sse_read

    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    client.post("/api/glossary/terms",
                json={"paper_id": paper["id"], "term": "harness", "domain_translation": "驾驭"},
                headers=auth(token))
    normal = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "harness", "sentence": "a harness here"}, token)
    assert normal[0]["data"]["layer"] == "glossary"
    forced = sse_read(client, "/api/translate/word",
                      {"paper_id": paper["id"], "word": "harness", "sentence": "a harness here", "force": 1}, token)
    kinds = [e["event"] for e in forced]
    assert "delta" in kinds
    # 命中层被跳过：首个事件不是术语表 hit（可能直接进 delta / ECDICT）
    assert not any(e["data"].get("layer") == "glossary" for e in forced)
