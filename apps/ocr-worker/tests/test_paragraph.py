"""worker 坐标/分组纯函数单测（不加载 OCR 模型）。"""

from worker.paragraph import blocks_to_pdf, group_lines, join_line_texts, to_pdf_bbox


def _box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def test_group_lines_single_line():
    blocks = group_lines([_box(0, 0, 100, 20)], ["hello"], [0.9])
    assert len(blocks) == 1
    assert len(blocks[0]) == 1
    assert blocks[0][0]["text"] == "hello"
    assert blocks[0][0]["conf"] == 0.9


def test_group_lines_merge_adjacent_lines():
    boxes = [_box(0, 0, 100, 20), _box(0, 20, 100, 40)]
    blocks = group_lines(boxes, ["a", "b"], [0.8, 0.6])
    assert len(blocks) == 1
    assert [line["text"] for line in blocks[0]] == ["a", "b"]
    ycs = [line["yc"] for line in blocks[0]]
    assert ycs == sorted(ycs)


def test_group_lines_two_columns_split_by_x():
    boxes = [_box(0, 0, 100, 20), _box(200, 0, 300, 20)]
    blocks = group_lines(boxes, ["left", "right"], [0.9, 0.9])
    assert len(blocks) == 2
    assert [blocks[i][0]["text"] for i in (0, 1)] == ["left", "right"]


def test_group_lines_empty_input():
    assert group_lines([], [], []) == []


def test_to_pdf_bbox_coordinate_edges():
    assert to_pdf_bbox((0, 0, 0, 0), 2, 720) == [0, 720, 0, 720]
    assert to_pdf_bbox((0, 0, 200, 100), 1, 100) == [0, 0, 200, 100]
    assert to_pdf_bbox((0, 0, 200, 100), 2, 720) == [0, 670, 100, 720]


def test_blocks_to_pdf_structure():
    px = [
        [
            {"bbox": (0, 0, 100, 20), "text": "aa", "conf": 0.8, "yc": 10.0, "h": 20.0},
            {"bbox": (0, 20, 100, 40), "text": "bb", "conf": 0.6, "yc": 30.0, "h": 20.0},
        ]
    ]
    blocks = blocks_to_pdf(px, 2, 720)
    assert len(blocks) == 1
    b = blocks[0]
    assert b["bbox"] == [0, 700, 50, 720]
    assert b["conf"] == 0.7
    assert b["text"] == "aa bb"
    assert len(b["lines"]) == 2

# ── v2：栏检测/阅读顺序/断行连字符/段落切分 ────────────────────────

def test_single_column_not_split_by_one_shifted_line():
    """单栏页里一条右移的短行（页码/行尾公式）不得把页面误判成两栏。"""
    boxes = []
    texts = []
    for i in range(8):
        boxes.append(_box(100, i * 30, 900, i * 30 + 20))
        texts.append(f"body line {i}")
    boxes.append(_box(820, 400, 860, 420))  # 右移的噪声行
    texts.append("7")
    blocks = group_lines(boxes, texts, [0.9] * len(texts), page_w=1000)
    # 单栏：所有正文行按 y 顺序，噪声行不插入段落中间
    body = [b for b in blocks if "body line" in b[0]["text"]]
    assert len(body) == 1
    ys = [l["yc"] for l in body[0]]
    assert ys == sorted(ys)


def test_two_columns_reading_order_and_spanning_element():
    """双栏 + 页中通栏图：区带内按栏序读，通栏块落在两个区带之间。"""
    boxes, texts = [], []
    # 通栏标题
    boxes.append(_box(100, 0, 900, 30)); texts.append("Abstract")
    # 左栏 3 行 / 右栏 3 行（上半）
    for i in range(3):
        boxes.append(_box(100, 100 + i * 30, 480, 120 + i * 30)); texts.append(f"L{i}")
        boxes.append(_box(520, 100 + i * 30, 900, 120 + i * 30)); texts.append(f"R{i}")
    # 通栏图题
    boxes.append(_box(100, 300, 900, 330)); texts.append("Figure 3: overview of the pipeline and its modules.")
    # 下半
    for i in range(3):
        boxes.append(_box(100, 400 + i * 30, 480, 420 + i * 30)); texts.append(f"L{i + 3}")
        boxes.append(_box(520, 400 + i * 30, 900, 420 + i * 30)); texts.append(f"R{i + 3}")
    blocks = group_lines(boxes, texts, [0.9] * len(texts), page_w=1000)
    flat = [" ".join(l["text"] for l in b) for b in blocks]
    assert flat[0] == "Abstract"
    i_fig = next(i for i, t in enumerate(flat) if t.startswith("Figure 3"))
    # 图上方的左右栏都在图之前，图下方的左右栏都在图之后
    above = " ".join(flat[:i_fig])
    below = " ".join(flat[i_fig + 1:])
    assert all(tag in above for tag in ("L0", "R0", "L2", "R2"))
    assert all(tag in below for tag in ("L3", "R3", "L5", "R5"))


def test_join_line_texts_hyphenated_break():
    px = [
        [
            {"bbox": (0, 0, 100, 20), "text": "a novel atten-", "conf": 0.9, "yc": 10.0, "h": 20.0},
            {"bbox": (0, 20, 100, 40), "text": "tion mechanism", "conf": 0.9, "yc": 30.0, "h": 20.0},
        ]
    ]
    # 保留连字符、不补空格：模糊定位键忽略连字符，"attention" 仍可命中
    assert blocks_to_pdf(px, 1, 100)[0]["text"] == "a novel atten-tion mechanism"


def test_join_line_texts_keeps_hyphen_without_space():
    assert join_line_texts([{"text": "GPT-"}, {"text": "4o is fast"}]) == "GPT-4o is fast"
    assert join_line_texts([{"text": "state-of-"}, {"text": "the-art"}]) == "state-of-the-art"
    # 复合词在连字符处换行：不得拼成 performancecompetitive
    assert join_line_texts([
        {"text": "are performance-"}, {"text": "competitive with others"},
    ]) == "are performance-competitive with others"


def test_tidy_text_collapses_punctuation_spacing():
    boxes = [_box(0, 0, 200, 20)]
    blocks = group_lines(boxes, ["we use 64.2 % , see ( Fig. 3 )"], [0.9])
    assert blocks[0][0]["text"] == "we use 64.2%, see (Fig. 3)"


def test_paragraph_break_on_large_gap_after_sentence_end():
    boxes = [_box(100, 0, 500, 20), _box(100, 20, 500, 40), _box(100, 72, 500, 92)]
    blocks = group_lines(boxes, ["First sentence ends.", "still same paragraph", "New paragraph here."],
                         [0.9, 0.9, 0.9], page_w=1000)
    assert len(blocks) == 2
    assert [l["text"] for l in blocks[0]] == ["First sentence ends.", "still same paragraph"]
    assert [l["text"] for l in blocks[1]] == ["New paragraph here."]


def test_noise_single_char_rule_dropped():
    boxes = [_box(100, 0, 500, 20), _box(105, 30, 120, 50)]
    blocks = group_lines(boxes, ["real text line", "V"], [0.9, 0.9], page_w=1000)
    assert [l["text"] for b in blocks for l in b] == ["real text line"]
