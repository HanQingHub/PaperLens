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


def _stop_tree(procs, grace: float = 8.0):
    """先给优雅退出窗口（uvicorn lifespan 收敛 WAL、vite 清理临时文件），
    超时后 Windows 用 taskkill /T 整树强杀（terminate() 只杀直接子进程，
    npm.cmd 包装层下的 node/vite 与 uvicorn 拉起的 OCR worker 会成孤儿）。"""
    for _, p in procs:
        if p.poll() is None:
            p.terminate()
    deadline = time.time() + grace
    for _, p in procs:
        try:
            p.wait(timeout=max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(p.pid)],
                    capture_output=True,
                )
            else:
                p.kill()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


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

    dead = None
    try:
        while True:
            for name, p in procs:
                rc = p.poll()
                if rc is not None:
                    dead = (name, rc)
                    break
            if dead is not None:
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print("[dev] Ctrl+C，正在停止子进程…")
    finally:
        if dead is not None:
            name, rc = dead
            print(f"[dev] {name} 已退出 (code={rc})", file=sys.stderr)
        _stop_tree(procs)
        print("[dev] 已全部退出")
    # 子进程死亡必须以非零码退出（端口占用等失败对调用方可见），Ctrl+C 视为正常结束
    sys.exit((dead[1] or 1) if dead is not None else 0)


if __name__ == "__main__":
    main()
