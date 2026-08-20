import io
import json

from pypdf import PdfReader

from pdfgen import make_pdf_bytes
from app.services import pdf_writeback


def test_writeback_annotations_geometry_and_metadata(tmp_path):
    src = tmp_path / "src.pdf"
    src.write_bytes(make_pdf_bytes((("page one",), ("page two",), ("page three",))))

    annos = [
        {"page_no": 1, "anchor_json": json.dumps({"rects": [[10, 10, 50, 40]]}),
         "color": "yellow", "text": "first"},
        {"page_no": 2, "anchor_json": json.dumps({"rects": [[100, 100, 200, 150], [300, 300, 400, 350]]}),
         "color": "green", "text": "second"},
        {"page_no": 99, "anchor_json": json.dumps({"rects": [[0, 0, 10, 10]]}),
         "color": "pink", "text": "out-of-range"},
    ]
    data = pdf_writeback.writeback(src, annos)
    reader = PdfReader(io.BytesIO(data))

    a1 = reader.pages[0]["/Annots"][0].get_object()
    quads = [float(v) for v in a1["/QuadPoints"]]
    # PDF QuadPoints 规范顺序：LL UL UR LR
    assert quads == [10.0, 10.0, 10.0, 40.0, 50.0, 40.0, 50.0, 10.0]
    assert [round(float(v), 4) for v in a1["/C"]] == [1.0, round(224 / 255, 4), round(138 / 255, 4)]
    assert round(float(a1["/CA"]), 4) == 0.6
    assert str(a1["/Contents"]) == "first"
    assert "/AP" in a1 and "/N" in a1["/AP"]

    a2 = reader.pages[1]["/Annots"][0].get_object()
    assert len(a2["/QuadPoints"]) == 16  # 2 个矩形 × 8 个点
    assert str(a2["/Contents"]) == "second"

    # 越界页被跳过
    assert "/Annots" not in reader.pages[2]


def test_writeback_invalid_anchor_and_missing_rects_skipped(tmp_path):
    src = tmp_path / "src.pdf"
    src.write_bytes(make_pdf_bytes((("single page",),)))
    data = pdf_writeback.writeback(src, [
        {"page_no": 1, "anchor_json": "{not json", "color": "yellow", "text": "bad"},
        {"page_no": 1, "anchor_json": "{}", "color": "yellow", "text": "no rects"},
    ])
    reader = PdfReader(io.BytesIO(data))
    assert "/Annots" not in reader.pages[0]