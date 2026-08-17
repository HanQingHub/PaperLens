import json

from conftest import auth, register, upload_pdf


def ocr_dir_for(data_dir, paper_id):
    return data_dir / "ocr" / str(paper_id)


def append_page(data_dir, paper_id, page, blocks=None):
    d = ocr_dir_for(data_dir, paper_id)
    line = json.dumps({"paper_id": paper_id, "page": page, "dpi_scale": 2.8,
                       "blocks": blocks or [{"bbox": [0, 0, 100, 20], "conf": 0.98, "text": "OCR text"}]})
    with open(d / "blocks.ndjson", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def write_result(data_dir, paper_id, status="done", pages_done=1, error=None):
    d = ocr_dir_for(data_dir, paper_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "result.json").write_text(
        json.dumps({"status": status, "error": error, "pages_done": pages_done,
                    "engine": "rapidocr-test", "finished_at": "2026-08-16T00:00:00+00:00"}),
        encoding="utf-8",
    )


def get_manager():
    from app.main import app

    return app.state.ocr_manager


def test_ocr_enqueue_pending(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True,
                       pages=(("img only",), ("img 2",)))
    assert paper["ocr_status"] == "pending"
    d = ocr_dir_for(data_dir, paper["id"])
    task = json.loads((d / "task.json").read_text(encoding="utf-8"))
    assert task["paper_id"] == paper["id"]
    assert task["pages_total"] == 2
    assert task["pages_todo"] == [0, 1]
    assert task["pdf_rel"] == f"files/{paper['file_hash']}.pdf"
    assert task["dpi_scale"] == 2.8
    r = client.get(f"/api/papers/{paper['id']}/ocr-status", headers=auth(token))
    assert r.json()["status"] == "pending"


def test_ocr_done_via_mock_worker(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True, pages=(("a",), ("b",)))
    pid = paper["id"]
    d = ocr_dir_for(data_dir, pid)
    # mock worker：先写产物与结果，再认领（避免与轮询竞态触发 failed 分支）
    append_page(data_dir, pid, 0)
    write_result(data_dir, pid, status="done", pages_done=1)
    (d / "task.json").rename(d / "task.claimed.json")
    get_manager().poll_once()

    r = client.get(f"/api/papers/{pid}/ocr-status", headers=auth(token))
    body = r.json()
    assert body["status"] == "done"
    assert body["pages_done"] == 1
    assert body["pages_total"] == 2
    assert "error" not in body
    assert not (d / "task.claimed.json").exists()
    assert not (d / "result.json").exists()
    assert (d / "blocks.ndjson").exists()  # 结果保留

    r = client.get(f"/api/papers/{pid}/ocr-result", headers=auth(token))
    assert r.status_code == 200
    assert "OCR text" in r.text


def test_ocr_worker_dead_marks_failed(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True)
    pid = paper["id"]
    d = ocr_dir_for(data_dir, pid)
    (d / "task.json").rename(d / "task.claimed.json")
    assert not get_manager().worker_alive()
    get_manager().poll_once()
    r = client.get(f"/api/papers/{pid}/ocr-status", headers=auth(token))
    body = r.json()
    assert body["status"] == "failed"
    assert "worker" in body["error"]


def test_ocr_retry_skips_done_pages(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True, pages=(("a",), ("b",)))
    pid = paper["id"]
    d = ocr_dir_for(data_dir, pid)
    (d / "task.json").rename(d / "task.claimed.json")
    get_manager().poll_once()  # 无 worker → failed
    assert client.get(f"/api/papers/{pid}/ocr-status", headers=auth(token)).json()["status"] == "failed"

    append_page(data_dir, pid, 0)  # 第 0 页已有结果
    r = client.post(f"/api/papers/{pid}/ocr/retry", headers=auth(token))
    assert r.status_code == 202
    task = json.loads((d / "task.json").read_text(encoding="utf-8"))
    assert task["pages_todo"] == [1]  # 跳过已完成页
    assert client.get(f"/api/papers/{pid}/ocr-status", headers=auth(token)).json()["status"] == "pending"


def test_ocr_startup_recovery(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True)
    pid = paper["id"]
    from app.core.db import SessionLocal
    from app.models import Paper

    db = SessionLocal()
    try:
        db.get(Paper, pid).ocr_status = "running"
        db.commit()
    finally:
        db.close()
    get_manager().recover()
    r = client.get(f"/api/papers/{pid}/ocr-status", headers=auth(token))
    assert r.json()["status"] == "pending"
    assert (ocr_dir_for(data_dir, pid) / "task.json").exists()


def test_ocr_delete_paper_removes_dir(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=True)
    pid = paper["id"]
    assert ocr_dir_for(data_dir, pid).exists()
    client.delete(f"/api/papers/{pid}", headers=auth(token))
    assert not ocr_dir_for(data_dir, pid).exists()


def test_patch_is_scanned_triggers_and_skips(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, is_scanned=False)
    pid = paper["id"]
    r = client.patch(f"/api/papers/{pid}", json={"is_scanned": True}, headers=auth(token))
    assert r.json()["ocr_status"] == "pending"
    assert (ocr_dir_for(data_dir, pid) / "task.json").exists()
    r = client.patch(f"/api/papers/{pid}", json={"is_scanned": False}, headers=auth(token))
    assert r.json()["ocr_status"] == "none"
    assert not (ocr_dir_for(data_dir, pid) / "task.json").exists()


def test_ocr_status_endpoint_for_nonexistent_paper(client):
    token = register(client)
    r = client.get("/api/papers/9999/ocr-status", headers=auth(token))
    assert r.status_code == 404
