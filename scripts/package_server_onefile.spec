# -*- mode: python ; coding: utf-8 -*-
"""PaperLens server 打包 spec（PyInstaller 6.x，onefile）→ dist/paperlens-server.exe

供 Tauri externalBin sidecar 使用（externalBin 只接受单文件；onedir 见 package_server.spec）。

用法（仓库根目录）：
  .venv\Scripts\pyinstaller --noconfirm scripts\package_server_onefile.spec --distpath dist --workpath dist\.work-server-onefile
  # 产物重命名覆盖占位 stub（tauri-build 只做存在性检查，原样拷走）：
  Copy-Item dist\paperlens-server.exe apps\desktop\src-tauri\binaries\paperlens-server-x86_64-pc-windows-msvc.exe -Force
"""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

REPO = Path(SPECPATH).resolve().parent
SERVER_DIR = REPO / "apps" / "server"
VENV_SP = REPO / ".venv" / "Lib" / "site-packages"

# ── 硬门禁：必须用 .venv 环境打包，否则系统 Python 无 llama_cpp 必致 ImportError ──
assert ".venv" in sys.executable.lower(), f"必须用 .venv\\Scripts\\pyinstaller.exe 打包，当前 {sys.executable}"
assert (VENV_SP / "llama_cpp" / "__init__.py").exists(), "llama_cpp 未安装于 .venv（pip install -r requirements）"

# ---------------- binaries ----------------
# llama_cpp 原生库（ggml/ggml-base/ggml-cpu/llama/mtmd 等）：
# llama_cpp 通过 Path(__file__).parent/"lib" 定位 DLL，必须保持 llama_cpp/lib/ 相对布局
# （onefile 解压到 %TEMP%\_MEIxxxx 后 _internal 同构布局，相对关系不变）。
LLAMA_LIB_DIR = VENV_SP / "llama_cpp" / "lib"
binaries = [(str(p), "llama_cpp/lib") for p in sorted(LLAMA_LIB_DIR.glob("*.dll"))]

# ---------------- datas ----------------
# main.py 用 Path(__file__).resolve().parents[1] 定位 alembic.ini 与 migrations/；
# 冻结后 app.main.__file__ → <_MEI>/app/main.pyc（module_collection_mode='pyc'），
# parents[1] 指向 _MEI 根 → alembic.ini 放根、migrations/ 放 migrations。
datas = [
    (str(SERVER_DIR / "alembic.ini"), "."),
    (str(SERVER_DIR / "migrations"), "migrations"),
]

# ---------------- hiddenimports ----------------
hiddenimports = [
    # uvicorn 按字符串懒加载的组件（hooks-contrib 的 hook-uvicorn 也会收集，这里双保险）
    "uvicorn.logging", "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl", "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
    # uvicorn auto 模式优先选用的加速实现
    "httptools", "websockets",
    # SQLAlchemy 方言（PyInstaller 自带 hook-sqlalchemy 会收方言，显式再点一次 sqlite）
    "sqlalchemy.dialects.sqlite",
    # FastAPI 表单/文件上传需要 python-multipart
    "multipart",
    # Alembic 迁移（模板渲染需 mako；迁移脚本本体作为 datas 收集）
    "alembic", "mako",
    # SQLAlchemy 2.0 依赖
    "greenlet",
    "psutil",
]
hiddenimports += collect_submodules("app")

# ---------------- Analysis ----------------
a = Analysis(
    [str(REPO / "scripts" / "server_entry.py")],
    pathex=[str(SERVER_DIR)],  # 使 `app` 包可被解析
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "pytest", "IPython", "notebook", "torch", "tensorflow",
        "onnxruntime",  # OCR 推理在独立 ocr-worker 中，server 不需要
    ],
    noarchive=False,
    # app 包以散装 .pyc 落到 _MEI/app/（而非 PYZ 内），
    # 保证 Path(__file__) 得到真实存在的路径 → parents[1] 指向 _MEI 根。
    module_collection_mode={"app": "pyc"},
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="paperlens-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # console=True：onefile parent 进程需保持存活（console=False 时 parent 数秒后
    # 以 code 3 退出，Job Object 级联失效）。由 GUI 父进程（Tauri）拉起时不弹黑窗。
    console=True,
)