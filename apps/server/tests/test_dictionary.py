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
