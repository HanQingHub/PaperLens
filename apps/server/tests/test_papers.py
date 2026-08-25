import json

from conftest import auth, register, upload_pdf


def test_upload_creates_paper_and_file(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, name="p1.pdf", pages=(("Hello world",),), title="My Paper")
    assert paper["title"] == "My Paper"
    assert paper["page_count"] == 1
    assert paper["ocr_status"] == "none"
    f = data_dir / "files" / f"{paper['file_hash']}.pdf"
    assert f.exists()
    from app.core.db import SessionLocal
    from app.models import FileRef

    db = SessionLocal()
    try:
        assert db.get(FileRef, paper["file_hash"]).ref_count == 1
    finally:
        db.close()


def test_upload_dedup_same_content(client, tmp_path, data_dir):
    token = register(client)
    p1 = upload_pdf(client, token, tmp_path, name="a.pdf")
    p2 = upload_pdf(client, token, tmp_path, name="b.pdf")  # 相同内容不同文件名
    assert p1["file_hash"] == p2["file_hash"]
    files = list((data_dir / "files").glob("*.pdf"))
    assert len(files) == 1
    from app.core.db import SessionLocal
    from app.models import FileRef

    db = SessionLocal()
    try:
        assert db.get(FileRef, p1["file_hash"]).ref_count == 2
    finally:
        db.close()


def test_upload_cross_account_shares_file(client, tmp_path, data_dir):
    ta = register(client, "alice")
    tb = register(client, "bob")
    p1 = upload_pdf(client, ta, tmp_path, name="a.pdf")
    p2 = upload_pdf(client, tb, tmp_path, name="b.pdf")
    assert p1["file_hash"] == p2["file_hash"]
    assert len(list((data_dir / "files").glob("*.pdf"))) == 1


def test_delete_last_ref_removes_physical_file(client, tmp_path, data_dir):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    pid = paper["id"]
    r = client.delete(f"/api/papers/{pid}", headers=auth(token))
    assert r.status_code == 204
    assert not (data_dir / "files" / f"{paper['file_hash']}.pdf").exists()
    assert not list((data_dir / "files").glob("*.pdf"))  # 无孤儿文件
    r = client.get("/api/papers", headers=auth(token))
    assert r.json() == []


def test_delete_one_ref_keeps_file(client, tmp_path, data_dir):
    ta = register(client, "alice")
    tb = register(client, "bob")
    p1 = upload_pdf(client, ta, tmp_path, name="a.pdf")
    p2 = upload_pdf(client, tb, tmp_path, name="b.pdf")
    client.delete(f"/api/papers/{p1['id']}", headers=auth(ta))
    assert (data_dir / "files" / f"{p1['file_hash']}.pdf").exists()  # B 还在引用
    from app.core.db import SessionLocal
    from app.models import FileRef

    db = SessionLocal()
    try:
        assert db.get(FileRef, p1["file_hash"]).ref_count == 1
    finally:
        db.close()
    assert client.get(f"/api/papers/{p2['id']}", headers=auth(tb)).status_code == 200


def test_delete_cascades_but_keeps_words(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    pid = paper["id"]
    client.post("/api/papers/{pid}/annotations".replace("{pid}", str(pid)),
                json={"page_no": 0, "type": "sentence", "anchor_json": json.dumps({"rects": [[1, 2, 3, 4]]}),
                      "color": "yellow", "text": "note"},
                headers=auth(token))
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力",
                                    "paper_id": pid, "sentence": "the attention mechanism"},
                headers=auth(token))
    client.delete(f"/api/papers/{pid}", headers=auth(token))
    r = client.get("/api/words", headers=auth(token))
    assert len(r.json()) == 1  # words 本体保留
    r = client.get("/api/words", headers=auth(token))
    from app.core.db import SessionLocal
    from app.models import Annotation, WordOccurrence

    db = SessionLocal()
    try:
        assert db.query(Annotation).count() == 0
        assert db.query(WordOccurrence).count() == 0
    finally:
        db.close()


def test_list_filters_and_sort(client, tmp_path):
    token = register(client)
    r = client.post("/api/projects", json={"name": "Proj"}, headers=auth(token))
    proj_id = r.json()["id"]
    p1 = upload_pdf(client, token, tmp_path, name="b.pdf", title="Beta Paper", project_id=proj_id)
    p2 = upload_pdf(client, token, tmp_path, name="a.pdf", title="Alpha Paper",
                    pages=(("Other content here",),))
    client.patch(f"/api/papers/{p2['id']}", json={"is_favorite": True, "tags": ["ml", "cv"]},
                 headers=auth(token))

    r = client.get("/api/papers", params={"project_id": proj_id}, headers=auth(token))
    assert [p["id"] for p in r.json()] == [p1["id"]]
    r = client.get("/api/papers", params={"favorite": "true"}, headers=auth(token))
    assert [p["id"] for p in r.json()] == [p2["id"]]
    r = client.get("/api/papers", params={"tag": "ml"}, headers=auth(token))
    assert [p["id"] for p in r.json()] == [p2["id"]]
    r = client.get("/api/papers", params={"q": "alpha"}, headers=auth(token))
    assert [p["id"] for p in r.json()] == [p2["id"]]
    r = client.get("/api/papers", params={"sort": "title"}, headers=auth(token))
    titles = [p["title"] for p in r.json()]
    assert titles == sorted(titles, key=str.lower)
    r = client.get("/api/papers", params={"sort": "last_opened"}, headers=auth(token))
    assert len(r.json()) == 2


