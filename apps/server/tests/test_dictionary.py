from conftest import auth, register


def test_direct_lookup(client):
    token = register(client)
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["pos"] == "n."
    assert "注意" in body["translation"]
    assert body["lemma"] is None


def test_lemma_reduction_via_exchange(client):
    token = register(client)
    r = client.get("/api/dictionary/studies", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["lemma"] == "study"  # exchange 0=study


def test_lemma_reduction_via_lemmas_table(client):
    token = register(client)
    r = client.get("/api/dictionary/went", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["lemma"] == "go"
    assert body["translation"] == "去"


def test_missing_word_404(client):
    token = register(client)
    r = client.get("/api/dictionary/qqqqzzzz", headers=auth(token))
    assert r.status_code == 404


def test_missing_ecdict_db_graceful(client, data_dir):
    import os

    os.remove(data_dir / "ecdict.db")
    from app.services import ecdict_service

    ecdict_service.reset()
    token = register(client)
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 404  # 词典缺失优雅降级


def test_lookup_case_insensitive(client):
    token = register(client)
    for w in ["ATTENTION", "Attention", "aTtEnTiOn", " attention ", "  Attention  "]:
        r = client.get(f"/api/dictionary/{w}", headers=auth(token))
        assert r.status_code == 200, f"case {w!r} => {r.text}"
        assert "注意" in r.json()["translation"]


def test_lookup_with_whitespace_and_punct_stripping(client):
    # translate_service 对划词首尾剥离引号/标点，但 dictionary 层对空白归一
    token = register(client)
    r = client.get("/api/dictionary/ studies ", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["lemma"] == "study"
    # 前后空白+大小写
    r = client.get("/api/dictionary/  STUDIES  ", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["lemma"] == "study"


def test_lookup_blank_and_pure_symbol_404(client):
    token = register(client)
    for w in ["", "   ", "3.14%"]:
        # 空串由 FastAPI 路由 404（路径参数缺失），纯符号走词典未收录
        if not w.strip():
            r = client.get("/api/dictionary/%20%20", headers=auth(token))
            assert r.status_code in (404, 422)
        else:
            r = client.get(f"/api/dictionary/{w}", headers=auth(token))
            assert r.status_code == 404


def test_lemmas_exchange_fallback(client, data_dir):
    import sqlite3

    from app.services import ecdict_service

    # 构造 exchange 缺失但 lemmas 命中的词（avoid duplicate key in conftest）
    con = sqlite3.connect(data_dir / "ecdict.db")
    con.execute("INSERT INTO dictionary(word,pos,phonetic,translation,collins_star,tag,exchange) VALUES (?,?,?,?,?,?,?)",
                ("run", "v.", None, "跑步", 0, "", ""))
    con.execute("INSERT INTO lemmas(word,lemma) VALUES (?,?)", ("running", "run"))
    con.commit()
    con.close()
    ecdict_service.reset()
    token = register(client)
    r = client.get("/api/dictionary/running", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["lemma"] == "run"
    assert "跑步" in r.json()["translation"]


def test_bundled_fallback_when_data_missing(client, data_dir, tmp_path, monkeypatch):
    import os
    import sqlite3

    from app.core.config import get_settings
    from app.services import ecdict_service
    from conftest import make_mini_ecdict

    bundled = tmp_path / "bundled_ecdict.db"
    make_mini_ecdict(bundled)
    # 额外写入一个仅 bundled 存在的词
    con = sqlite3.connect(bundled)
    con.execute("INSERT INTO dictionary(word,pos,phonetic,translation,collins_star,tag,exchange) VALUES (?,?,?,?,?,?,?)",
                ("bundledonly", "n.", None, "仅捆绑", 0, "", ""))
    con.commit()
    con.close()

    # 移除 data_dir 的 ecdict，环境指向 bundled
    os.remove(data_dir / "ecdict.db")
    monkeypatch.setenv("PAPERLENS_ECDICT_PATH", str(bundled))
    get_settings.cache_clear()
    ecdict_service.reset()

    token = register(client)
    # data 缺失但 bundled 兜底应命中
    r = client.get("/api/dictionary/bundledonly", headers=auth(token))
    assert r.status_code == 200
    assert "仅捆绑" in r.json()["translation"]
    # 原词仍可通过 bundled 兜底
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 200

    monkeypatch.delenv("PAPERLENS_ECDICT_PATH", raising=False)
    get_settings.cache_clear()
    ecdict_service.reset()


def test_verbatim_path_lookup(client, data_dir, tmp_path, monkeypatch):
    import os

    from app.core.config import get_settings
    from app.services import ecdict_service
    from conftest import make_mini_ecdict

    # 用 verbatim 前缀注入 bundled 路径（正确前缀为 \\?\ 4 字符）
    bundled = tmp_path / "verbatim_ecdict.db"
    make_mini_ecdict(bundled)
    verbatim = "\\\\?\\" + str(bundled)
    os.remove(data_dir / "ecdict.db")
    monkeypatch.setenv("PAPERLENS_ECDICT_PATH", verbatim)
    get_settings.cache_clear()
    ecdict_service.reset()
    token = register(client)
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 200, f"verbatim lookup failed: {r.text}"
    monkeypatch.delenv("PAPERLENS_ECDICT_PATH", raising=False)
    get_settings.cache_clear()
    ecdict_service.reset()


def test_tried_retry_after_reset(client, data_dir):
    import os

    from app.services import ecdict_service

    # 先删库导致 _connect 返回 None（历史 _tried 锁会永久 404）
    os.remove(data_dir / "ecdict.db")
    ecdict_service.reset()
    token = register(client)
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 404
    # 重建库 + reset 后应自愈（验证删除 _tried 永久锁后可重试）
    from conftest import make_mini_ecdict

    make_mini_ecdict(data_dir / "ecdict.db")
    ecdict_service.reset()
    r = client.get("/api/dictionary/attention", headers=auth(token))
    assert r.status_code == 200


def test_translation_none_returns_404_for_bare_lemma(client, data_dir):
    import sqlite3

    from app.services import ecdict_service

    con = sqlite3.connect(data_dir / "ecdict.db")
    con.execute("INSERT INTO lemmas(word,lemma) VALUES (?,?)", ("orphanword", "ghostlemma"))
    con.commit()
    con.close()
    ecdict_service.reset()
    token = register(client)
    # lemmas 命中但 dictionary 无该 lemma 行 → lookup 返回 translation None → API 404
    r = client.get("/api/dictionary/orphanword", headers=auth(token))
    assert r.status_code == 404
