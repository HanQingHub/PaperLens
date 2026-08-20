from conftest import auth, register, upload_pdf


def test_glossary_user_term_overwrites_tfidf(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    from app.core.db import SessionLocal
    from app.models import GlossaryTerm

    db = SessionLocal()
    try:
        db.add(GlossaryTerm(user_id=1, paper_id=paper["id"], term="attention",
                            domain_translation="旧译", confidence=0.5, source="tfidf"))
        db.commit()
    finally:
        db.close()
    r = client.post("/api/glossary/terms",
                    json={"paper_id": paper["id"], "term": "attention", "domain_translation": "注意力（本文）"},
                    headers=auth(token))
    assert r.status_code == 201
    db = SessionLocal()
    try:
        rows = db.query(GlossaryTerm).filter(GlossaryTerm.paper_id == paper["id"],
                                             GlossaryTerm.term == "attention").all()
        assert len(rows) == 1  # UNIQUE(paper_id, term) 覆盖
        assert rows[0].source == "user"
        assert rows[0].domain_translation == "注意力（本文）"
    finally:
        db.close()


def test_glossary_list_and_delete(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post("/api/glossary/terms",
                    json={"paper_id": paper["id"], "term": "gradient", "domain_translation": "梯度"},
                    headers=auth(token))
    term_id = r.json()["id"]
    r = client.get(f"/api/papers/{paper['id']}/glossary", headers=auth(token))
    assert r.status_code == 200
    rows = r.json()
    grads = [x for x in rows if x["term"] == "gradient"]
    assert len(grads) == 1
    r = client.delete(f"/api/glossary/terms/{term_id}", headers=auth(token))
    assert r.status_code == 204
    rows = client.get(f"/api/papers/{paper['id']}/glossary", headers=auth(token)).json()
    assert all(x["term"] != "gradient" for x in rows)


def test_tfidf_generates_glossary_terms(client, tmp_path):
    import asyncio

    token = register(client)
    pages = tuple((f"attention network gradient {i}" for i in range(3)),)
    upload_pdf(client, token, tmp_path, pages=pages, title="TFIDF Test")
    from app.services import tfidf_service

    async def run():
        await tfidf_service._run(1)

    asyncio.run(run())
    from app.core.db import SessionLocal
    from app.models import GlossaryTerm

    db = SessionLocal()
    try:
        terms = {r.term for r in db.query(GlossaryTerm).all()}
        assert any("attention" == t for t in terms)
        assert any("network" in t for t in terms)
    finally:
        db.close()


def test_tfidf_does_not_overwrite_user_rows(client, tmp_path):
    import asyncio

    token = register(client)
    pages = tuple((f"attention network gradient {i}" for i in range(3)),)
    paper = upload_pdf(client, token, tmp_path, pages=pages)
    from app.core.db import SessionLocal
    from app.models import GlossaryTerm

    db = SessionLocal()
    try:
        db.add(GlossaryTerm(user_id=1, paper_id=paper["id"], term="attention",
                            domain_translation="用户修正", source="user"))
        db.commit()
    finally:
        db.close()
    from app.services import tfidf_service

    asyncio.run(tfidf_service._run(paper["id"]))
    db = SessionLocal()
    try:
        row = db.query(GlossaryTerm).filter(GlossaryTerm.term == "attention").one()
        assert row.source == "user"
        assert row.domain_translation == "用户修正"
    finally:
        db.close()


def test_tfidf_schedule_with_loop_from_thread(client, tmp_path):
    """B01：schedule(paper_id, loop) 从工作线程调度到事件循环，任务完成后清理 _tasks。"""
    import asyncio

    token = register(client)
    pages = tuple((f"attention network gradient {i}" for i in range(3)),)
    upload_pdf(client, token, tmp_path, pages=pages)
    from app.core.db import SessionLocal
    from app.models import GlossaryTerm
    from app.services import tfidf_service

    async def driver():
        await asyncio.to_thread(tfidf_service.schedule, 1, asyncio.get_running_loop())
        deadline = asyncio.get_event_loop().time() + 5
        while 1 in tfidf_service._tasks and not tfidf_service._tasks[1].done():
            assert asyncio.get_event_loop().time() < deadline, "tfidf 任务超时未完成"
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)

    asyncio.run(driver())
    assert 1 not in tfidf_service._tasks
    db = SessionLocal()
    try:
        terms = {r.term for r in db.query(GlossaryTerm).all()}
        assert any("attention" == t for t in terms)
    finally:
        db.close()


def test_tfidf_schedule_no_loop_from_plain_thread_swallows(client, tmp_path):
    """B01：无事件循环的普通线程调用 schedule 不应抛异常（静默跳过）。"""
    import threading

    token = register(client)
    upload_pdf(client, token, tmp_path)
    from app.services import tfidf_service

    errors = []

    def go():
        try:
            tfidf_service.schedule(1)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=go)
    t.start()
    t.join(timeout=5)
    assert errors == []
