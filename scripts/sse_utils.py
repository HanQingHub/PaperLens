"""SSE 事件流解析（dev_check.py / e2e_smoke.py 共享，替代两处手写解析）。"""
import json


def parse_sse(text: str) -> list[tuple[str, dict]]:
    """解析 SSE 文本流 → [(event, data)] 列表。

    - event 缺省 "message"；`data:` 多行拼接
    - data 非合法 JSON 时回退 {"raw": 原文}（不抛异常）
    """
    events = []
    for block in text.split("\n\n"):
        ev, data_lines = "message", []
        for line in block.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
        if not data_lines:
            continue
        raw = "\n".join(data_lines)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"raw": raw}
        events.append((ev, data))
    return events
