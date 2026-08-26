"""行级 OCR 结果 → 段落块聚合；像素坐标 → PDF 用户空间。"""


def _rect(box):
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def _split_columns(lines, page_w):
    """双/多栏检测与切分。返回 [列内行列表]（列按 x 升序），无法可靠切分时返回 [lines]（单栏）。

    算法（对真实学术排版鲁棒）：
    1. 通栏行（行宽 > 75% 页宽，标题/图表）先分离——它们会毒化列聚类；
    2. 剩余正文行按 x0 排序，扫描相邻行间的水平空白带（前行右缘 → 后行左缘），
       空白带 > 页宽 4% 即候选分栏边界；取最宽边界切两栏，两侧各自再找一次；
    3. 通栏行不参与列序，单独成组由调用方按 y 归位。
    """
    if page_w <= 0 or len(lines) < 4:
        return [lines]
    span_threshold = page_w * 0.75
    gap_threshold = page_w * 0.03

    spanning = [l for l in lines if (l["bbox"][2] - l["bbox"][0]) > span_threshold]
    body = [l for l in lines if (l["bbox"][2] - l["bbox"][0]) <= span_threshold]
    if len(body) < 4:
        return [lines]

    body.sort(key=lambda l: l["bbox"][0])
    gaps = []
    for a, b in zip(body, body[1:]):
        gap = b["bbox"][0] - a["bbox"][2]
        if gap > gap_threshold:
            gaps.append((gap, a, b))
    if not gaps:
        return [lines]

    def _split_two(subset):
        """在子集内找最宽空白带切两半；无显著空白带返回 [subset]。"""
        if len(subset) < 2:
            return [subset]
        ordered = sorted(subset, key=lambda l: l["bbox"][0])
        best, best_gap = None, gap_threshold
        for a, b in zip(ordered, ordered[1:]):
            gap = b["bbox"][0] - a["bbox"][2]
            if gap > best_gap:
                best, best_gap = (a, b), gap
        if best is None:
            return [subset]
        a, b = best
        left = [l for l in subset if l["bbox"][0] <= a["bbox"][2] and l["bbox"][0] < b["bbox"][0]]
        right = [l for l in subset if l["bbox"][0] >= b["bbox"][0]]
        if len(left) < 2 or len(right) < 2:
            return [subset]
        out = []
        for part in (left, right):
            out.append(sorted(part, key=lambda l: l["yc"]))
        return out

    groups = _split_two(body)
    if len(groups) >= 2:
        # 两侧各自再尝试一次次级切分（三栏排版）
        expanded = []
        for g in groups:
            expanded.extend(_split_two(g))
        groups = expanded
    else:
        groups = [sorted(body, key=lambda l: l["yc"])]

    if spanning:
        groups.append(sorted(spanning, key=lambda l: l["yc"]))
    return groups


def group_lines(boxes, txts, scores):
    """列感知聚合：先分栏（消除双栏左右交错），栏内按 y 排序后合并同段行。
    同列（相邻行 x 重叠>60% 的行宽）且行距<1.6×行高 → 合并为 block。
    通栏行（标题/图表）的块按 y 中心归位到全局块序列。"""
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

    column_groups = _split_columns(lines, page_w)
    if len(column_groups) == 1:
        return _aggregate_column(column_groups[0])

    # 多栏：列优先输出（先左栏全部块再右栏，消除同 y 左右交错）。
    # 通栏组（x 覆盖 > 75% 页宽，标题/图表）按 y 归位：页首通栏置顶、
    # 页尾通栏置底、页中通栏保守置顶（标题场景远多于页中图表）。
    def col_span(col):
        return max(m["bbox"][2] for m in col) - min(m["bbox"][0] for m in col)

    spanning_idx = None
    for i, col in enumerate(column_groups):
        if col_span(col) > page_w * 0.75:
            spanning_idx = i
            break

    ordered = []
    spanning_blocks = []
    col_ycs = []
    for ci, col in enumerate(column_groups):
        if ci == spanning_idx:
            continue
        for b in _aggregate_column(col):
            yc = sum(m["yc"] for m in b) / len(b)
            ordered.append(b)
            col_ycs.append(yc)
    if spanning_idx is not None:
        for b in _aggregate_column(column_groups[spanning_idx]):
            yc = sum(m["yc"] for m in b) / len(b)
            spanning_blocks.append((yc, b))
    spanning_blocks.sort(key=lambda t: t[0])

    if spanning_blocks:
        if col_ycs and spanning_blocks[0][0] > max(col_ycs):
            # 页尾通栏：追加到最后
            ordered.extend(b for _, b in spanning_blocks)
        else:
            # 页首/页中通栏：置顶
            ordered = [b for _, b in spanning_blocks] + ordered
    return ordered


def _aggregate_column(column):
    """单列内的 y 排序 + 相邻行合并（原单栏算法）。"""
    column = sorted(column, key=lambda line: line["yc"])
    blocks = []
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
