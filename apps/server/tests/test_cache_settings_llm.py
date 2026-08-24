import pytest

from conftest import auth, register, upload_pdf
from app.services.llm_service import LLMInterrupted


def test_cache_translate_clears_rows(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    from app.core.db import SessionLocal
    from app.models import TranslationCache

    db = SessionLocal()
    try:
        db.add(TranslationCache(user_id=1, paper_id=paper["id"], lemma="x", engine="e",
                                result_json="{}"))
        db.commit()
    finally:
        db.close()
    r = client.delete("/api/cache/translate", headers=auth(token))
    assert r.status_code == 200
    db = SessionLocal()
    try:
        assert db.query(TranslationCache).count() == 0
    finally:
        db.close()


def test_cache_ocr_clears_dirs(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True)
    d = data_dir / "ocr" / str(paper["id"])
    assert d.exists()
    (d / "blocks.ndjson").write_text("{}\n", encoding="utf-8")
    r = client.delete("/api/cache/ocr", headers=auth(token))
    assert r.status_code == 200
    assert "freed_bytes" in r.json()
    assert not d.exists()
    r = client.get(f"/api/papers/{paper['id']}", headers=auth(token))
    assert r.json()["ocr_status"] == "none"


def test_cache_invalid_type(client):
    token = register(client)
    r = client.delete("/api/cache/bogus", headers=auth(token))
    assert r.status_code == 400


def test_settings_get_put(client):
    token = register(client)
    r = client.put("/api/settings", json={"llm_unload_policy": "0", "theme": "dark"}, headers=auth(token))
    assert r.status_code == 200
    assert r.json()["llm_unload_policy"] == "0"
    r = client.get("/api/settings", headers=auth(token))
    assert r.json() == {"llm_unload_policy": "0", "theme": "dark"}
    r = client.get("/api/me", headers=auth(token))
    assert r.json()["settings"]["theme"] == "dark"


def test_settings_isolated_per_user(client):
    ta = register(client, "alice")
    tb = register(client, "bob")
    client.put("/api/settings", json={"theme": "dark"}, headers=auth(ta))
    assert client.get("/api/settings", headers=auth(tb)).json() == {}


def test_llm_models_scan(client, data_dir):
    token = register(client)
    (data_dir / "models").mkdir(exist_ok=True)
    (data_dir / "models" / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"x" * 100)
    (data_dir / "models" / "my-custom.gguf").write_bytes(b"y" * 50)
    r = client.get("/api/llm/models", headers=auth(token))
    assert r.status_code == 200
    models = {m["id"]: m for m in r.json()}
    assert models["qwen3.5-2b-q4km"]["builtin"] is True
    assert models["qwen3.5-2b-q4km"]["downloaded"] is True
    assert models["qwen3.5-0.8b-q4km"]["downloaded"] is False
    assert models["my-custom"]["builtin"] is False


def test_llm_status_initial(client):
    token = register(client)
    r = client.get("/api/llm/status", headers=auth(token))
    body = r.json()
    assert body["state"] == "unloaded"
    assert "rss_mb" in body


def test_llm_load_missing_model_fails_fast(client):
    token = register(client)
    r = client.post("/api/llm/load", json={"model_id": "ghost"}, headers=auth(token))
    assert r.status_code == 202
    body = client.get("/api/llm/status", headers=auth(token)).json()
    assert body["state"] == "unloaded"  # 模型不可用：立即失败回落
    assert body["error"]


def test_llm_unload(client):
    token = register(client)
    r = client.post("/api/llm/unload", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["state"] == "unloaded"


def test_llm_service_unload_policy_and_sm2_style_units(client):
    from app.services.llm_service import LLMService

    svc = LLMService()
    assert svc.state == "unloaded"
    assert svc._unload_policy() == 600  # 默认空闲 10 分钟
    assert svc.resolve_model_path("nonexistent-model") is None


def test_llm_import_gguf(client, data_dir):
    token = register(client)
    files = {"gguf": ("tiny.gguf", b"GGUF fake content", "application/octet-stream")}
    r = client.post("/api/llm/import", files=files, headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "tiny"
    assert (data_dir / "models" / "tiny.gguf").exists()
    assert body["size_bytes"] == len(b"GGUF fake content")


def test_unhandled_exception_returns_500_without_leak(client, monkeypatch):
    # conftest 的 httpx 兼容垫片会把 raise_server_exceptions 覆盖回 True（星环 TestClient
    # 自建 transport 被替换），此处直接改回 False 以拿到 500 响应体
    client._transport.raise_server_exceptions = False
    token = register(client)

    def boom():
        raise RuntimeError("secret-internal-token-xyz")

    monkeypatch.setattr("app.services.stats_service.overview", boom)
    r = client.get("/api/stats/overview", headers=auth(token))
    assert r.status_code == 500
    body = r.json()
    assert body["status"] == 500
    assert body["error"] == "Internal Server Error"
    assert "secret-internal-token-xyz" not in r.text
    assert "服务器内部错误" in body["detail"]


def test_unload_sync_waits_for_inflight_generation(monkeypatch):
    import asyncio
    import threading
    import time

    from app.services.llm_service import LLMService

    svc = LLMService()
    closed = threading.Event()

    class SlowLLM:
        def __init__(self):
            self.closed = False

        def create_chat_completion(self, **kwargs):
            def gen():
                for _ in range(5):
                    time.sleep(0.1)
                    yield {"choices": [{"delta": {"content": "x"}}]}
                yield None

            return gen()

        def close(self):
            self.closed = True
            closed.set()

    fake = SlowLLM()
    svc._llm = fake
    svc.state = "ready"
    monkeypatch.setattr("app.services.llm_service.LLMService._unload_policy", lambda self: 0)

    async def main():
        collected = []

        async def consume():
            async for ev in svc.chat_stream([{"role": "user", "content": "hi"}], max_tokens=10):
                collected.append(ev)

        task = asyncio.create_task(consume())
        while not svc._generating.is_set():
            await asyncio.sleep(0.01)
        done = asyncio.Event()

        def do_unload():
            svc.unload_sync()
            done.set()

        t = threading.Thread(target=do_unload)
        t.start()
        await asyncio.sleep(0.05)
        # 首个 chunk 仍在原生线程中 sleep(0.1)，_generating 未清，unload_sync 必须阻塞
        assert not done.is_set(), "unload_sync 不应在生成中提前返回"
        assert not fake.closed
        with pytest.raises(LLMInterrupted):
            # B9：中断不再静默 break，而是抛 LLMInterrupted（半截结果不得入缓存）
            await task
        t.join(timeout=5)
        assert done.is_set()
        assert fake.closed
        assert not svc._generating.is_set()
        assert svc._llm is None

    asyncio.run(main())
