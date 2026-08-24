from conftest import auth, register


def test_scan_ignores_gguf_part(client, data_dir):
    token = register(client)
    models_dir = data_dir / "models"
    models_dir.mkdir(exist_ok=True)
    (models_dir / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"x" * 10)
    (models_dir / "Qwen3.5-2B-Q4_K_M.gguf.part").write_bytes(b"partial")
    (models_dir / "my-custom.gguf.part").write_bytes(b"partial2")
    r = client.get("/api/llm/models", headers=auth(token))
    assert r.status_code == 200
    ids = {m["id"] for m in r.json()}
    assert "qwen3.5-2b-q4km" in ids
    # .part 不应被计入任何模型（既非 builtin downloaded 误判，也非自定义）
    assert "my-custom" not in ids
    assert "qwen3.5-2b-q4_k_m" not in ids  # part 的 stem 含 .gguf，不应出现


def test_scan_custom_uppercase_GGUF(client, data_dir):
    token = register(client)
    models_dir = data_dir / "models"
    models_dir.mkdir(exist_ok=True)
    (models_dir / "My-Custom.GGUF").write_bytes(b"y" * 50)
    (models_dir / "Another_model.Gguf").write_bytes(b"z" * 10)
    r = client.get("/api/llm/models", headers=auth(token))
    models = {m["id"]: m for m in r.json()}
    assert "my-custom" in models
    assert models["my-custom"]["builtin"] is False
    assert models["my-custom"]["downloaded"] is True
    assert models["my-custom"]["file"] == "My-Custom.GGUF"
    assert "another_model" in models


def test_scan_bundled_dir_via_env(client, data_dir, tmp_path, monkeypatch):
    from app.core.config import get_settings

    bundled = tmp_path / "bundled_models"
    bundled.mkdir()
    (bundled / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"b" * 20)
    (bundled / "bundled-extra.gguf").write_bytes(b"e" * 10)

    monkeypatch.setenv("PAPERLENS_MODELS_DIR", str(bundled))
    get_settings.cache_clear()
    # data_dir/models 为空，bundled 兜底
    r = client.get("/api/llm/models", headers=auth(register(client, "bob_bundled")))
    models = {m["id"]: m for m in r.json()}
    assert models["qwen3.5-2b-q4km"]["downloaded"] is True
    assert models["qwen3.5-2b-q4km"]["size_bytes"] == 20
    assert "bundled-extra" in models

    monkeypatch.delenv("PAPERLENS_MODELS_DIR", raising=False)
    get_settings.cache_clear()


def test_scan_bundled_verbatim_prefix(client, data_dir, tmp_path, monkeypatch):
    from app.core.config import get_settings

    bundled = tmp_path / "verbatim_models"
    bundled.mkdir()
    (bundled / "Qwen3.5-0.8B-Q4_K_M.gguf").write_bytes(b"v" * 30)
    verbatim = "\\\\?\\" + str(bundled)
    monkeypatch.setenv("PAPERLENS_MODELS_DIR", verbatim)
    get_settings.cache_clear()
    r = client.get("/api/llm/models", headers=auth(register(client, "bob_verbatim")))
    models = {m["id"]: m for m in r.json()}
    assert models["qwen3.5-0.8b-q4km"]["downloaded"] is True
    assert models["qwen3.5-0.8b-q4km"]["size_bytes"] == 30
    monkeypatch.delenv("PAPERLENS_MODELS_DIR", raising=False)
    get_settings.cache_clear()


def test_scan_data_dir_priority_over_bundled(client, data_dir, tmp_path, monkeypatch):
    from app.core.config import get_settings

    bundled = tmp_path / "bundled_prio"
    bundled.mkdir()
    (bundled / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"b" * 20)
    (data_dir / "models").mkdir(exist_ok=True)
    (data_dir / "models" / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"d" * 100)
    monkeypatch.setenv("PAPERLENS_MODELS_DIR", str(bundled))
    get_settings.cache_clear()
    r = client.get("/api/llm/models", headers=auth(register(client, "prio")))
    models = {m["id"]: m for m in r.json()}
    # data_dir 优先：size 来自 data_dir
    assert models["qwen3.5-2b-q4km"]["size_bytes"] == 100
    monkeypatch.delenv("PAPERLENS_MODELS_DIR", raising=False)
    get_settings.cache_clear()


