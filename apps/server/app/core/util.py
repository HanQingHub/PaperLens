import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utc_now().isoformat(timespec="microseconds")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_within(base: Path, target: Path) -> Path:
    """路径安全：target 解析后必须落在 base 内，防目录穿越。"""
    base_r = base.resolve()
    target_r = target.resolve()
    if target_r != base_r and base_r not in target_r.parents:
        raise PermissionError(f"路径越界: {target}")
    return target_r


def content_disposition(filename: str) -> str:
    """RFC 5987：中文文件名走 filename*，同时给 ascii 兜底。"""
    from urllib.parse import quote

    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def normalize_word(word: str) -> str:
    return word.strip().lower()


def is_single_word(word: str) -> bool:
    return len(_WORD_RE.findall(word.strip())) <= 1 and " " not in word.strip()


def dump_setting(value) -> str:
    """设置值落库：JSON 序列化保留类型（bool/int/float/str）。"""
    import json

    return json.dumps(value)


def parse_setting(raw):
    """设置值出库：JSON 反序列化；兼容历史 str() 遗留格式（'True'/'1.05' 等）。"""
    import json

    if raw is None:
        return None
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        pass
    if raw == "True":
        return True
    if raw == "False":
        return False
    if raw == "None":
        return None
    try:
        if re.fullmatch(r"[+-]?\d+", raw):
            return int(raw)
        return float(raw)
    except ValueError:
        return raw

def like_escape(s: str) -> str:
    """LIKE 通配符转义（配合 .like(pattern, escape=backslash) 使用），防 %/_ 注入误匹配。"""
    return s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
