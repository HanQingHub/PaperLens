"""open-external（文件关联打开）与 list_papers opened 过滤。"""
from conftest import auth, make_pdf_bytes, register, upload_pdf


def _write_pdf(tmp_path, name="ext.pdf"):
    p = tmp_path / name
    p.write_bytes(make_pdf_bytes((("Hello external",),), title="External Paper"))
    return p


def test_open_external_creates_paper_with_source_path(client, tmp_path, data_dir):
    token = register(client)
    src = _write_pdf(tmp_path, "论文.pdf")
    r = client.post("/api/papers/open-external", json={"path": str(src)}, headers=auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    paper = body["paper"]
    assert paper["source_path"] == str(src)
    assert paper["orig_filename"] == "论文.pdf"
    assert (data_dir / "files" / f"{paper['file_hash']}.pdf").exists()


def test_open_external_reuses_same_hash(client, tmp_path, data_dir):
    token = register(client)
    src = _write_pdf(tmp_path)
    p1 = client.post("/api/papers/open-external", json={"path": str(src)}, headers=auth(token)).json()
    assert p1["created"] is True
    # 同一文件再次从不同路径打开 → 复用既有 Paper，不重复入库
    src2 = tmp_path / "copy.pdf"
    src2.write_bytes(src.read_bytes())
    p2 = client.post("/api/papers/open-external", json={"path": str(src2)}, headers=auth(token)).json()
    assert p2["created"] is False
    assert p2["paper"]["id"] == p1["paper"]["id"]
    assert p2["paper"]["source_path"] == str(src2)
    assert len(list((data_dir / "files").glob("*.pdf"))) == 1
    # 文库中只有一条
    papers = client.get("/api/papers", headers=auth(token)).json()
    assert len(papers) == 1


def test_open_external_rejects_non_pdf_and_missing(client, tmp_path):
    token = register(client)
    txt = tmp_path / "note.txt"
    txt.write_text("hi")
    r = client.post("/api/papers/open-external", json={"path": str(txt)}, headers=auth(token))
    assert r.status_code == 400
    r = client.post(
        "/api/papers/open-external", json={"path": str(tmp_path / "ghost.pdf")}, headers=auth(token)
    )
    assert r.status_code == 404
    # 未带鉴权
    r = client.post("/api/papers/open-external", json={"path": "x.pdf"})
    assert r.status_code == 401


def test_open_external_quote_wrapped_path(client, tmp_path):
    """Rust 侧传来的路径可能带引号包裹（命令行 %1 展开形态）。"""
    token = register(client)
    src = _write_pdf(tmp_path)
    r = client.post(
        "/api/papers/open-external", json={"path": f'"{src}"'}, headers=auth(token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["paper"]["source_path"] == str(src)


def test_list_papers_opened_filter(client, tmp_path):
    token = register(client)
    upload_pdf(client, token, tmp_path, name="never.pdf", pages=(("A",),))
    src = _write_pdf(tmp_path, "opened.pdf")
    opened_paper = client.post(
        "/api/papers/open-external", json={"path": str(src)}, headers=auth(token)
    ).json()["paper"]
    # 刚入库未打开：open_count=0，不进"打开过"
    assert client.get("/api/papers?opened=true", headers=auth(token)).json() == []
    # 模拟打开（reading-progress open=true → open_count+1）
    r = client.put(
        f"/api/reading-progress/{opened_paper['id']}",
        json={"page_no": 1, "scroll_y": 0, "open": True},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    rows = client.get("/api/papers?opened=true&sort=last_opened", headers=auth(token)).json()
    assert [p["id"] for p in rows] == [opened_paper["id"]]
    assert rows[0]["open_count"] == 1
    assert rows[0]["last_opened_at"]
    # 不过滤时两篇都在
    assert len(client.get("/api/papers", headers=auth(token)).json()) == 2


def _write_md(tmp_path, name="notes.md", text="# Hello\n\nexternal markdown"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_open_external_md_creates_paper(client, tmp_path, data_dir):
    token = register(client)
    src = _write_md(tmp_path, "笔记.md")
    r = client.post("/api/papers/open-external", json={"path": str(src)}, headers=auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    paper = body["paper"]
    assert paper["file_type"] == "markdown"
    assert paper["source_path"] == str(src)
    assert paper["orig_filename"] == "笔记.md"
    assert (data_dir / "files" / f"{paper['file_hash']}.md").exists()


def test_open_external_md_reuses_same_hash(client, tmp_path):
    token = register(client)
    src = _write_md(tmp_path)
    p1 = client.post("/api/papers/open-external", json={"path": str(src)}, headers=auth(token)).json()
    assert p1["created"] is True
    # 同一文件再次从不同路径打开 → 复用既有 Paper，不重复入库
    src2 = tmp_path / "copy.md"
    src2.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    p2 = client.post("/api/papers/open-external", json={"path": str(src2)}, headers=auth(token)).json()
    assert p2["created"] is False
    assert p2["paper"]["id"] == p1["paper"]["id"]
    assert p2["paper"]["source_path"] == str(src2)


def test_open_external_md_quote_wrapped_path(client, tmp_path):
    """Rust 侧传来的路径可能带引号包裹（命令行 %1 展开形态），md 同样处理。"""
    token = register(client)
    src = _write_md(tmp_path)
    r = client.post(
        "/api/papers/open-external", json={"path": f'"{src}"'}, headers=auth(token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] is True


def test_open_external_md_rejects_non_utf8_and_oversize(client, tmp_path):
    """md 分支与 upload 的 md 预检同口径：非 UTF-8 400 / 超 5MB 400。"""
    token = register(client)
    gbk = tmp_path / "gbk.md"
    gbk.write_bytes("中文内容".encode("gbk"))
    r = client.post("/api/papers/open-external", json={"path": str(gbk)}, headers=auth(token))
    assert r.status_code == 400
    big = tmp_path / "big.md"
    big.write_bytes(b"a" * (5 * 1024 * 1024 + 1))
    r = client.post("/api/papers/open-external", json={"path": str(big)}, headers=auth(token))
    assert r.status_code == 400


def test_open_external_ephemeral_not_in_library_and_swept(client, tmp_path, data_dir):
    """save=false 建临时件：可单篇取阅（阅读器）但不进文库，启动清扫即删。"""
    import json

    token = register(client)
    src = _write_md(tmp_path, "temp.md")
    r = client.post(
        "/api/papers/open-external", json={"path": str(src), "save": False}, headers=auth(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    assert body["paper"]["ephemeral"] is True
    pid = body["paper"]["id"]
    # 临时件不进文库任何视图
    assert client.get("/api/papers", headers=auth(token)).json() == []
    assert client.get("/api/papers?opened=true", headers=auth(token)).json() == []
    # 文件仍落盘，阅读器单篇取件不受文库过滤影响（可批注）
    assert (data_dir / "files" / f"{body['paper']['file_hash']}.md").exists()
    got = client.get(f"/api/papers/{pid}", headers=auth(token))
    assert got.status_code == 200
    r = client.post(
        f"/api/papers/{pid}/annotations",
        json={"page_no": 1, "type": "sentence",
              "anchor_json": json.dumps({"rects": [[0, 0, 10, 10]], "text": "t"}), "text": "t"},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    # 启动清扫：临时件连批注级联清空，文件删除
    from app.core import db as db_mod
    from app.api.papers import sweep_ephemeral_papers

    db = db_mod.SessionLocal()
    try:
        assert sweep_ephemeral_papers(db) == 1
    finally:
        db.close()
    assert not (data_dir / "files" / f"{body['paper']['file_hash']}.md").exists()
    assert client.get(f"/api/papers/{pid}", headers=auth(token)).status_code == 404


def test_open_external_promote_ephemeral_on_save(client, tmp_path):
    """save=true 再开同内容临时件 → 升格为正式（id 不变、批注保留、进文库）。"""
    import json

    token = register(client)
    src = _write_md(tmp_path, "promote.md")
    pid = client.post(
        "/api/papers/open-external", json={"path": str(src), "save": False}, headers=auth(token)
    ).json()["paper"]["id"]
    r = client.post(
        f"/api/papers/{pid}/annotations",
        json={"page_no": 1, "type": "sentence",
              "anchor_json": json.dumps({"rects": [[0, 0, 10, 10]], "text": "t"}), "text": "t"},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    src2 = tmp_path / "promote-copy.md"
    src2.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    r = client.post(
        "/api/papers/open-external", json={"path": str(src2), "save": True}, headers=auth(token)
    )
    body = r.json()
    assert body["created"] is True
    assert body["paper"]["id"] == pid
    assert body["paper"]["ephemeral"] is False
    assert body["paper"]["source_path"] == str(src2)
    rows = client.get("/api/papers", headers=auth(token)).json()
    assert [p["id"] for p in rows] == [pid]
    anns = client.get(f"/api/papers/{pid}/annotations", headers=auth(token)).json()
    assert len(anns) == 1


def test_open_external_ephemeral_reuse_and_saved_hit(client, tmp_path):
    """save=false 复用临时件；已有正式件时 save 参数不生效（直接打开正式件）。"""
    token = register(client)
    src = _write_md(tmp_path, "reuse.md")
    p1 = client.post(
        "/api/papers/open-external", json={"path": str(src), "save": False}, headers=auth(token)
    ).json()
    assert p1["created"] is True
    src2 = tmp_path / "reuse-copy.md"
    src2.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    p2 = client.post(
        "/api/papers/open-external", json={"path": str(src2), "save": False}, headers=auth(token)
    ).json()
    assert p2["created"] is False
    assert p2["paper"]["id"] == p1["paper"]["id"]
    assert p2["paper"]["source_path"] == str(src2)
    # 已有正式件：save=false 也直接打开正式件，不另建临时件
    src3 = tmp_path / "saved.md"
    src3.write_text("# saved doc", encoding="utf-8")
    p3 = client.post(
        "/api/papers/open-external", json={"path": str(src3), "save": True}, headers=auth(token)
    ).json()
    assert p3["created"] is True and p3["paper"]["ephemeral"] is False
    src4 = tmp_path / "saved-copy.md"
    src4.write_text("# saved doc", encoding="utf-8")
    p4 = client.post(
        "/api/papers/open-external", json={"path": str(src4), "save": False}, headers=auth(token)
    ).json()
    assert p4["created"] is False
    assert p4["paper"]["id"] == p3["paper"]["id"]
    assert p4["paper"]["ephemeral"] is False
    papers = client.get("/api/papers", headers=auth(token)).json()
    assert len(papers) == 1
