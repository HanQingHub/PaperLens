"""行级 OCR 结果 → 段落块聚合；像素坐标 → PDF 用户空间。"""


def _rect(box):
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def group_lines(boxes, txts, scores):
    """同列（相邻行 x 重叠>60% 的行宽）且行距<1.6×行高 → 合并为 block。
    返回 block 列表，每 block 为行 dict 列表（按 y 排序）。"""
    lines = []
    for box, txt, score in zip(boxes, txts, scores):
        x0, y0, x1, y1 = _rect(box)
        lines.append(
            {"bbox": (x0, y0, x1, y1), "text": txt, "conf": score,
             "yc": (y0 + y1) / 2.0, "h": max(y1 - y0, 1.0)}
        )
    lines.sort(key=lambda line: line["yc"])

    blocks = []
    for line in lines:
        merged = False
        if blocks:
            prev = blocks[-1][-1]
            overlap = min(prev["bbox"][2], line["bbox"][2]) - max(prev["bbox"][0], line["bbox"][0])
            min_w = min(prev["bbox"][2] - prev["bbox"][0], line["bbox"][2] - line["bbox"][0])
            x_ok = min_w > 0 and overlap > 0.6 * min_w
            avg_h = (prev["h"] + line["h"]) / 2.0
            y_ok = (line["yc"] - prev["yc"]) < 1.6 * avg_h
            if x_ok and y_ok:
                blocks[-1].append(line)
                merged = True
        if not merged:
            blocks.append([line])
    return blocks


def to_pdf_bbox(px_bbox, scale, page_h_pt):
    x0, y0, x1, y1 = px_bbox
    return [
        round(x0 / scale, 2),
        round(page_h_pt - y1 / scale, 2),
        round(x1 / scale, 2),
        round(page_h_pt - y0 / scale, 2),
    ]


def blocks_to_pdf(blocks_px, scale, page_h_pt):
    blocks = []
    for lines_px in blocks_px:
        lines = []
        for line in lines_px:
            lines.append(
                {"bbox": to_pdf_bbox(line["bbox"], scale, page_h_pt),
                 "text": line["text"], "conf": round(line["conf"], 4)}
            )
        x0 = min(line["bbox"][0] for line in lines)
        ya = min(line["bbox"][1] for line in lines)
        x1 = max(line["bbox"][2] for line in lines)
        yb = max(line["bbox"][3] for line in lines)
        conf = sum(line["conf"] for line in lines) / len(lines)
        blocks.append(
            {"bbox": [x0, ya, x1, yb], "conf": round(conf, 4),
             "text": " ".join(line["text"] for line in lines), "lines": lines}
        )
    return blocks
