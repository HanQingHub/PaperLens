# -*- mode: python ; coding: utf-8 -*-
"""PaperLens server 打包 spec（PyInstaller 6.x，onedir）→ dist/paperlens-server/

用法（仓库根目录）：
  .venv\Scripts\pyinstaller --noconfirm scripts\package_server.spec --distpath dist --workpath dist\.work-server
"""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

REPO = Path(SPECPATH).resolve().parent
SERVER_DIR = REPO / "apps" / "server"
VENV_SP = REPO / ".venv" / "Lib" / "site-packages"

# ---------------- binaries ----------------
# llama_cpp 原生库（ggml/ggml-base/ggml-cpu/llama/mtmd 等）：
# llama_cpp 通过 Path(__file__).parent/"lib" 定位 DLL，必须保持 llama_cpp/lib/ 相对布局。
LLAMA_LIB_DIR = VENV_SP / "llama_cpp" / "lib"
binaries = [(str(p), "llama_cpp/lib") for p in sorted(LLAMA_LIB_DIR.glob("*.dll"))]

# ---------------- datas ----------------
# main.py 用 Path(__file__).resolve().parents[1] 定位 alembic.ini 与 migrations/；
# 冻结后 app.main.__file__ → <_internal>/app/main.pyc（见下方 module_collection_mode='pyc'），
# 因此 alembic.ini 放 _internal 根、migrations/ 放 _internal/migrations。
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
    # app 包以散装 .pyc 落到 _internal/app/（而非 PYZ 内），
    # 保证 Path(__file__) 得到真实存在的路径 → parents[1] 指向 _internal。
    module_collection_mode={"app": "pyc"},
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="paperlens-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="paperlens-server",
)
