"""worker 坐标/分组纯函数单测（不加载 OCR 模型）。"""

from worker.paragraph import blocks_to_pdf, group_lines, to_pdf_bbox


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