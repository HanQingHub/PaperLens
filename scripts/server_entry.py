"""PaperLens server 打包入口（PyInstaller onedir）。

等价于开发期的 `python -m uvicorn app.main:app --host 127.0.0.1 --port <port>`。
端口取环境变量 PAPERLENS_PORT（默认 8737），数据目录取 PAPERLENS_DATA_DIR。
"""
import os
import sys
from pathlib import Path


def _ensure_app_importable() -> None:
    """非冻结（源码直跑）时把 apps/server 加进 sys.path，使 `app` 包可导入。
    冻结后 app 包随 exe 内置，无需处理。"""
    if getattr(sys, "frozen", False):
        return
    server_dir = Path(__file__).resolve().parents[1] / "apps" / "server"
    if str(server_dir) not in sys.path:
        sys.path.insert(0, str(server_dir))


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass
    _ensure_app_importable()

    import uvicorn

    from app.main import app  # 确保整个 app 包在 run 之前完成导入

    port = int(os.environ.get("PAPERLENS_PORT", "8737"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
