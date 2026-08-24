import sqlite3
import threading
from pathlib import Path

from app.core.config import get_settings


def _strip_verbatim(p: Path) -> Path:
    s = str(p)
    if s.startswith("\\\\?\\"):
        if s.startswith("\\\\?\\UNC\\"):
            s = "\\\\" + s[8:]
        else:
            s = s[4:]
        return Path(s)
    return p

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
# _tried 仅保留供测试兼容，实际不再作为永久锁；_connect 每次 _conn is None 时重建
_tried = False  # deprecated: 保留变量名避免旧代码 import 失败


def _connect() -> sqlite3.Connection | None:
    global _conn
    if _conn is not None:
        return _conn
    s = get_settings()
    raw_candidates = [s.ecdict_path]
    if s.bundled_ecdict_path is not None:
        try:
            if _strip_verbatim(s.bundled_ecdict_path).resolve() != _strip_verbatim(s.ecdict_path).resolve():
                raw_candidates.append(s.bundled_ecdict_path)
        except OSError:
            raw_candidates.append(s.bundled_ecdict_path)
    for path in raw_candidates:
        np = _strip_verbatim(path)
        if not np.exists():
            continue
        try:
            _conn = sqlite3.connect(f"file:{np}?mode=ro", uri=True, check_same_thread=False)
            return _conn
        except sqlite3.Error:
            continue
    return None


def reset():
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
        _conn = None
        # 兼容旧测试：重置 _tried 供外部读取
        globals()["_tried"] = False


def lookup(word: str) -> dict | None:
    """查词典：直接命中 → 解析 exchange 的 0=Lemma；未命中 → lemmas 表词形还原后再查。"""
    word = word.strip().lower()
    if not word:
        return None
    conn = _connect()
    if conn is None:
        return None
    with _lock:
        row = conn.execute(
            "SELECT word,pos,phonetic,translation,collins_star,tag,exchange FROM dictionary WHERE word=?",
            (word,),
        ).fetchone()
        if row is not None:
            lemma = None
            if row[6]:
                for part in row[6].split("/"):
                    if part.startswith("0="):
                        lemma = part[2:]
                        break
            if lemma is None:
                # 主数据源 lemma.en.txt 词形库：exchange 缺失时补查
                lem = conn.execute("SELECT lemma FROM lemmas WHERE word=?", (word,)).fetchone()
                if lem is not None:
                    lemma = lem[0]
            return {
                "word": row[0], "pos": row[1], "phonetic": row[2], "translation": row[3],
                "collins_star": row[4], "tag": row[5], "exchange": row[6], "lemma": lemma,
            }
        lem = conn.execute("SELECT lemma FROM lemmas WHERE word=?", (word,)).fetchone()
        if lem is None:
            return None
        base = lem[0]
        row = conn.execute(
            "SELECT word,pos,phonetic,translation,collins_star,tag,exchange FROM dictionary WHERE word=?",
            (base,),
        ).fetchone()
        if row is None:
            return {
                "word": word, "pos": None, "phonetic": None, "translation": None,
                "collins_star": None, "tag": None, "exchange": None, "lemma": base,
            }
        return {
            "word": word, "pos": row[1], "phonetic": row[2], "translation": row[3],
            "collins_star": row[4], "tag": row[5], "exchange": row[6], "lemma": base,
        }
