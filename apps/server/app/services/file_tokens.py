"""一次性文件 token：内存 map，5 分钟有效，供 pdf.js 无 Authorization 头加载 PDF。

Range 请求不消耗 token；完整文件 GET（无 Range 头）消耗（一次性）。"""
import threading
import time

TTL_SECONDS = 300

_lock = threading.Lock()
_tokens: dict[str, dict] = {}


def issue(paper_id: int, user_id: int) -> str:
    from app.core.config import get_settings

    import secrets

    ttl = get_settings().file_token_ttl
    token = secrets.token_urlsafe(32)
    with _lock:
        _purge()
        _tokens[token] = {
            "paper_id": paper_id,
            "user_id": user_id,
            "expires_at": time.monotonic() + ttl,
        }
    return token


def consume(token: str, paper_id: int, *, full_get: bool) -> bool:
    with _lock:
        _purge()
        info = _tokens.get(token)
        if info is None or info["paper_id"] != paper_id:
            return False
        if full_get:
            del _tokens[token]
        return True


def revoke_paper(paper_id: int) -> None:
    with _lock:
        for token in [t for t, v in _tokens.items() if v["paper_id"] == paper_id]:
            del _tokens[token]


def reset() -> None:
    with _lock:
        _tokens.clear()


def _purge() -> None:
    now = time.monotonic()
    for token in [t for t, v in _tokens.items() if v["expires_at"] <= now]:
        del _tokens[token]
