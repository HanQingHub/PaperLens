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
