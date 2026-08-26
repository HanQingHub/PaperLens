from conftest import auth, register, upload_pdf


def test_update_profile_display_name(client):
    token = register(client)
    r = client.patch("/api/auth/profile", json={"display_name": "  研究者甲  "}, headers=auth(token))
    assert r.status_code == 200
    assert r.json()["display_name"] == "研究者甲"
    me = client.get("/api/me", headers=auth(token)).json()
    assert me["user"]["display_name"] == "研究者甲"


def test_update_profile_rejects_blank_and_overlong(client):
    token = register(client)
    r = client.patch("/api/auth/profile", json={"display_name": "   "}, headers=auth(token))
    assert r.status_code == 422
    r = client.patch("/api/auth/profile", json={"display_name": "字" * 31}, headers=auth(token))
    assert r.status_code == 422


def test_paper_annotation_count_and_tag_search(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    pid = paper["id"]
    # 打标签
    r = client.patch(f"/api/papers/{pid}", json={"tags": ["survey", "transformer"]}, headers=auth(token))
    assert r.status_code == 200
    # 建一条批注（word_note 类型）
    r = client.post(f"/api/papers/{pid}/annotations", headers=auth(token), json={
        "page_no": 1, "type": "word_note",
        "anchor_json": '{"rects": [[0, 0, 10, 10]]}', "color": "yellow", "text": "笔记",
    })
    assert r.status_code in (200, 201), r.text
    rows = client.get("/api/papers", headers=auth(token)).json()
    row = next(p for p in rows if p["id"] == pid)
    assert row["annotation_count"] == 1
    assert row["tags"] == ["survey", "transformer"]
    # q 搜索命中标签
    rows = client.get("/api/papers", params={"q": "transformer"}, headers=auth(token)).json()
    assert any(p["id"] == pid for p in rows)
    # tag 过滤
    rows = client.get("/api/papers", params={"tag": "survey"}, headers=auth(token)).json()
    assert any(p["id"] == pid for p in rows)


def test_export_annotations_filter(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    pid = paper["id"]
    client.post(f"/api/papers/{pid}/annotations", headers=auth(token), json={
        "page_no": 1, "type": "word_note",
        "anchor_json": '{"rects": [[0, 0, 10, 10]]}', "color": "yellow", "text": "黄笔记",
    })
    client.post(f"/api/papers/{pid}/annotations", headers=auth(token), json={
        "page_no": 1, "type": "sentence",
        "anchor_json": '{"rects": [[0, 20, 60, 30]]}', "color": "blue", "text": "蓝高亮",
    })
    r = client.post(f"/api/papers/{pid}/export-annotations-md", params={"color": "yellow"}, headers=auth(token))
    assert r.status_code == 200
    assert "黄笔记" in r.text and "蓝高亮" not in r.text
    r = client.post(f"/api/papers/{pid}/export-annotations-md", params={"type": "sentence"}, headers=auth(token))
    assert r.status_code == 200
    assert "蓝高亮" in r.text and "黄笔记" not in r.text
    r = client.post(f"/api/papers/{pid}/export-annotations-md", params={"color": "black"}, headers=auth(token))
    assert r.status_code == 400


def test_word_group_flow(client):
    token = register(client)
    h = auth(token)
    w = client.post("/api/words", json={"lemma": "attention", "translation": "注意", "group_name": "精读"}, headers=h).json()
    assert w["group_name"] == "精读"
    # 分组列表
    groups = client.get("/api/words/groups", headers=h).json()
    assert {"name": "精读", "count": 1} in groups
    # 组筛选
    rows = client.get("/api/words", params={"group": "精读"}, headers=h).json()
    assert [r["lemma"] for r in rows] == ["attention"]
    rows = client.get("/api/words", params={"group": ""}, headers=h).json()
    assert rows == []
    # 移出分组（空串）
    r = client.patch(f"/api/words/{w['id']}", json={"group_name": ""}, headers=h).json()
    assert r["group_name"] is None
    # 入库时未带组 → 未分组
    w2 = client.post("/api/words", json={"lemma": "gradient"}, headers=h).json()
    assert w2["group_name"] is None


def test_translate_history_endpoint(client, tmp_path):
    """历史表读写：直查词典（dict 模式）自动落历史并可回看。"""
    token = register(client)
    h = auth(token)
    upload_pdf(client, token, tmp_path)
    # ECDICT mini 词表里有 attention
    r = client.get("/api/dictionary/attention", headers=h)
    assert r.status_code == 200
    hist = client.get("/api/translate/history", headers=h).json()
    assert len(hist) == 1
    assert hist[0]["word"] == "attention"
    assert hist[0]["mode"] == "dict"
    assert "注意" in hist[0]["result"].get("gloss", "")
