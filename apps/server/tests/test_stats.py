from datetime import timedelta

from conftest import auth, register, upload_pdf

from app.core.util import utc_now


def iso(dt):
    return dt.isoformat(timespec="microseconds")


def post_session(client, token, paper_id, start, end):
    return client.post("/api/reading-sessions",
                       json={"paper_id": paper_id, "start_at": iso(start), "end_at": iso(end)},
                       headers=auth(token))


def test_stats_empty(client):
    token = register(client)
    r = client.get("/api/stats/overview", headers=auth(token))
    body = r.json()
    assert body["today_s"] == 0
    assert body["total_s"] == 0
    assert body["streak"] == 0
    assert len(body["calendar"]) == 30
    assert len(body["words_new_7d"]) == 7


def test_stats_today_and_total(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    # 服务器按用户本地时区分桶（stats_service._local_date 转 astimezone().date()），
    # 会话时间必须锚定本地日界生成——用 utc_now() 偏移在本地 0-8 点时段会整段落
    # 前一天（today_s 归零、streak 断裂），日界相对取数可全天候稳定
    today_local = utc_now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = today_local + timedelta(minutes=1)
    post_session(client, token, paper["id"], today_start, today_start + timedelta(minutes=10))
    yesterday_start = today_local - timedelta(days=1) + timedelta(minutes=1)
    post_session(client, token, paper["id"], yesterday_start, yesterday_start + timedelta(minutes=5))
    r = client.get("/api/stats/overview", headers=auth(token))
    body = r.json()
    assert body["today_s"] == 600
    assert body["total_s"] == 900
    today_iso = today_local.date().isoformat()
    assert [c for c in body["calendar"] if c["date"] == today_iso][0]["seconds"] == 600
    assert body["streak"] == 2


def test_stats_words_new_7d(client):
    token = register(client)
    now = utc_now()
    for i, lemma in enumerate(("aaa", "bbb", "ccc")):
        client.post("/api/words", json={"lemma": lemma, "translation": "t"}, headers=auth(token))
    r = client.get("/api/stats/overview", headers=auth(token))
    body = r.json()
    # 同上方：words_new_7d 亦按本地日期分桶
    today_entry = [w for w in body["words_new_7d"] if w["date"] == now.astimezone().date().isoformat()][0]
    assert today_entry["count"] == 3
    assert sum(w["count"] for w in body["words_new_7d"]) == 3


def test_stats_review_done_and_due(client, tmp_path):
    token = register(client)
    upload_pdf(client, token, tmp_path)
    for lemma in ("aaa", "bbb"):
        client.post("/api/words", json={"lemma": lemma, "translation": "t"}, headers=auth(token))
    r = client.get("/api/words", headers=auth(token))
    words = r.json()
    client.post(f"/api/words/{words[0]['id']}/review", json={"q": 5}, headers=auth(token))
    # 到期：复习过的词 due 明天（未来），未复习的 due_at 为空 → 都不在今日到期
    # 再造一个已到期词
    from app.core.db import SessionLocal
    from app.models import Word

    db = SessionLocal()
    try:
        db.query(Word).filter(Word.lemma == "bbb").update(
            {"due_at": "2000-01-01T00:00:00+00:00"}
        )
        db.commit()
    finally:
        db.close()
    r = client.get("/api/stats/overview", headers=auth(token))
    body = r.json()
    assert body["review_done_today"] == 1
    assert body["review_due_today"] == 1


def test_session_validation(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post("/api/reading-sessions",
                    json={"paper_id": paper["id"], "start_at": "bad", "end_at": "bad"},
                    headers=auth(token))
    assert r.status_code == 400
    r = client.post("/api/reading-sessions",
                    json={"paper_id": 999, "start_at": iso(utc_now()), "end_at": iso(utc_now())},
                    headers=auth(token))
    assert r.status_code == 404
