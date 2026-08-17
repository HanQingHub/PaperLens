from conftest import auth, register, upload_pdf

from app.core.security import hash_password, verify_password, new_token


def test_bcrypt_cost12_and_verify():
    h = hash_password("secret123")
    assert h.startswith("$2b$12$")  # bcrypt cost=12
    assert verify_password("secret123", h)
    assert not verify_password("wrong", h)


def test_token_urlsafe_32bytes():
    t = new_token()
    assert len(t) >= 40


def test_register_and_me(client):
    token = register(client, "alice")
    r = client.get("/api/me", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["username"] == "alice"
    assert body["settings"] == {}


def test_register_duplicate(client):
    register(client, "alice")
    r = client.post("/api/auth/register", json={"username": "alice", "password": "secret123"})
    assert r.status_code == 409


def test_register_validation(client):
    r = client.post("/api/auth/register", json={"username": "bob", "password": "123"})
    assert r.status_code == 400
    r = client.post("/api/auth/register", json={"username": "", "password": "secret123"})
    assert r.status_code == 400


def test_login_success_and_wrong_password(client):
    register(client, "alice")
    r = client.post("/api/auth/login", json={"username": "alice", "password": "secret123"})
    assert r.status_code == 200
    assert "token" in r.json()
    r = client.post("/api/auth/login", json={"username": "alice", "password": "nope"})
    assert r.status_code == 401


def test_login_remember_extends_expiry(client):
    register(client, "alice")
    from app.core.db import SessionLocal
    from app.models import Session as DbSession

    client.post("/api/auth/login", json={"username": "alice", "password": "secret123", "remember": False})
    client.post("/api/auth/login", json={"username": "alice", "password": "secret123", "remember": True})
    db = SessionLocal()
    try:
        rows = db.query(DbSession).order_by(DbSession.expires_at).all()
        short, long = rows[0].expires_at, rows[-1].expires_at
        assert short < long
        assert long > short
    finally:
        db.close()


def test_logout_invalidates(client):
    token = register(client, "alice")
    r = client.post("/api/auth/logout", headers=auth(token))
    assert r.status_code == 204
    r = client.get("/api/me", headers=auth(token))
    assert r.status_code == 401


def test_expired_session_rejected(client):
    token = register(client, "alice")
    from app.core.db import SessionLocal
    from app.models import Session as DbSession

    db = SessionLocal()
    try:
        s = db.get(DbSession, token)
        s.expires_at = "2000-01-01T00:00:00+00:00"
        db.commit()
    finally:
        db.close()
    r = client.get("/api/me", headers=auth(token))
    assert r.status_code == 401


def test_no_token_401(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/projects").status_code == 401


def test_account_isolation(client, tmp_path):
    token_a = register(client, "alice")
    token_b = register(client, "bob")
    paper = upload_pdf(client, token_a, tmp_path, name="a.pdf")
    r = client.post("/api/projects", json={"name": "P"}, headers=auth(token_a))
    assert r.status_code == 201

    r = client.get("/api/papers", headers=auth(token_b))
    assert r.json() == []
    r = client.get(f"/api/papers/{paper['id']}", headers=auth(token_b))
    assert r.status_code == 404
    r = client.get("/api/projects", headers=auth(token_b))
    assert r.json() == []
