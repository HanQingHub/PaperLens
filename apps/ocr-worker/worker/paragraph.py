"""行级 OCR 结果 → 段落块聚合；像素坐标 → PDF 显示空间。

聚合分三步：
  1. 版面切栏：把每条检测行当作 x 区间的覆盖，只有"全页高度上完全无覆盖"的
     竖直空白带才可能是栏间沟槽。旧实现按 x0 排序后找相邻行间隙，单栏页里
     一条右移的行（页码、行尾公式）就会被误判成栏边界，导致块的阅读顺序被
     打乱（整页左右交错）。覆盖法对单栏/双栏/三栏一致可靠。
  2. 分栏内按 y 合并段落：x 重叠 >60% 且行距 <1.6×行高；若行距 >1.3×行高
     且上一行以句末标点收尾，则断段（避免几十行粘成一块，语料粒度失真）。
  3. 通栏元素（标题/图/表）把页面切成水平区带，按"区带 → 栏 → 块"输出，
     得到 左栏上半 → 右栏上半 → 通栏图 → 左栏下半 → 右栏下半 的阅读顺序。

坐标：渲染位图坐标（原点左上，已按 /Rotate 旋转，与 pdf.js 视口一致）
÷ scale 后翻转 y → PDF 显示空间（原点左下）。页面旋转不需要额外补偿：
pypdfium2 的 get_size() 返回的是应用旋转后的尺寸，与位图宽高一致。
"""
import re

_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?%)\]}])")
_SPACE_AFTER_OPEN = re.compile(r"([(\[{])\s+")
_MULTI_SPACE = re.compile(r"\s{2,}")
_SENT_END = re.compile(r"[.!?;:。！？…”\"')\]]\s*$")


def _rect(box):
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def tidy_text(text):
    """OCR 行内空白的轻量整理（标点前后空格、多空格折叠），不动数学符号间距。"""
    if not text:
        return ""
    t = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
    t = _SPACE_AFTER_OPEN.sub(r"\1", t)
    t = _MULTI_SPACE.sub(" ", t)
    return t.strip()


def _coverage_gaps(lines, page_w):
    """全页无覆盖的竖直空白带（候选栏间沟槽），按宽度降序返回 [(x0, x1, w)]。"""
    bins = 240
    cover = [0] * bins
    for l in lines:
        x0, x1 = l["bbox"][0], l["bbox"][2]
        a = max(0, min(bins - 1, int(x0 / page_w * bins)))
        b = max(a + 1, min(bins, int(x1 / page_w * bins)))
        for i in range(a, b):
            cover[i] += 1
    gaps = []
    start = None
    for i, c in enumerate(cover):
        if c == 0:
            if start is None:
                start = i
        elif start is not None:
            gaps.append((start, i))
            start = None
    if start is not None:
        gaps.append((start, bins))
    out = []
    for a, b in gaps:
        x0 = a / bins * page_w
        x1 = b / bins * page_w
        # 页边留白不是沟槽；过窄的缝多为字间空隙，不算
        if x0 < page_w * 0.12 or x1 > page_w * 0.88:
            continue
        if (x1 - x0) < page_w * 0.015:
            continue
        out.append((x0, x1, x1 - x0))
    out.sort(key=lambda t: -t[2])
    return out


def split_columns(body_lines, page_w, depth=0):
    """按覆盖沟槽切栏（递归一层，支持三栏）；失败回退单栏。"""
    if page_w <= 0 or len(body_lines) < 6 or depth > 1:
        return [body_lines]
    for x0, x1, _w in _coverage_gaps(body_lines, page_w):
        mid = (x0 + x1) / 2.0
        left = [l for l in body_lines if (l["bbox"][0] + l["bbox"][2]) / 2.0 < mid]
        right = [l for l in body_lines if (l["bbox"][0] + l["bbox"][2]) / 2.0 >= mid]
        if len(left) >= 3 and len(right) >= 3:
            out = []
            for part in (left, right):
                out.extend(split_columns(part, page_w, depth + 1))
            return out
    return [body_lines]


def _aggregate_column(column):
    """同栏内按 y 排序 + 合并同段行。"""
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
            gap = line["yc"] - prev["yc"]
            # 行距正常 → 同段；行距明显偏大且上一行已收句 → 断段
            para_break = gap > 1.3 * avg_h and bool(_SENT_END.search(prev["text"]))
            if x_ok and gap < 1.6 * avg_h and not para_break:
                blocks[-1].append(line)
                merged = True
        if not merged:
            blocks.append([line])
    return blocks


def _block_yc(block):
    return sum(m["yc"] for m in block) / len(block)


def _is_noise_line(line, page_w):
    """单字符装饰/竖线残片：整行仅一个 I/l/V/| 且宽度极窄 —— 版面噪声，进叠加层只会
    在页面上留下一个可被划中的幽灵字符。"""
    t = (line.get("text") or "").strip()
    if len(t) != 1 or t not in "IlVv|1":
        return False
    w = line["bbox"][2] - line["bbox"][0]
    return w < page_w * 0.05


