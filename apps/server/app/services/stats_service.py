"""统计：30 天热力图 / 今日与累计时长 / 新增曲线 / 复习完成率。"""
from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import ReadingSession, ReviewLog, Word
from app.core.util import now_iso, parse_iso, utc_now


def overview(db: Session, user_id: int) -> dict:
    now = utc_now()
    today = now.date()
    now_str = now_iso()

    rows = (
        db.query(func.substr(ReadingSession.start_at, 1, 10), func.coalesce(func.sum(ReadingSession.duration_s), 0))
        .filter(ReadingSession.user_id == user_id)
        .group_by(func.substr(ReadingSession.start_at, 1, 10))
        .all()
    )
    total_s = 0
    per_day: dict = {}
    for day_str, seconds in rows:
        total_s += seconds
        if day_str:
            try:
                per_day[parse_iso(day_str).date()] = seconds
            except ValueError:
                continue

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

    new_rows = (
        db.query(func.substr(Word.first_seen_at, 1, 10), func.count())
        .filter(Word.user_id == user_id)
        .group_by(func.substr(Word.first_seen_at, 1, 10))
        .all()
    )
    new_per_day: dict = {}
    for day_str, count in new_rows:
        if day_str:
            try:
                new_per_day[parse_iso(day_str).date()] = count
            except ValueError:
                continue
    words_new_7d = [
        {"date": (today - timedelta(days=i)).isoformat(), "count": new_per_day.get(today - timedelta(days=i), 0)}
        for i in range(6, -1, -1)
    ]

    review_done_today = (
        db.query(func.count())
        .select_from(ReviewLog)
        .filter(ReviewLog.user_id == user_id, func.substr(ReviewLog.reviewed_at, 1, 10) == today.isoformat())
        .scalar()
    ) or 0

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