def test_patch_metadata(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.patch(f"/api/papers/{paper['id']}",
                     json={"title": "New Title", "authors": "Bob", "year": 2025, "venue": "NeurIPS",
                           "note": "备注", "doi": "10.1/x"},
                     headers=auth(token))
    body = r.json()
    assert body["title"] == "New Title"
    assert body["year"] == 2025
    assert body["venue"] == "NeurIPS"


def test_file_token_flow(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post(f"/api/papers/{paper['id']}/file-token", headers=auth(token))
    assert r.status_code == 200
    ft = r.json()["token"]

    from pdfgen import make_pdf_bytes

    expected = make_pdf_bytes((("Hello world", "Second line"),), title="Test Paper")
    r = client.get(f"/api/papers/{paper['id']}/file", params={"token": ft})
    assert r.status_code == 200
    assert r.content == expected  # 完整 GET 消耗一次性 token

    r = client.get(f"/api/papers/{paper['id']}/file", params={"token": ft})
    assert r.status_code == 401


def test_file_range_request(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    ft = client.post(f"/api/papers/{paper['id']}/file-token", headers=auth(token)).json()["token"]
    r = client.get(f"/api/papers/{paper['id']}/file", params={"token": ft},
                   headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert len(r.content) == 100
    assert r.headers["content-range"].startswith("bytes 0-99/")
    # Range 请求不消耗 token
    r2 = client.get(f"/api/papers/{paper['id']}/file", params={"token": ft})
    assert r2.status_code == 200


def test_file_no_token_rejected(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.get(f"/api/papers/{paper['id']}/file")
    assert r.status_code == 401
    r = client.get(f"/api/papers/{paper['id']}/file", params={"token": "bogus"})
    assert r.status_code == 401


def test_reading_progress_and_open_count(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.put(f"/api/reading-progress/{paper['id']}",
                   json={"page_no": 3, "scroll_y": 12.5, "open": True}, headers=auth(token))
    assert r.status_code == 200
    r = client.get(f"/api/reading-progress/{paper['id']}", headers=auth(token))
    assert r.json()["page_no"] == 3
    p = client.get(f"/api/papers/{paper['id']}", headers=auth(token)).json()
    assert p["open_count"] == 1
    assert p["last_opened_at"] is not None


def test_projects_crud_and_delete_conflict(client, tmp_path):
    token = register(client)
    r = client.post("/api/projects", json={"name": "P1"}, headers=auth(token))
    proj = r.json()
    r = client.get("/api/projects", headers=auth(token))
    assert len(r.json()) == 1
    r = client.patch(f"/api/projects/{proj['id']}", json={"name": "P2", "sort_order": 5}, headers=auth(token))
    assert r.json()["name"] == "P2"
    paper = upload_pdf(client, token, tmp_path, project_id=proj["id"])
    r = client.delete(f"/api/projects/{proj['id']}", headers=auth(token))
    assert r.status_code == 409  # 项目下有论文
    client.delete(f"/api/papers/{paper['id']}", headers=auth(token))
    r = client.delete(f"/api/projects/{proj['id']}", headers=auth(token))
    assert r.status_code == 204


def test_patch_sort_order(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.patch(f"/api/papers/{paper['id']}", json={"sort_order": 5}, headers=auth(token))
    assert r.status_code == 200
    assert r.json()["sort_order"] == 5
    p = client.get(f"/api/papers/{paper['id']}", headers=auth(token)).json()
    assert p["sort_order"] == 5


def test_list_sort_manual(client, tmp_path):
    token = register(client)
    p1 = upload_pdf(client, token, tmp_path, name="a.pdf", title="Alpha")
    p2 = upload_pdf(client, token, tmp_path, name="b.pdf", pages=(("Other content here",),), title="Beta")
    p3 = upload_pdf(client, token, tmp_path, name="c.pdf", pages=(("Third paper text",),), title="Gamma")
    # 乱序设置 sort_order：p3=0, p1=1, p2=2
    client.patch(f"/api/papers/{p3['id']}", json={"sort_order": 0}, headers=auth(token))
    client.patch(f"/api/papers/{p1['id']}", json={"sort_order": 1}, headers=auth(token))
    client.patch(f"/api/papers/{p2['id']}", json={"sort_order": 2}, headers=auth(token))
    r = client.get("/api/papers", params={"sort": "manual"}, headers=auth(token))
    assert [p["id"] for p in r.json()] == [p3["id"], p1["id"], p2["id"]]


def test_upload_sort_order_init(client, tmp_path):
    token = register(client)
    r = client.post("/api/projects", json={"name": "P"}, headers=auth(token))
    proj_id = r.json()["id"]
    p1 = upload_pdf(client, token, tmp_path, name="a.pdf", project_id=proj_id)
    p2 = upload_pdf(client, token, tmp_path, name="b.pdf",
                    pages=(("Other content here",),), project_id=proj_id)
    assert p1["sort_order"] == 0
    assert p2["sort_order"] == 1
    # 未分组独立计数，从 0 起
    p3 = upload_pdf(client, token, tmp_path, name="c.pdf", pages=(("Third paper text",),))
    assert p3["sort_order"] == 0


def test_path_traversal_rejected(client, tmp_path, data_dir):
    from app.core.util import ensure_within
    import pytest

    with pytest.raises(PermissionError):
        ensure_within(data_dir, data_dir / ".." / "evil.txt")
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    # file_hash 越界访问
    r = client.get(f"/api/papers/{paper['id']}/ocr-result", headers=auth(token))
    assert r.status_code == 404


def test_upload_extracts_meta_from_first_page(client, tmp_path):
    """G1：Info 元数据缺失时，从首页文本识别 arxiv_id/doi/year/authors。"""
    from conftest import make_pdf_bytes

    path = tmp_path / "meta.pdf"
    path.write_bytes(make_pdf_bytes(
        (
            ("arXiv:2401.12345v2", "Deep Learning for Robust Paper Metadata Extraction",
             "John Smith, Jane Doe", "10.1234/abc.def", "Received 2024 ACM."),
        ),
        title=None, author=None,
    ))
    with open(path, "rb") as f:
        r = client.post("/api/papers/upload", files={"file": ("meta.pdf", f, "application/pdf")},
                        data={"is_scanned": "false"}, headers=auth(register(client)))
    assert r.status_code == 200, r.text
    p = r.json()["paper"]
    assert p["arxiv_id"] == "2401.12345"  # 去版本号
    assert p["doi"] == "10.1234/abc.def"
    assert p["year"] == 2024
    # authors 无文本启发式（真实论文集实测摘要句混入率不可接受，宁缺勿错）
    assert p["authors"] is None


def test_upload_meta_absent_stays_none(client, tmp_path):
    """G5：首页无可识别信息时字段全空，不虚构。"""
    from conftest import make_pdf_bytes

    path = tmp_path / "plain.pdf"
    path.write_bytes(make_pdf_bytes((("Just some plain text here",),), title=None, author=None))
    with open(path, "rb") as f:
        r = client.post("/api/papers/upload", files={"file": ("plain.pdf", f, "application/pdf")},
                        data={"is_scanned": "false"}, headers=auth(register(client)))
    p = r.json()["paper"]
    assert p["arxiv_id"] is None
    assert p["doi"] is None
    assert p["year"] is None


def test_extract_meta_fills_only_empty(client, tmp_path):
    """G3：补识别仅填空字段——已有 year 不被覆盖。"""
    from conftest import make_pdf_bytes

    token = register(client)
    path = tmp_path / "fill.pdf"
    path.write_bytes(make_pdf_bytes(
        (("arXiv:2401.12345", "10.1234/abc.def",),),
        title=None, author=None,
    ))
    with open(path, "rb") as f:
        r = client.post("/api/papers/upload", files={"file": ("fill.pdf", f, "application/pdf")},
                        data={"is_scanned": "false"}, headers=auth(token))
    pid = r.json()["paper"]["id"]
    # 用户预填 year（模拟手改）
    r = client.patch(f"/api/papers/{pid}", json={"year": 2020}, headers=auth(token))
    assert r.json()["year"] == 2020
    r = client.post(f"/api/papers/{pid}/extract-meta", headers=auth(token))
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["year"] == 2020  # 已有值不覆盖
    assert p["arxiv_id"] == "2401.12345"  # 空字段被补上
    assert p["doi"] == "10.1234/abc.def"


def test_upload_title_from_font_size(client, tmp_path):
    """G1：无 Info Title 时按字体大小识别标题——长作者行/摘要行不再胜出。"""
    token = register(client)
    paper = upload_pdf(
        client, token, tmp_path, name="font.pdf", title=None,
        pages=((
            "Running head: small header text",
            "Deep Learning for Robust Paper Metadata Extraction",
            "Alice B, Carol D, Eve F, Grace H, Ivan J, Kate L, Mona P",
            "This is a plain abstract sentence with a comma, and more text following it here.",
        ),),
        sizes={0: 9, 1: 18, 2: 10, 3: 10},
    )
    assert paper["title"] == "Deep Learning for Robust Paper Metadata Extraction"
    assert "Alice" not in paper["title"]


def test_upload_uniform_font_falls_back_to_filename(client, tmp_path):
    """S10 回归锚：统一字号（无大字标题）→ title 为 None → 落文件名兜底。"""
    token = register(client)
    paper = upload_pdf(
        client, token, tmp_path, name="uniform-font-fallback.pdf", title=None,
        pages=(("Just a uniform body line",), ("Another uniform body line here",)),
    )
    assert paper["title"] == "uniform-font-fallback"
