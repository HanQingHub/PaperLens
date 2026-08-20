"""内嵌 LLM 推理引擎（llama-cpp-python 进程内单例）。

- 后台线程加载（loading→ready），未加载时首次请求自动触发，60s 超时
- asyncio.Lock 串行推理队列；空闲自动卸载（app_settings 键 llm_unload_policy，
  默认 600s；0=用完即卸；-1=常驻）
- SSE 心跳（ping）与首 token 超时由 translate_service 负责
"""
import asyncio
import ctypes
import os
import subprocess
import threading
import time
from datetime import timezone
from pathlib import Path

from app.core.util import now_iso, parse_iso, utc_now

LOAD_TIMEOUT = 60.0
N_CTX = 4096
N_BATCH = 128
DEFAULT_MODEL_ID = "qwen3.5-2b-q4km"

BUILTIN_MODELS = [
    {
        "id": "qwen3.5-2b-q4km",
        "file": "Qwen3.5-2B-Q4_K_M.gguf",
        "size_bytes": 1280835840,
        "sha256": "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
        "sources": [
            "https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q4_K_M.gguf",
            "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
        ],
    },
    {
        "id": "qwen3.5-0.8b-q4km",
        "file": "Qwen3.5-0.8B-Q4_K_M.gguf",
        "size_bytes": 532517120,
        "sha256": None,
        "sources": [
            "https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q4_K_M.gguf",
            "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf",
        ],
    },
]
_BUILTIN_BY_ID = {m["id"]: m for m in BUILTIN_MODELS}


class LLMError(Exception):
    pass


class LLMLoadingTimeout(LLMError):
    pass


class LLMTimeout(LLMError):
    pass