def test_resolve_case_insensitive_and_with_ext(data_dir, tmp_path, monkeypatch):
    from app.core.config import get_settings
    from app.services.llm_service import llm_service

    (data_dir / "models").mkdir(exist_ok=True)
    (data_dir / "models" / "Qwen3.5-2B-Q4_K_M.gguf").write_bytes(b"x" * 10)
    (data_dir / "models" / "my-custom.gguf").write_bytes(b"y" * 10)
    get_settings.cache_clear()

    # 大小写不敏感
    assert llm_service.resolve_model_path("QWEN3.5-2B-Q4KM") is not None
    assert llm_service.resolve_model_path("qwen3.5-2b-q4km") is not None
    # 带后缀
    assert llm_service.resolve_model_path("Qwen3.5-2B-Q4_K_M.gguf") is not None
    assert llm_service.resolve_model_path("qwen3.5-2b-q4_k_m.gguf") is not None
    # 自定义大小写
    assert llm_service.resolve_model_path("MY-CUSTOM") is not None
    assert llm_service.resolve_model_path("my-custom.gguf") is not None
    # 不存在
    assert llm_service.resolve_model_path("ghost") is None


def test_import_accepts_file_and_gguf_field(client, data_dir):
    token = register(client)
    # gguf 字段（存量测试路径）
    files = {"gguf": ("tiny.gguf", b"GGUF fake", "application/octet-stream")}
    r = client.post("/api/llm/import", files=files, headers=auth(token))
    assert r.status_code == 200
    assert r.json()["id"] == "tiny"
    # file 字段（前端实际发送）
    files2 = {"file": ("tiny2.gguf", b"GGUF2", "application/octet-stream")}
    r2 = client.post("/api/llm/import", files=files2, headers=auth(token))
    assert r2.status_code == 200, r2.text
    assert r2.json()["id"] == "tiny2"
    assert (data_dir / "models" / "tiny.gguf").exists()
    assert (data_dir / "models" / "tiny2.gguf").exists()
    # GET /models 立即可见
    r = client.get("/api/llm/models", headers=auth(token))
    ids = {m["id"] for m in r.json()}
    assert "tiny" in ids and "tiny2" in ids


def test_import_uppercase_GGUF_ext(client, data_dir):
    token = register(client)
    files = {"file": ("UPPER.GGUF", b"content", "application/octet-stream")}
    r = client.post("/api/llm/import", files=files, headers=auth(token))
    assert r.status_code == 200
    assert r.json()["id"] == "upper"
    assert (data_dir / "models" / "UPPER.GGUF").exists()
    # 大小写混合
    files2 = {"file": ("Mixed.GgUf", b"x", "application/octet-stream")}
    r2 = client.post("/api/llm/import", files=files2, headers=auth(token))
    assert r2.status_code == 200
    assert r2.json()["id"] == "mixed"


def test_import_overwrite_existing(client, data_dir):
    token = register(client)
    files = {"file": ("dup.gguf", b"first", "application/octet-stream")}
    r = client.post("/api/llm/import", files=files, headers=auth(token))
    assert r.status_code == 200
    assert (data_dir / "models" / "dup.gguf").read_bytes() == b"first"
    files2 = {"file": ("dup.gguf", b"second-longer", "application/octet-stream")}
    r2 = client.post("/api/llm/import", files=files2, headers=auth(token))
    assert r2.status_code == 200
    assert (data_dir / "models" / "dup.gguf").read_bytes() == b"second-longer"
    assert r2.json()["size_bytes"] == len(b"second-longer")


