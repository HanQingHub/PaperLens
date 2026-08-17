"""备份导出/导入：zip = data.json（按用户过滤的全表 dump）+ files/（PDF）。"""
import json
import shutil
import zipfile
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.core.util import now_iso
from app.core.config import get_settings
from app.models import (
    Annotation, AppSetting, Excerpt, FileRef, GlossaryTerm, Paper, Project,
    ReadingProgress, ReadingSession, ReviewLog, TranslationCache, User, Word,
    WordOccurrence,
)

_USER_TABLES = [
    ("projects", Project), ("papers", Paper), ("words", Word),
    ("review_logs", ReviewLog), ("glossary_terms", GlossaryTerm),
    ("translation_cache", TranslationCache),
    ("reading_progress", ReadingProgress), ("reading_sessions", ReadingSession),
    ("excerpts", Excerpt), ("app_settings", AppSetting),
]


def _row_dict(row) -> dict:
    return {c: getattr(row, c) for c in row.__table__.columns.keys()}


def export_zip(db: Session, user: User, backups_dir: Path) -> Path:
    backups_dir.mkdir(parents=True, exist_ok=True)
    out = backups_dir / f"paperlens-backup-{user.username}-{now_iso().replace(':', '').replace('+', '_')}.zip"
    data = {
        "version": 1,
        "exported_at": now_iso(),
        "user": _row_dict(user),
        "tables": {name: [_row_dict(r) for r in db.query(model).filter(model.user_id == user.id).all()]
                   for name, model in _USER_TABLES},
    }
    annotations = [_row_dict(r) for r in db.query(Annotation).filter(Annotation.user_id == user.id).all()]
    data["tables"]["annotations"] = annotations
    # word_occurrences 无 user_id 列，经 word_id 间接归属
    word_ids = [w["id"] for w in data["tables"]["words"]]
    occ_query = db.query(WordOccurrence)
    occurrences = (
        [_row_dict(r) for r in occ_query.filter(WordOccurrence.word_id.in_(word_ids)).all()]
        if word_ids else []
    )
    data["tables"]["word_occurrences"] = occurrences
    hashes = sorted({p["file_hash"] for p in data["tables"]["papers"]})
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("data.json", json.dumps(data, ensure_ascii=False))
        files_dir = db_bind_files_dir(db)
        for h in hashes:
            f = files_dir / f"{h}.pdf"
            if f.exists():
                zf.write(f, f"files/{h}.pdf")
    return out


def db_bind_files_dir(db: Session) -> Path:
    from app.core.config import get_settings

    return get_settings().files_dir


def import_zip(zip_path: Path, data_dir: Path, session_factory) -> dict:
    with zipfile.ZipFile(zip_path) as zf:
        data = json.loads(zf.read("data.json").decode("utf-8"))
        user_data = data["user"]
        tables = data["tables"]

        db = session_factory()
        try:
            base_username = user_data["username"]
            username = base_username
            n = 1
            while db.query(User).filter(User.username == username).first() is not None:
                n += 1
                username = f"{base_username}_imported{n - 1}" if n > 2 else f"{base_username}_imported"
            new_user = User(
                username=username,
                password_hash=user_data.get("password_hash") or hash_password("paperlens"),
                display_name=user_data.get("display_name"),
                created_at=now_iso(),
            )
            db.add(new_user)
            db.flush()
            uid = new_user.id
            old_uid = user_data["id"]

            # 文件与引用计数
            files_dir = get_settings().files_dir
            files_dir.mkdir(parents=True, exist_ok=True)
            for p in tables.get("papers", []):
                h = p["file_hash"]
                target = files_dir / f"{h}.pdf"
                if not target.exists():
                    src = f"files/{h}.pdf"
                    if src in zf.namelist():
                        with zf.open(src) as s, open(target, "wb") as t:
                            shutil.copyfileobj(s, t)
                ref = db.get(FileRef, h)
                if ref is None:
                    db.add(FileRef(file_hash=h, ref_count=1))
                else:
                    ref.ref_count += 1

            # id 重映射
            proj_map: dict[int, int] = {}
            for row in tables.get("projects", []):
                old = row["id"]
                del row["id"]
                row["user_id"] = uid
                obj = Project(**row)
                db.add(obj)
                db.flush()
                proj_map[old] = obj.id

            paper_map: dict[int, int] = {}
            for row in tables.get("papers", []):
                old = row["id"]
                del row["id"]
                row["user_id"] = uid
                if row.get("project_id") is not None:
                    row["project_id"] = proj_map.get(row["project_id"])
                row["ocr_status"] = "none"  # OCR 结果不随备份迁移，可重新解析
                obj = Paper(**row)
                db.add(obj)
                db.flush()
                paper_map[old] = obj.id

            word_map: dict[int, int] = {}
            for row in tables.get("words", []):
                old = row["id"]
                del row["id"]
                row["user_id"] = uid
                existing = db.query(Word).filter(Word.user_id == uid, Word.lemma == row["lemma"]).first()
                if existing is not None:
                    word_map[old] = existing.id
                    continue
                obj = Word(**row)
                db.add(obj)
                db.flush()
                word_map[old] = obj.id

            def remap(rows: list[dict]) -> list[dict]:
                out = []
                for row in rows:
                    row = dict(row)
                    row.pop("id", None)
                    if "user_id" in row:
                        row["user_id"] = uid
                    if "paper_id" in row:
                        row["paper_id"] = paper_map.get(row["paper_id"])
                    if "word_id" in row:
                        row["word_id"] = word_map.get(row["word_id"])
                    out.append(row)
                return out

            for row in remap(tables.get("review_logs", [])):
                db.add(ReviewLog(**row))
            for row in remap(tables.get("word_occurrences", [])):
                db.add(WordOccurrence(**row))
            for row in remap(tables.get("glossary_terms", [])):
                db.add(GlossaryTerm(**row))
            for row in remap(tables.get("translation_cache", [])):
                db.add(TranslationCache(**row))
            for row in remap(tables.get("reading_progress", [])):
                db.add(ReadingProgress(**row))
            for row in remap(tables.get("reading_sessions", [])):
                db.add(ReadingSession(**row))
            for row in remap(tables.get("excerpts", [])):
                db.add(Excerpt(**row))
            for row in remap(tables.get("annotations", [])):
                db.add(Annotation(**row))
            for row in tables.get("app_settings", []):
                db.merge(AppSetting(user_id=uid, key=row["key"], value=row.get("value")))

            db.commit()
            return {
                "user_id": uid,
                "username": username,
                "username_renamed": username != base_username,
                "papers": len(paper_map),
                "words": len(word_map),
                "annotations": len(tables.get("annotations", [])),
                "excerpts": len(tables.get("excerpts", [])),
            }
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
