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
    # page_no 为 1-based（与前端/数据库一致）；pypdf add_annotation 0-based
    add_annotation(client, token, paper["id"], page_no=1, color="yellow", text="中文弹窗笔记")
    add_annotation(client, token, paper["id"], page_no=2, color="blue", text="第二页批注",
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
    assert "/Text" not in subtypes  # 不再输出 Text 便签注释，文本并入 Highlight /Contents
    assert any("中文弹窗笔记" in c for c in contents)  # 中文 /Contents UTF-16BE 写回
    assert any("第二页批注" in c for c in contents)

    # off-by-one 回归：批注必须落在正确的页（1-based page_no=1 → 第 1 页 index 0）
    page0_annots = reader.pages[0].get("/Annots") or []
    page1_annots = reader.pages[1].get("/Annots") or []
    page0_hl = [a.get_object() for a in page0_annots if str(a.get_object().get("/Subtype")) == "/Highlight"]
    page1_hl = [a.get_object() for a in page1_annots if str(a.get_object().get("/Subtype")) == "/Highlight"]
    assert len(page0_hl) == 1, f"第 1 页应有 1 个高亮，实际 {len(page0_hl)}（off-by-one 回归）"
    assert len(page1_hl) == 1
    qp = [float(v) for v in page0_hl[0]["/QuadPoints"]]
    # 规范顺序 LL UL UR LR = [x0,y0, x0,y1, x1,y1, x1,y0]
    assert qp[0] == qp[2] and qp[1] < qp[3], "QuadPoints 第一点应为左下角 (x0,y0)"
    assert qp[4] == qp[6] and qp[5] == qp[3], "第三点应为右上角 (x1,y1)"

    # 半透明 + AP 外观流：无 AP 时 Edge/Chrome(PDFium) 不渲染高亮，此处为回归保护
    hl = page0_hl[0]
    assert float(hl["/CA"]) == 0.6
    assert [round(float(x), 3) for x in hl["/C"]] == [1.0, 0.878, 0.541]  # 黄色不透明(红)说明 FloatObject 截断回归
    ap_n = hl["/AP"]["/N"]
    assert isinstance(ap_n.get_object(), dict)  # stream 已注册为间接对象
    assert str(ap_n.get_object().get("/Subtype")) == "/Form"
    data = ap_n.get_object().get_data()
    assert b"re\n" in data and b"/GS0 gs" in data  # 内容流逐矩形绘制 + 半透明 ExtGState


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
