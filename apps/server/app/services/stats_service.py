"""统计：30 天热力图 / 今日与累计时长 / 新增曲线 / 复习完成率。

日期归属一律按**用户本地时区**（UTC 存储的 ISO 时间戳在 Python 侧转本地日期），
避免 UTC 凌晨时段（本地 8 点前）的会话被记到前一天。
"""
from datetime import timedelta

from sqlalchemy.orm import Session

from app.models import ReadingSession, ReviewLog, Word
from app.core.util import now_iso, parse_iso, utc_now


def _local_date(iso_str: str | None):
    """UTC ISO 时间戳 → 本地日历日期；解析失败返回 None。"""
    if not iso_str:
        return None
    try:
        return parse_iso(iso_str).astimezone().date()
    except (ValueError, TypeError, OSError):
        return None


def overview(db: Session, user_id: int) -> dict:
    now = utc_now()
    today = now.astimezone().date()
    now_str = now_iso()

    rows = db.query(ReadingSession.start_at, ReadingSession.duration_s).filter(
        ReadingSession.user_id == user_id
    ).all()
    total_s = 0
    per_day: dict = {}
    for start_at, seconds in rows:
        total_s += seconds
        day = _local_date(start_at)
        if day is not None:
            per_day[day] = per_day.get(day, 0) + seconds

    today_s = per_day.get(today, 0)
    calendar = [
        {"date": (today - timedelta(days=i)).isoformat(), "seconds": per_day.get(today - timedelta(days=i), 0)}
        for i in range(29, -1, -1)
    ]

    # streak：从今天（今天无阅读则从昨天）往前数连续有阅读的天数
    streak = 0
    cursor = today if per_day.get(today, 0) > 0 else today - timedelta(days=1)
    while per_day.get(cursor, 0) > 0:
        streak += 1
        cursor -= timedelta(days=1)

    new_rows = db.query(Word.first_seen_at).filter(Word.user_id == user_id).all()
    new_per_day: dict = {}
    for (first_seen_at,) in new_rows:
        day = _local_date(first_seen_at)
        if day is not None:
            new_per_day[day] = new_per_day.get(day, 0) + 1
    words_new_7d = [
        {"date": (today - timedelta(days=i)).isoformat(), "count": new_per_day.get(today - timedelta(days=i), 0)}
        for i in range(6, -1, -1)
    ]

    # 复习完成：ReviewLog.reviewed_at 逐行转本地日期比对（量级=当日复习数，可接受）
    review_rows = db.query(ReviewLog.reviewed_at).filter(ReviewLog.user_id == user_id).all()
    review_done_today = 0
    for (reviewed_at,) in review_rows:
        if _local_date(reviewed_at) == today:
            review_done_today += 1

    review_due_today = (
        db.query(Word)
        .filter(Word.user_id == user_id, Word.stage < 2, Word.due_at.isnot(None), Word.due_at <= now_str)
        .count()
    )

    return {
        "today_s": today_s,
        "total_s": total_s,
        "streak": streak,
        "calendar": calendar,
        "words_new_7d": words_new_7d,
        "review_done_today": review_done_today,
        "review_due_today": review_due_today,
    }
