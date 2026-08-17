"""SM-2 间隔重复（标准公式，可注入时钟做单测）。

EF 式适用所有 q：EF' = EF + 0.1 - (5-q)*(0.08+(5-q)*0.02)，钳制下限 1.3；
q<3 → interval=1d 重来；否则 interval = 0?1 : 1?6 : round(interval*EF')。
"""
from datetime import datetime, timedelta, timezone


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def sm2_update(ease: float, interval: float, q: int, now: datetime | None = None) -> dict:
    if q not in (2, 3, 4, 5):
        raise ValueError(f"q 必须是 2|3|4|5，收到 {q}")
    now = now or now_utc()
    new_ease = ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
    new_ease = max(1.3, new_ease)
    if q < 3:
        new_interval = 1.0
    elif interval == 0:
        new_interval = 1.0
    elif interval == 1:
        new_interval = 6.0
    else:
        new_interval = float(round(interval * new_ease))
    due = now + timedelta(days=new_interval)
    return {
        "ease": round(new_ease, 4),
        "interval": new_interval,
        "due_at": due.isoformat(timespec="microseconds"),
    }