def _physical_cores() -> int:
    try:
        out = subprocess.run(
            ["wmic", "cpu", "get", "NumberOfCores", "/value"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            if line.strip().startswith("NumberOfCores"):
                return max(1, int(line.split("=")[1].strip()))
    except Exception:
        pass
    return max(1, (os.cpu_count() or 4) // 2)


def get_rss_mb() -> float | None:
    try:
        import ctypes.wintypes as wt

        class PMC(ctypes.Structure):
            _fields_ = [
                ("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
            return round(pmc.WorkingSetSize / 1024 / 1024, 1)
    except Exception:
        pass
    return None


_DONE = object()


def _next_chunk(it):
    try:
        return next(it)
    except StopIteration:
        return _DONE


class LLMService:
    def __init__(self, session_factory=None) -> None:
        self._llm = None
        self.state = "unloaded"  # unloaded | loading | ready
        self.model_id: str | None = None
        self.last_used_at: str | None = None
        self.last_error: str | None = None
        self._state_lock = threading.Lock()
        self._gen_lock = asyncio.Lock()
        self._idle_task: asyncio.Task | None = None
        self._n_threads = _physical_cores()
        self.session_factory = session_factory
        self._stopping = threading.Event()
        self._generating = threading.Event()

    # ---- 模型解析 ----
    def _new_session(self):
        if self.session_factory is not None:
            return self.session_factory()
        from app.core.db import SessionLocal

        return SessionLocal()

    def configured_model_id(self) -> str:
        try:
            from app.models import AppSetting

            db = self._new_session()
            try:
                row = (
                    db.query(AppSetting)
                    .filter(AppSetting.key == "llm_model_id")
                    .order_by(AppSetting.user_id)
                    .first()
                )
                if row and row.value:
                    return row.value
            finally:
                db.close()
        except Exception:
            pass
        return DEFAULT_MODEL_ID

    def _models_dirs(self) -> list[Path]:
        from app.core.config import get_settings

        s = get_settings()
        dirs = [s.models_dir]
        if s.bundled_models_dir is not None and s.bundled_models_dir.resolve() != s.models_dir.resolve():
            dirs.append(s.bundled_models_dir)
        return dirs

    def scan_models(self) -> list[dict]:
        found_files: dict[str, Path] = {}
        for d in self._models_dirs():
            if d.exists():
                for f in sorted(d.glob("*.gguf")):
                    found_files.setdefault(f.stem.lower(), f)
        result = []
        for m in BUILTIN_MODELS:
            key = Path(m["file"]).stem.lower()
            path = found_files.get(key)
            result.append({
                "id": m["id"], "file": m["file"],
                "size_bytes": path.stat().st_size if path else m["size_bytes"],
                "builtin": True, "downloaded": path is not None,
            })
        builtin_stems = {Path(m["file"]).stem.lower() for m in BUILTIN_MODELS}
        for stem, path in found_files.items():
            if stem not in builtin_stems:
                result.append({
                    "id": stem, "file": path.name,
                    "size_bytes": path.stat().st_size, "builtin": False, "downloaded": True,
                })
        return result

    def resolve_model_path(self, model_id: str | None = None) -> tuple[str, Path] | None:
        mid = (model_id or self.configured_model_id()).strip()
        for models_dir in self._models_dirs():
            if mid in _BUILTIN_BY_ID:
                p = models_dir / _BUILTIN_BY_ID[mid]["file"]
                if p.exists():
                    return (mid, p)
            if models_dir.exists():
                for f in models_dir.glob("*.gguf"):
                    if f.stem.lower() == mid or f.name == mid:
                        return mid, f
        return None

    # ---- 生命周期 ----
    def start_load(self, model_id: str | None = None) -> None:
        with self._state_lock:
            if self.state == "loading":
                return
            resolved = self.resolve_model_path(model_id)
            if resolved is None:
                self.last_error = f"模型不可用: {model_id or self.configured_model_id()}"
                return
            mid, path = resolved
            self.state = "loading"
            self.model_id = mid
            self.last_error = None
            threading.Thread(target=self._load_sync, args=(path,), daemon=True).start()

    def _load_sync(self, path: Path) -> None:
        try:
            from llama_cpp import Llama

            llm = Llama(
                model_path=str(path), n_ctx=N_CTX, n_threads=self._n_threads,
                n_batch=N_BATCH, use_mmap=True, use_mlock=False, verbose=False,
            )
            with self._state_lock:
                self._llm = llm
                self.state = "ready"
                self.last_used_at = now_iso()
        except Exception as e:  # 加载失败回落未加载态
            with self._state_lock:
                self.state = "unloaded"
                self._llm = None
                self.last_error = str(e)

    def unload_sync(self) -> None:
        with self._state_lock:
            if self.state == "loading":
                return
            llm = self._llm
            self._llm = None
            self.state = "unloaded"
        if self._generating.is_set():
            self._stopping.set()
            deadline = time.monotonic() + 10.0
            while self._generating.is_set() and time.monotonic() < deadline:
                time.sleep(0.05)
        if llm is not None:
            try:
                llm.close()
            except Exception:
                pass
            import gc

            gc.collect()

    async def unload(self) -> None:
        await asyncio.to_thread(self.unload_sync)

    async def ensure_loaded(self, timeout: float = LOAD_TIMEOUT) -> bool:
        if self.state == "ready":
            return True
        if self.state == "unloaded":
            self.start_load(None)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while self.state == "loading" and loop.time() < deadline:
            await asyncio.sleep(0.2)
        return self.state == "ready"

    def _unload_policy(self) -> int:
        try:
            from app.models import AppSetting

            db = self._new_session()
            try:
                row = (
                    db.query(AppSetting)
                    .filter(AppSetting.key == "llm_unload_policy")
                    .order_by(AppSetting.user_id)
                    .first()
                )
                if row and row.value is not None:
                    return int(row.value)
            finally:
                db.close()
        except Exception:
            pass
        return 600

    # ---- 推理 ----
    async def chat_stream(self, messages: list[dict], max_tokens: int = 300):
        """串行推理队列内的流式生成：yield {"type":"delta","text":...}。"""
        if not await self.ensure_loaded(LOAD_TIMEOUT):
            raise LLMLoadingTimeout("模型加载超时或不可用")
        async with self._gen_lock:
            llm = self._llm
            if llm is None:
                raise LLMLoadingTimeout("模型未就绪")
            self.last_used_at = now_iso()
            it = llm.create_chat_completion(
                messages=messages, stream=True, max_tokens=max_tokens,
                temperature=0.3, top_p=0.8, top_k=20,
            )
            fut: asyncio.Future | None = None
            self._stopping.clear()
            self._generating.set()
            try:
                while True:
                    if self._stopping.is_set():
                        break
                    if fut is None:
                        fut = asyncio.ensure_future(asyncio.to_thread(_next_chunk, it))
                    chunk = await asyncio.shield(fut)
                    fut = None
                    if chunk is _DONE:
                        break
                    delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                    if delta:
                        yield {"type": "delta", "text": delta}
            finally:
                # 等待在途线程调用结束，避免并发调用 llama（线程不安全）
                if fut is not None and not fut.done():
                    try:
                        await asyncio.shield(fut)
                    except Exception:
                        pass
                self._generating.clear()
                self.last_used_at = now_iso()
                if self._unload_policy() == 0:
                    await asyncio.to_thread(self.unload_sync)

    def status(self) -> dict:
        return {
            "state": self.state,
            "model_id": self.model_id,
            "rss_mb": get_rss_mb(),
            "last_used_at": self.last_used_at,
            "error": self.last_error,
        }

    async def idle_watch_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                policy = self._unload_policy()
                if self.state == "ready" and policy > 0 and self.last_used_at:
                    idle = (utc_now() - parse_iso(self.last_used_at).astimezone(timezone.utc)).total_seconds()
                    if idle > policy:
                        await self.unload()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

    def start_idle_watch(self) -> None:
        if self._idle_task is None or self._idle_task.done():
            try:
                self._idle_task = asyncio.get_running_loop().create_task(self.idle_watch_loop())
            except RuntimeError:
                pass

    async def stop(self) -> None:
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None
        await self.unload()


llm_service = LLMService()
