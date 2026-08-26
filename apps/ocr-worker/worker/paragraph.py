"""行级 OCR 结果 → 段落块聚合；像素坐标 → PDF 用户空间。"""


def _rect(box):
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def _split_columns(lines, page_w):
    """按行中心 x 贪心聚类成列（列间隙 > 页宽 12% 视为分栏）。
    单栏布局全部行聚一列 = 行为与旧版一致；双栏学术排版各列独立成序，
    消除全局 y 排序导致的 左-右-左-右 交错。返回 [列内行列表]，列按 x 升序。"""
    if page_w <= 0 or len(lines) < 2:
        return [lines]
    gap_threshold = page_w * 0.12
    ordered = sorted(lines, key=lambda l: l["xc"])
    columns = []
    for line in ordered:
        placed = False
        for col in columns:
            # 与列的 x 区间有实质重叠（>行宽 40%）→ 归入该列
            for m in col:
                overlap = min(m["bbox"][2], line["bbox"][2]) - max(m["bbox"][0], line["bbox"][0])
                w = min(m["bbox"][2] - m["bbox"][0], line["bbox"][2] - line["bbox"][0])
                if w > 0 and overlap > 0.4 * w:
                    col.append(line)
                    placed = True
                    break
            if placed:
                break
        if not placed:
            # 与现有列的间隙检查：贴近某列右缘（跨栏图表行）也归入
            for col in columns:
                col_x1 = max(m["bbox"][2] for m in col)
                if 0 <= line["bbox"][0] - col_x1 <= gap_threshold:
                    col.append(line)
                    placed = True
                    break
        if not placed:
            columns.append([line])
    # 列合并：x 区间重叠的列归并（聚类碎片）
    columns.sort(key=lambda col: min(m["bbox"][0] for m in col))
    merged = []
    for col in columns:
        if merged:
            prev_x1 = max(m["bbox"][2] for m in merged[-1])
            cur_x0 = min(m["bbox"][0] for m in col)
            if cur_x0 - prev_x1 < gap_threshold * 0.5:
                merged[-1].extend(col)
                continue
        merged.append(col)
    return merged


def group_lines(boxes, txts, scores):
    """列感知聚合：先分栏（消除双栏左右交错），栏内按 y 排序后合并同段行。
    同列（相邻行 x 重叠>60% 的行宽）且行距<1.6×行高 → 合并为 block。"""
    lines = []
    for box, txt, score in zip(boxes, txts, scores):
        x0, y0, x1, y1 = _rect(box)
        lines.append(
            {"bbox": (x0, y0, x1, y1), "text": txt, "conf": score,
             "yc": (y0 + y1) / 2.0, "xc": (x0 + x1) / 2.0, "h": max(y1 - y0, 1.0)}
        )
    if not lines:
        return []
    page_w = max(l["bbox"][2] for l in lines) - min(l["bbox"][0] for l in lines)

    blocks = []
    for column in _split_columns(lines, page_w):
        column.sort(key=lambda line: line["yc"])
        for line in column:
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
