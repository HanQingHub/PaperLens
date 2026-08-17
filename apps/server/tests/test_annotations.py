import json

from conftest import auth, register, upload_pdf


def add_annotation(client, token, paper_id, page_no=0, color="yellow", text="笔记内容",
                   rects=((100, 600, 300, 650),)):
    return client.post(
        f"/api/papers/{paper_id}/annotations",
        json={"page_no": page_no, "type": "sentence",
              "anchor_json": json.dumps({"rects": [list(r) for r in rects], "text": "anchored text"}),
              "color": color, "text": text},
        headers=auth(token),
    )


def test_annotation_crud(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = add_annotation(client, token, paper["id"])
    assert r.status_code == 201
    a = r.json()
    assert a["color"] == "yellow"

    r = client.get(f"/api/papers/{paper['id']}/annotations", headers=auth(token))
    assert len(r.json()) == 1

    r = client.patch(f"/api/annotations/{a['id']}", json={"text": "新笔记", "color": "blue"}, headers=auth(token))
    assert r.json()["text"] == "新笔记"

    r = client.delete(f"/api/annotations/{a['id']}", headers=auth(token))
    assert r.status_code == 204
    assert client.get(f"/api/papers/{paper['id']}/annotations", headers=auth(token)).json() == []


def test_annotation_validation(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post(f"/api/papers/{paper['id']}/annotations",
                    json={"page_no": 0, "type": "bogus", "anchor_json": "{}"}, headers=auth(token))
    assert r.status_code == 400
    r = client.post(f"/api/papers/{paper['id']}/annotations",
                    json={"page_no": 0, "type": "sentence", "anchor_json": "not json"}, headers=auth(token))
    assert r.status_code == 400


def test_annotation_isolation(client, tmp_path):
    ta = register(client, "alice")
    tb = register(client, "bob")
    paper = upload_pdf(client, ta, tmp_path)
    r = client.get(f"/api/papers/{paper['id']}/annotations", headers=auth(tb))
    assert r.status_code == 404


def test_export_pdf_contains_highlight_and_text(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path, pages=(("Hello world", "Second line"), ("Page two",)))
    add_annotation(client, token, paper["id"], page_no=0, color="yellow", text="中文弹窗笔记")
    add_annotation(client, token, paper["id"], page_no=1, color="blue", text="第二页批注",
                   rects=((50, 100, 200, 150), (210, 100, 400, 150)))
    r = client.post(f"/api/papers/{paper['id']}/export-annotations-pdf", headers=auth(token))
    assert r.status_code == 200
    out = tmp_path / "exported.pdf"
    out.write_bytes(r.content)

    from pypdf import PdfReader

    reader = PdfReader(str(out))
    assert len(reader.pages) == 2
    subtypes = []
    contents = []
    for page in reader.pages:
        for ref in page.get("/Annots") or []:
            obj = ref.get_object()
            subtypes.append(str(obj.get("/Subtype")))
            if obj.get("/Contents"):
                contents.append(str(obj.get("/Contents")))
    assert "/Highlight" in subtypes
    assert "/Text" in subtypes
    assert any("中文弹窗笔记" in c for c in contents)  # 中文 /Contents UTF-16BE 写回
    assert any("第二页批注" in c for c in contents)


def test_export_md(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    add_annotation(client, token, paper["id"], text="md 笔记")
    r = client.post(f"/api/papers/{paper['id']}/export-annotations-md", headers=auth(token))
    assert r.status_code == 200
    text = r.content.decode("utf-8")
    assert "md 笔记" in text
    assert "anchored text" in text  # 摘录文本
    assert "p.0" in text
