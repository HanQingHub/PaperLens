import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from pdfgen import make_pdf_bytes


def make_mini_ecdict(path):
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE dictionary(word TEXT PRIMARY KEY, pos TEXT, phonetic TEXT, translation TEXT,"
        " collins_star INTEGER, tag TEXT, exchange TEXT)"
    )
    con.execute("CREATE TABLE lemmas(word TEXT PRIMARY KEY, lemma TEXT)")
    words = [
        ("attention", "n.", "əˈtenʃn", "注意;关注\n注意力", 3, "", ""),
        ("network", "n.", "ˈnetwɜːk", "网络", 2, "", ""),
        ("study", "v.", "stʌdi", "学习\n研究", 3, "", "0=study"),
        ("studies", "n.", None, "学习;研究", 0, "", "0=study"),
        ("transformer", "n.", None, "变压器;变换器", 0, "", ""),
        ("go", "v.", "ɡəʊ", "去", 3, "", ""),
        ("learning", "n.", None, "学习", 2, "", "0=learn"),
        ("gradient", "n.", None, "梯度", 1, "", ""),
    ]
    con.executemany("INSERT INTO dictionary VALUES (?,?,?,?,?,?,?)", words)
    con.executemany(
        "INSERT INTO lemmas VALUES (?,?)",
        [("studies", "study"), ("went", "go"), ("networks", "network"), ("learning", "learn")],
    )
    con.commit()
    con.close()


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PAPERLENS_DATA_DIR", str(data))
    monkeypatch.setenv("PAPERLENS_SKIP_MIGRATE", "1")
    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.core import db as db_mod
    from app.models import Base

    db_mod.init_engine(data / "paperlens.db")
    Base.metadata.create_all(db_mod.engine)
    from app.services import ecdict_service, file_tokens

    ecdict_service.reset()
    file_tokens.reset()
    make_mini_ecdict(data / "ecdict.db")
    yield data
    from app.services import tfidf_service
    from app.services.llm_service import llm_service

    for pid in list(tfidf_service._tasks):
        tfidf_service.cancel(pid)
    llm_service.state = "unloaded"
    llm_service.model_id = None
    llm_service.last_error = None


@pytest.fixture
def client(data_dir, monkeypatch):
    from app.main import app
    from app.services.ocr_manager import OCRManager

    # 测试确定性：不拉起真实 OCR worker
    monkeypatch.setattr(OCRManager, "spawn_worker", lambda self: None)
    with TestClient(app) as c:
        yield c
    from app.services import ecdict_service

    ecdict_service.reset()


# ---- 帮助函数 ----

def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def register(client, username="alice", password="secret123") -> str:
    r = client.post("/api/auth/register", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def upload_pdf(client, token, tmp_path, name="test.pdf", project_id=None, is_scanned=False,
               pages=(("Hello world", "Second line"),), title="Test Paper"):
    path = tmp_path / name
    path.write_bytes(make_pdf_bytes(pages, title=title))
    data = {"is_scanned": "true" if is_scanned else "false"}
    if project_id is not None:
        data["project_id"] = str(project_id)
    with open(path, "rb") as f:
        r = client.post(
            "/api/papers/upload",
            files={"file": (name, f, "application/pdf")},
            data=data,
            headers=auth(token),
        )
    assert r.status_code == 200, r.text
    return r.json()["paper"]


def parse_sse(text: str) -> list[dict]:
    events = []
    cur = {}
    for line in text.splitlines():
        if line.startswith("event: "):
            cur["event"] = line[7:]
        elif line.startswith("data: "):
            cur["data"] = json.loads(line[6:])
            events.append(cur)
            cur = {}
    return events


def sse_read(client, url, body, token) -> list[dict]:
    with client.stream("POST", url, json=body, headers=auth(token)) as r:
        assert r.status_code == 200, r.text
        text = "".join(r.iter_text())
    return parse_sse(text)


class FakeLLM:
    def __init__(self, chunks=None, delay=0.0, error=None):
        self.chunks = chunks if chunks is not None else ["【本文译法】", "注意力机制。"]
        self.state = "ready"
        self.model_id = "fake-1b"
        self.delay = delay
        self.error = error
        self.calls = []

    async def chat_stream(self, messages, max_tokens=300):
        import asyncio

        self.calls.append(messages)
        if self.error is not None:
            raise self.error
        for c in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield {"type": "delta", "text": c}


@pytest.fixture
def fake_llm(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr("app.services.translate_service.llm_service", fake)
    return fake
