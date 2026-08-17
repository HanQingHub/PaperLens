from datetime import datetime, timezone

from app.services.sm2_service import sm2_update


def fixed(dt: datetime) -> datetime:
    return dt


NOW = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_first_review_q5_interval1():
    r = sm2_update(2.5, 0, 5, now=NOW)
    assert r["interval"] == 1
    assert r["ease"] == 2.6
    assert r["due_at"].startswith("2026-08-02")


def test_second_review_q5_interval6():
    r = sm2_update(2.6, 1, 5, now=NOW)
    assert r["interval"] == 6
    assert r["ease"] == 2.7


def test_third_review_q5_multiplies_ef():
    r = sm2_update(2.7, 6, 5, now=NOW)
    assert r["ease"] == 2.8
    assert r["interval"] == round(6 * 2.8)  # 17


def test_q2_resets_interval_and_drops_ef():
    r = sm2_update(2.5, 21, 2, now=NOW)
    assert r["interval"] == 1
    assert abs(r["ease"] - 2.18) < 1e-9  # 2.5 - 0.32


def test_q3_ef_change():
    r = sm2_update(2.5, 6, 3, now=NOW)
    assert abs(r["ease"] - 2.36) < 1e-9  # 2.5 - 0.14
    assert r["interval"] == round(6 * 2.36)  # 14


def test_ef_floor_1_3():
    ease = 1.35
    for _ in range(5):
        ease = sm2_update(ease, 10, 2, now=NOW)["ease"]
    assert ease == 1.3


def test_due_at_uses_injected_clock():
    r = sm2_update(2.5, 0, 5, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    assert r["due_at"].startswith("2030-01-02")


def test_invalid_q_rejected():
    import pytest

    with pytest.raises(ValueError):
        sm2_update(2.5, 0, 1, now=NOW)
    with pytest.raises(ValueError):
        sm2_update(2.5, 0, 4.5, now=NOW)


def test_review_endpoint_writes_log_and_stage(client):
    from conftest import auth, register

    token = register(client)
    r = client.post("/api/words", json={"lemma": "attention", "translation": "注意力"}, headers=auth(token))
    word_id = r.json()["id"]
    r = client.post(f"/api/words/{word_id}/review", json={"q": 5}, headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["interval"] == 1
    assert body["next_due"]

    from app.core.db import SessionLocal
    from app.models import ReviewLog, Word

    db = SessionLocal()
    try:
        log = db.query(ReviewLog).one()
        assert log.q == 5
        assert log.prev_interval == 0
        assert log.next_interval == 1
        w = db.get(Word, word_id)
        assert w.review_count == 1
        assert w.ease == 2.6
    finally:
        db.close()


def test_review_q2_lowers_stage_floor0(client):
    from conftest import auth, register

    token = register(client)
    r = client.post("/api/words", json={"lemma": "network", "translation": "网络"}, headers=auth(token))
    word_id = r.json()["id"]
    client.patch(f"/api/words/{word_id}", json={"stage": 1}, headers=auth(token))
    client.post(f"/api/words/{word_id}/review", json={"q": 2}, headers=auth(token))
    r = client.get("/api/words", headers=auth(token))
    assert r.json()[0]["stage"] == 0
    client.post(f"/api/words/{word_id}/review", json={"q": 2}, headers=auth(token))
    r = client.get("/api/words", headers=auth(token))
    assert r.json()[0]["stage"] == 0  # 不低于 0


def test_review_invalid_q(client):
    from conftest import auth, register

    token = register(client)
    r = client.post("/api/words", json={"lemma": "go"}, headers=auth(token))
    word_id = r.json()["id"]
    r = client.post(f"/api/words/{word_id}/review", json={"q": 4}, headers=auth(token))
    assert r.status_code == 400
