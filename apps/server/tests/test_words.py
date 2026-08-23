from conftest import auth, register, upload_pdf


def test_add_word_with_occurrence(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post("/api/words",
                    json={"lemma": "Attention", "translation": "注意力", "paper_id": paper["id"],
                          "sentence": "the attention mechanism", "context": "prev / next"},
                    headers=auth(token))
    assert r.status_code == 201
    body = r.json()
    assert body["lemma"] == "attention"  # 归一化
    assert body["stage"] == 0
    from app.core.db import SessionLocal
    from app.models import WordOccurrence

    db = SessionLocal()
    try:
        occ = db.query(WordOccurrence).one()
        assert occ.sentence == "the attention mechanism"
    finally:
        db.close()


def test_add_same_lemma_updates_not_duplicates(client):
    token = register(client)
    client.post("/api/words", json={"lemma": "attention", "translation": "注意"}, headers=auth(token))
    r = client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    assert r.status_code == 201
    rows = client.get("/api/words", headers=auth(token)).json()
    assert len(rows) == 1
    assert rows[0]["translation"] == "注意力"


def test_list_filters_stage_q_due(client):
    token = register(client)
    ids = []
    for lemma, stage in (("attention", 0), ("network", 1), ("gradient", 2)):
        r = client.post("/api/words", json={"lemma": lemma, "translation": "t"}, headers=auth(token))
        ids.append(r.json()["id"])
        if stage:
            client.patch(f"/api/words/{r.json()['id']}", json={"stage": stage}, headers=auth(token))
    r = client.get("/api/words", params={"stage": 1}, headers=auth(token))
    assert [w["lemma"] for w in r.json()] == ["network"]
    r = client.get("/api/words", params={"q": "atten"}, headers=auth(token))
    assert [w["lemma"] for w in r.json()] == ["attention"]
    # 到期队列：无到期词
    r = client.get("/api/words", params={"due": 1}, headers=auth(token))
    assert r.json() == []
    # 复习后的词 due 在未来，手动置为过期后进入到期队列
    client.post(f"/api/words/{ids[0]}/review", json={"q": 5}, headers=auth(token))
    from app.core.db import SessionLocal
    from app.models import Word

    db = SessionLocal()
    try:
        db.query(Word).filter(Word.id == ids[0]).update({"due_at": "2000-01-01T00:00:00+00:00"})
        db.commit()
    finally:
        db.close()
    r = client.get("/api/words", params={"due": 1}, headers=auth(token))
    assert [w["lemma"] for w in r.json()] == ["attention"]


def test_patch_and_delete_word(client):
    token = register(client)
    r = client.post("/api/words", json={"lemma": "go", "translation": "去"}, headers=auth(token))
    wid = r.json()["id"]
    r = client.patch(f"/api/words/{wid}", json={"stage": 2, "translation": "去（已掌握）"}, headers=auth(token))
    assert r.json()["stage"] == 2
    r = client.patch(f"/api/words/{wid}", json={"stage": 9}, headers=auth(token))
    assert r.status_code == 400
    r = client.delete(f"/api/words/{wid}", headers=auth(token))
    assert r.status_code == 204
    assert client.get("/api/words", headers=auth(token)).json() == []


def test_export_csv_with_bom(client):
    token = register(client)
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    r = client.get("/api/words/export", params={"format": "csv"}, headers=auth(token))
    assert r.status_code == 200
    assert r.content.startswith(b"\xef\xbb\xbf")  # UTF-8 BOM
    text = r.content.decode("utf-8-sig")
    assert "attention" in text and "注意力" in text


def test_export_anki_tsv(client):
    token = register(client)
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    r = client.get("/api/words/export", params={"format": "anki"}, headers=auth(token))
    assert r.status_code == 200
    text = r.content.decode("utf-8")
    assert text.startswith("#separator:tab")
    assert "attention\t注意力" in text


def test_word_isolation(client):
    ta = register(client, "alice")
    tb = register(client, "bob")
    client.post("/api/words", json={"lemma": "attention"}, headers=auth(ta))
    assert client.get("/api/words", headers=auth(tb)).json() == []
    r = client.post("/api/words", json={"lemma": "attention", "translation": "x"}, headers=auth(tb))
    assert r.status_code == 201
