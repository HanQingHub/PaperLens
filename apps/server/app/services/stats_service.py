"""统计：30 天热力图 / 今日与累计时长 / 新增曲线 / 复习完成率。"""
from datetime import timedelta

from sqlalchemy.orm import Session

from app.models import ReadingSession, ReviewLog, Word
from app.core.util import now_iso, parse_iso, utc_now


def overview(db: Session, user_id: int) -> dict:
    now = utc_now()
    today = now.date()
    now_str = now_iso()

    sessions = db.query(ReadingSession).filter(ReadingSession.user_id == user_id).all()
    total_s = 0
    per_day: dict = {}
    for s in sessions:
        total_s += s.duration_s or 0
        if s.start_at:
            try:
                d = parse_iso(s.start_at).date()
                per_day[d] = per_day.get(d, 0) + (s.duration_s or 0)
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

    words = db.query(Word).filter(Word.user_id == user_id).all()
    new_per_day: dict = {}
    for w in words:
        if w.first_seen_at:
            try:
                d = parse_iso(w.first_seen_at).date()
                new_per_day[d] = new_per_day.get(d, 0) + 1
            except ValueError:
                continue
    words_new_7d = [
        {"date": (today - timedelta(days=i)).isoformat(), "count": new_per_day.get(today - timedelta(days=i), 0)}
        for i in range(6, -1, -1)
    ]

    review_done_today = 0
    logs = db.query(ReviewLog).filter(ReviewLog.user_id == user_id).all()
    for log in logs:
        if log.reviewed_at:
            try:
                if parse_iso(log.reviewed_at).date() == today:
                    review_done_today += 1
            except ValueError:
                continue

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
