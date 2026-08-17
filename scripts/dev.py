"""开发启动器：设 PAPERLENS_* 环境变量后拉起后端（uvicorn），--frontend 时并行拉起 vite。

用法：
  python scripts/dev.py             # 仅后端
  python scripts/dev.py --frontend  # 后端 + vite
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = REPO / ".venv" / "Scripts" / "python.exe"


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="PaperLens 开发启动器")
    ap.add_argument("--frontend", action="store_true", help="并行启动 vite dev server")
    ap.add_argument("--port", type=int, default=8737)
    args = ap.parse_args()

    env = os.environ.copy()
    env["PAPERLENS_DATA_DIR"] = str(REPO / ".dev-data")
    env["PAPERLENS_MODELS_DIR"] = str(REPO / "assets" / "models")
    env["PYTHONIOENCODING"] = "utf-8"

    procs = []
    server_dir = REPO / "apps" / "server"
    print(f"[dev] 启动 uvicorn http://127.0.0.1:{args.port} (cwd={server_dir})")
    procs.append(
        (
            "uvicorn",
            subprocess.Popen(
                [
                    str(PY), "-m", "uvicorn", "app.main:app",
                    "--host", "127.0.0.1", "--port", str(args.port),
                ],
                cwd=server_dir,
                env=env,
            ),
        )
    )

    if args.frontend:
        desktop = REPO / "apps" / "desktop"
        if (desktop / "package.json").exists():
            npm = shutil.which("npm.cmd") or shutil.which("npm")
            if npm:
                print(f"[dev] 启动 vite (cwd={desktop})")
                procs.append(
                    ("vite", subprocess.Popen([npm, "run", "dev"], cwd=desktop, env=env))
                )
            else:
                print("[dev] 未找到 npm，跳过前端")
        else:
            print("[dev] apps/desktop/package.json 不存在，跳过前端")

    try:
        while True:
            for name, p in procs:
                rc = p.poll()
                if rc is not None:
                    raise SystemExit(f"[dev] {name} 已退出 (code={rc})")
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        print("[dev] 正在停止子进程…")
        for name, p in procs:
            if p.poll() is None:
                p.terminate()
        for name, p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print(f"[dev] {name} 未响应 terminate，强制 kill (pid={p.pid})")
                p.kill()
                p.wait()
        print("[dev] 已全部退出")


if __name__ == "__main__":
    main()
