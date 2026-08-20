"""blocks.ndjson 读写协议（worker 侧唯一实现）。

协议：每行一个 JSON 对象（UTF-8，ensure_ascii=False，行尾换行）。记录字段：
  paper_id        int   论文 id
  page            int   页码（0-based）
  dpi_scale       float 渲染缩放
  blocks          list  段落块列表，块结构见 paragraph.blocks_to_pdf
  page_rot        int   页面旋转角（/Rotate 度数，可选，缺省 0）
  format_version  int   记录格式版本（当前 1，可选，旧文件无此字段）
  engine          str   OCR 引擎标识（可选，旧文件无此字段）

兼容性：消费端须容忍旧记录缺 page_rot/format_version/engine（分别按
0/无/无处理），并跳过损坏行（半写残留）。
"""
import json
from pathlib import Path

FORMAT_VERSION = 1


def build_record(paper_id, page, scale, blocks, page_rot=0, engine=""):
    """构造一条 blocks.ndjson 记录（纯函数，无 IO）。"""
    return {
        "paper_id": paper_id,
        "page": page,
        "dpi_scale": scale,
        "blocks": blocks,
        "page_rot": page_rot,
        "format_version": FORMAT_VERSION,
        "engine": engine,
    }


def append_ndjson(ndjson: Path, record: dict):
    with open(ndjson, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def parse_ndjson(path):
    """逐行解析 blocks.ndjson，返回记录 dict 列表；跳过空行与损坏行。"""
    records = []
    if not Path(path).exists():
        return records
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def read_done_pages(path):
    """返回已完成页码集合（带 page 键的记录）。"""
    done = set()
    for r in parse_ndjson(path):
        try:
            done.add(int(r["page"]))
        except (KeyError, TypeError, ValueError):
            continue
    return done