def group_lines(boxes, txts, scores, page_w=None):
    """列感知聚合：返回按阅读顺序排列的块（每块是行 dict 列表）。

    page_w：页面渲染宽度（像素）。缺省时用检测内容宽度兜底（不推荐：单栏页
    的短行会让内容宽度远小于页宽，栏检测阈值失真）。
    """
    lines = []
    for box, txt, score in zip(boxes, txts, scores):
        x0, y0, x1, y1 = _rect(box)
        text = tidy_text(txt)
        if not text:
            continue
        lines.append(
            {"bbox": (x0, y0, x1, y1), "text": text, "conf": score,
             "yc": (y0 + y1) / 2.0, "xc": (x0 + x1) / 2.0, "h": max(y1 - y0, 1.0)}
        )
    if not lines:
        return []
    page_w = float(page_w or 0)
    if page_w <= 0:
        page_w = max(l["bbox"][2] for l in lines) - min(l["bbox"][0] for l in lines)
        page_w = max(page_w, 1.0)
    lines = [l for l in lines if not _is_noise_line(l, page_w)]
    if not lines:
        return []

    span_thr = page_w * 0.78
    spanning = [l for l in lines if (l["bbox"][2] - l["bbox"][0]) > span_thr]
    body = [l for l in lines if (l["bbox"][2] - l["bbox"][0]) <= span_thr]

    if not spanning:
        columns = split_columns(body, page_w) if body else []
        if len(columns) <= 1:
            return _aggregate_column(body or lines)
        col_blocks = [_aggregate_column(c) for c in columns]
        ordered = []
        for blocks in col_blocks:
            ordered.extend(blocks)
        return ordered

    if not body:
        return _aggregate_column(spanning)

    columns = split_columns(body, page_w)
    col_blocks = [_aggregate_column(c) for c in columns]
    span_blocks = _aggregate_column(spanning)
    span_blocks.sort(key=_block_yc)
    span_ycs = [_block_yc(b) for b in span_blocks]

    # 通栏元素把页面切成 len(span)+1 个水平区带；区带内按栏序读，再读该区带下方的通栏块
    regions = len(span_blocks) + 1
    buckets = [[[] for _ in col_blocks] for _ in range(regions)]
    for ci, blocks in enumerate(col_blocks):
        for b in blocks:
            r = sum(1 for sy in span_ycs if sy < _block_yc(b))
            buckets[min(r, regions - 1)][ci].append(b)

    ordered = []
    for r in range(regions):
        for ci in range(len(col_blocks)):
            ordered.extend(buckets[r][ci])
        if r < len(span_blocks):
            ordered.append(span_blocks[r])
    return ordered


def to_pdf_bbox(px_bbox, scale, page_h_pt):
    x0, y0, x1, y1 = px_bbox
    return [
        round(x0 / scale, 2),
        round(page_h_pt - y1 / scale, 2),
        round(x1 / scale, 2),
        round(page_h_pt - y0 / scale, 2),
    ]


def join_line_texts(lines):
    """行文本拼块文本，处理行尾连字符：
      "atten-" + "tion"      → atten-tion（保留连字符，不补空格）
      "performance-" + "competitive" → performance-competitive
      "GPT-" + "4o"          → GPT-4o
    为什么不再"去连字符拼接"：无法区分"换行断字"与"复合词在连字符处换行"，
    去字符会把 performance-competitive 拼成 performancecompetitive（造出假词，
    污染译前上下文与术语抽取）。保留连字符零风险——前端的模糊定位键会忽略
    连字符，"attention" 仍能命中 "atten-tion"。
    其余行按单空格连接；同时消掉 OCR 残留的多余空白。"""
    out = ""
    for line in lines:
        t = tidy_text(line.get("text") or "")
        if not t:
            continue
        if not out:
            out = t
            continue
        if out.endswith("-") and not out.endswith("--"):
            out = out + t
        else:
            out = f"{out} {t}"
    return _MULTI_SPACE.sub(" ", out).strip()


def blocks_to_pdf(blocks_px, scale, page_h_pt, page_w_pt=None):
    blocks = []
    for lines_px in blocks_px:
        lines = []
        for line in lines_px:
            lines.append(
                {"bbox": to_pdf_bbox(line["bbox"], scale, page_h_pt),
                 "text": line["text"], "conf": round(float(line["conf"]), 4)}
            )
        x0 = min(line["bbox"][0] for line in lines)
        ya = min(line["bbox"][1] for line in lines)
        x1 = max(line["bbox"][2] for line in lines)
        yb = max(line["bbox"][3] for line in lines)
        conf = sum(line["conf"] for line in lines) / len(lines)
        blocks.append(
            {"bbox": [x0, ya, x1, yb], "conf": round(conf, 4),
             "text": join_line_texts(lines_px), "lines": lines}
        )
    return blocks