def test_import_rejects_non_gguf(client, data_dir):
    token = register(client)
    for name in ["bad.txt", "bad.zip", "noext", "model.bin"]:
        files = {"file": (name, b"x", "application/octet-stream")}
        r = client.post("/api/llm/import", files=files, headers=auth(token))
        assert r.status_code == 400, f"{name} should be rejected: {r.text}"
    # 缺字段
    r = client.post("/api/llm/import", files={}, headers=auth(token))
    assert r.status_code == 422


def test_manual_copy_recognized_without_restart(client, data_dir):
    # 模拟用户“复制到 models/ 即可被识别”：直接拷文件后 GET 应立即可见
    token = register(client)
    (data_dir / "models").mkdir(exist_ok=True)
    # 初始无
    r = client.get("/api/llm/models", headers=auth(token))
    ids_before = {m["id"] for m in r.json()}
    assert "handcopy" not in ids_before
    # 手动复制
    (data_dir / "models" / "handcopy.gguf").write_bytes(b"hand")
    r = client.get("/api/llm/models", headers=auth(token))
    assert r.status_code == 200
    ids_after = {m["id"]: m for m in r.json()}
    assert "handcopy" in ids_after
    assert ids_after["handcopy"]["downloaded"] is True


def test_status_error_surfaced_when_llama_missing(client):
    from app.services.llm_service import llm_service

    token = register(client, "err_user")
    # 直接模拟 _load_sync 已捕获 ImportError 后的状态（不依赖线程）
    llm_service.state = "unloaded"
    llm_service.model_id = "error-model"
    llm_service.last_error = "cannot import name 'Llama' from 'llama_cpp' (unknown location)"
    r = client.get("/api/llm/status", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "unloaded"
    assert body["error"] and "llama_cpp" in body["error"]
    # 前端契约：error 应随 status 透出，供徽标/错误行展示
    assert body["model_id"] == "error-model"
    llm_service.state = "unloaded"
    llm_service.last_error = None
    llm_service.model_id = None


def test_load_corrupt_gguf_sets_error(client, data_dir):
    import time

    from app.services.llm_service import llm_service

    token = register(client, "corrupt_user")
    (data_dir / "models").mkdir(parents=True, exist_ok=True)
    # 非法 GGUF 内容（非 GGUF magic），无论真实 llama_cpp 是否可用，均应最终 error 非空
    (data_dir / "models" / "bad.gguf").write_bytes(b"not a gguf file")
    llm_service.state = "unloaded"
    llm_service.last_error = None
    r = client.post("/api/llm/load", json={"model_id": "bad"}, headers=auth(token))
    assert r.status_code == 202
    deadline = time.time() + 8
    last = None
    while time.time() < deadline:
        rr = client.get("/api/llm/status", headers=auth(token))
        last = rr.json()
        if last["state"] != "loading":
            break
        time.sleep(0.3)
    assert last is not None
    assert last["state"] == "unloaded"
    assert last["error"]  # 必有错误文案
    # 兼容两种环境：有 llama_cpp 时为 GGUF 解析错误，无时为 ImportError
    err = last["error"].lower()
    assert any(k in err for k in ["gguf", "llama", "invalid", "cannot import", "magic", "failed"])


def test_load_then_status_polls_to_ready_or_error(client, data_dir):

    token = register(client, "poll_user")
    # 已有 test_scan_bundled_verbatim 前会留下文件，不影响
    (data_dir / "models").mkdir(parents=True, exist_ok=True)
    # 不实际加载大模型，仅验证轮询至非 loading 的契约
    r = client.post("/api/llm/load", json={"model_id": "ghost"}, headers=auth(token))
    assert r.status_code == 202
    rr = client.get("/api/llm/status", headers=auth(token))
    assert rr.json()["error"]  # ghost 模型不可用，应立即 error
    assert rr.json()["state"] == "unloaded"
