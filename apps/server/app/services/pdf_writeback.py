"""批注写回 PDF（pypdf 6）：Highlight + Text 弹窗注释，输出 xxx_批注版.pdf 副本。"""
import io
import json
from pathlib import Path

from pypdf import PdfWriter
from pypdf.annotations import Highlight, Popup, Text
from pypdf.generic import ArrayObject, FloatObject

COLORS = {
    "yellow": "FFE08A", "green": "A8D5A2", "blue": "A9D3E8",
    "pink": "F5B8C4", "purple": "C9B6E4",
}


def writeback(pdf_path: Path, annotations: list[dict]) -> bytes:
    """annotations: [{page_no, anchor_json, color, text}]；返回新 PDF 字节。"""
    writer = PdfWriter(clone_from=str(pdf_path))
    by_page: dict[int, list[dict]] = {}
    for a in annotations:
        by_page.setdefault(int(a["page_no"]), []).append(a)
    for page_no, annos in by_page.items():
        if page_no < 0 or page_no >= len(writer.pages):
            continue
        for a in annos:
            try:
                anchor = json.loads(a.get("anchor_json") or "{}")
            except ValueError:
                anchor = {}
            rects = anchor.get("rects") or []
            if not rects:
                continue
            color = COLORS.get((a.get("color") or "yellow").lower(), "FFE08A")
            quads = ArrayObject()
            for x0, y0, x1, y1 in rects:
                # PDF QuadPoints 顺序：左上 右上 左下 右下
                quads.extend([
                    FloatObject(x0), FloatObject(y1),
                    FloatObject(x1), FloatObject(y1),
                    FloatObject(x0), FloatObject(y0),
                    FloatObject(x1), FloatObject(y0),
                ])
            bx0 = min(r[0] for r in rects)
            by0 = min(r[1] for r in rects)
            bx1 = max(r[2] for r in rects)
            by1 = max(r[3] for r in rects)
            highlight = Highlight(
                rect=(bx0, by0, bx1, by1), quad_points=quads, highlight_color=color,
            )
            writer.add_annotation(page_number=page_no, annotation=highlight)
            note = Text(rect=(bx0, by0, bx1, by1), text=(a.get("text") or "")[:500])
            note_ref = writer.add_annotation(page_number=page_no, annotation=note)
            popup = Popup(rect=(bx0, by0, bx1, by1), parent=note_ref, open=False)
            writer.add_annotation(page_number=page_no, annotation=popup)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
