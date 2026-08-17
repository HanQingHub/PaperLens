"""自制最小文本 PDF fixture（无第三方写库依赖）。"""


def make_pdf_bytes(pages_lines: list[tuple[str, ...]] | tuple[str, ...] = (("Hello world", "Second line"),),
                   title: str | None = "Test Paper", author: str | None = "Test Author") -> bytes:
    if pages_lines and isinstance(pages_lines[0], str):
        pages_lines = [pages_lines]  # type: ignore[assignment]
    n = len(pages_lines)
    font_no = 3
    page_nos = [4 + 2 * i for i in range(n)]
    content_nos = [5 + 2 * i for i in range(n)]
    info_no = 4 + 2 * n

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    bodies: dict[int, bytes] = {}
    bodies[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{p} 0 R" for p in page_nos)
    bodies[2] = f"<< /Type /Pages /Count {n} /Kids [{kids}] >>".encode()
    bodies[font_no] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    for i, lines in enumerate(pages_lines):
        bodies[page_nos[i]] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_no} 0 R >> >> /Contents {content_nos[i]} 0 R >>"
        ).encode()
        ops = b"BT /F1 12 Tf 72 720 Td 16 TL\n"
        for ln in lines:
            ops += f"({esc(ln)}) Tj T*\n".encode("latin-1", "replace")
        ops += b"ET"
        bodies[content_nos[i]] = (
            b"<< /Length %d >>\nstream\n" % len(ops) + ops + b"\nendstream"
        )
    info = f"<< /Title ({esc(title or '')}) /Author ({esc(author or '')}) /Producer (paperlens-tests) >>"
    bodies[info_no] = info.encode("latin-1", "replace")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}
    for num in sorted(bodies):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + bodies[num] + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {info_no + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, info_no + 1):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {info_no + 1} /Root 1 0 R /Info {info_no} 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


def make_pdf_file(path, pages_lines=(("Hello world", "Second line"),), title="Test Paper",
                  author="Test Author"):
    from pathlib import Path

    p = Path(path)
    p.write_bytes(make_pdf_bytes(pages_lines, title, author))
    return p
