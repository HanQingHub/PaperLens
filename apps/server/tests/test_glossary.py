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
