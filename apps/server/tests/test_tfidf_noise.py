"""术语表自举的噪声过滤（URL/作者姓氏/单复数/低频）。"""
from app.services.tfidf_service import tfidf_top30


def _pages(*texts):
    return list(texts)


def test_urls_and_venues_filtered():
    pages = _pages(
        "https://arxiv.org/abs/2608.25993v1 https://github.com/HanQingHub/JIT copyright 2026",
        "https://arxiv.org/abs/2608.25993v1 https://github.com/HanQingHub/JIT copyright 2026",
    )
    terms = [t for t, _ in tfidf_top30(pages)]
    for bad in ("https", "arxiv", "org", "github", "copyright", "www"):
        assert bad not in terms


def test_author_surnames_filtered_but_lowercase_concepts_kept():
    pages = _pages(
        "Zhang et al. show the harness works. Liu and Wang agree. Chen also reports.",
        "Zhang et al. show the harness works. Liu and Wang agree. Chen also reports.",
    )
    terms = [t for t, _ in tfidf_top30(pages)]
    assert "harness" in terms
    for name in ("zhang", "liu", "wang", "chen"):
        assert name not in terms


def test_acronym_and_method_names_kept():
    pages = _pages(
        "We use RAG and LLM baselines. JIT-Agent beats GPT-4o on QA.",
        "We use RAG and LLM baselines. JIT-Agent beats GPT-4o on QA.",
    )
    terms = [t for t, _ in tfidf_top30(pages)]
    assert "rag" in terms and "llm" in terms
    assert any("jit-agent" == t for t in terms)


def test_singletons_and_plurals_dropped():
    pages = _pages(
        "harness harness harnesses harnesses rareword",
        "harness harness harnesses harnesses",
    )
    terms = [t for t, _ in tfidf_top30(pages)]
    assert "rareword" not in terms
    assert "harness" in terms
    assert "harnesses" not in terms


def test_parse_terms_json_variants():
    from app.services.tfidf_service import _parse_terms_json

    assert _parse_terms_json('[{"term":"harness","zh":"执行外壳"}]') == {"harness": "执行外壳"}
    # 漏括号（被截断）
    assert _parse_terms_json('{"term":"agent","zh":"智能体"},')["agent"] == "智能体"
    # 逐行 "1. term: 译名" 兜底
    out = _parse_terms_json("1. harness: 执行外壳\n2. agent：智能体")
    assert out["harness"] == "执行外壳" and out["agent"] == "智能体"
    # 完全无法解析 → 空字典（调用方跳过该批，不抛错）
    assert _parse_terms_json("抱歉，我无法完成") == {}
