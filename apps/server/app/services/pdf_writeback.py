"""批注写回 PDF（pypdf 6）：Highlight 高亮（半透明混合 + Contents 文本），输出 xxx_批注版.pdf 副本。"""
import io
import json
from pathlib import Path

from pypdf import PdfWriter
from pypdf.annotations import Highlight
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)

COLORS = {
    "yellow": "FFE08A", "green": "A8D5A2", "blue": "A9D3E8",
    "pink": "F5B8C4", "purple": "C9B6E4",
}


def _rgb(hex_color: str) -> list[FloatObject]:
    """#RRGGBB → PDF /C 数组（0-1）。必须用 FloatObject：pypdf 6 的 NumberObject 强制 int 会截断浮点"""
    h = hex_color.lstrip("#")
    return [FloatObject(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)]


def writeback(pdf_path: Path, annotations: list[dict]) -> bytes:
    """annotations: [{page_no, anchor_json, color, text}]；返回新 PDF 字节。"""
    writer = PdfWriter(clone_from=str(pdf_path))
    by_page: dict[int, list[dict]] = {}
    for a in annotations:
        by_page.setdefault(int(a["page_no"]), []).append(a)
    for page_no, annos in by_page.items():
        page_index = page_no - 1  # 前端 page_no 1-based，pypdf add_annotation 0-based
        if page_index < 0 or page_index >= len(writer.pages):
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
                # PDF QuadPoints 规范顺序：左下 左上 右上 右下（LL UL UR LR）
                quads.extend([
                    FloatObject(x0), FloatObject(y0),
                    FloatObject(x0), FloatObject(y1),
                    FloatObject(x1), FloatObject(y1),
                    FloatObject(x1), FloatObject(y0),
                ])
            bx0 = min(r[0] for r in rects)
            by0 = min(r[1] for r in rects)
            bx1 = max(r[2] for r in rects)
            by1 = max(r[3] for r in rects)
            highlight = Highlight(
                rect=(bx0, by0, bx1, by1), quad_points=quads, highlight_color=color,
            )
            rgb = _rgb(color)
            # 半透明（0.6）让文字透出；用 FloatObject（pypdf 6 的 NumberObject 强制 int 会截断浮点）
            highlight[NameObject("/CA")] = FloatObject(0.6)
            highlight[NameObject("/C")] = ArrayObject(rgb)
            text = (a.get("text") or "").strip()
            if text:
                highlight[NameObject("/Contents")] = TextStringObject(text[:500])
            # AP 外观流：多数阅读器（Edge/Chrome 的 PDFium、MuPDF）只画带 /AP 的注释，
            # 无 AP 时高亮缺失/表现不一。Form XObject 内用半透明 ExtGState 逐矩形绘制。
            ops = [b"q\n/GS0 gs\n", f"{rgb[0]} {rgb[1]} {rgb[2]} rg\n".encode()]
            for x0, y0, x1, y1 in rects:
                ops.append(f"{x0} {y0} {x1 - x0} {y1 - y0} re\n".encode())
            ops.append(b"f\nQ\n")
            ap_stream = StreamObject()
            ap_stream.update({
                NameObject("/Type"): NameObject("/XObject"),
                NameObject("/Subtype"): NameObject("/Form"),
                NameObject("/FormType"): NumberObject(1),
                NameObject("/BBox"): ArrayObject([FloatObject(bx0), FloatObject(by0), FloatObject(bx1), FloatObject(by1)]),
                NameObject("/Resources"): DictionaryObject({
                    NameObject("/ExtGState"): DictionaryObject({
                        NameObject("/GS0"): DictionaryObject({
                            NameObject("/Type"): NameObject("/ExtGState"),
                            NameObject("/CA"): FloatObject(0.6),
                            NameObject("/ca"): FloatObject(0.6),
                        })
                    })
                }),
            })
            ap_stream.set_data(b"".join(ops))
            highlight[NameObject("/AP")] = DictionaryObject(
                {NameObject("/N"): writer._add_object(ap_stream)}  # stream 必须为间接对象
            )
            writer.add_annotation(page_number=page_index, annotation=highlight)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
