# -*- mode: python ; coding: utf-8 -*-
r"""PaperLens OCR worker 打包 spec（PyInstaller 6.x，onedir）→ dist/paperlens-ocr/

用法（仓库根目录）：
  .venv\Scripts\pyinstaller --noconfirm scripts\package_ocr_worker.spec --distpath dist --workpath build/.work-ocr

spec 末尾自动对产物执行冻结冒烟（paperlens-ocr.exe --smoke），失败即构建失败。
PyInstaller 版本锁定见 apps/ocr-worker/pyproject.toml。
"""
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_dynamic_libs

REPO = Path(SPECPATH).resolve().parent
WORKER_DIR = REPO / "apps" / "ocr-worker"

datas = []
binaries = []
hiddenimports = []

# onnxruntime：pybind 扩展 + providers 动态库（collect-all 覆盖 hook-onnxruntime）
# rapidocr：内置 onnx 模型（models/*.onnx）+ config yaml + 全部子模块
for pkg in ("onnxruntime", "rapidocr"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# pypdfium2 原生库：pdfium.dll 在独立包 pypdfium2_raw 中（hooks-contrib 亦有 hook，双保险显式收集）
binaries += collect_dynamic_libs("pypdfium2_raw")
datas += collect_data_files("pypdfium2_raw")  # version.json
datas += collect_data_files("pypdfium2")      # version.json

# rapidocr 后处理依赖（静态导入可被追踪，显式列出以防动态引用）
hiddenimports += ["cv2", "numpy", "pyclipper", "shapely", "PIL"]

a = Analysis(
    [str(WORKER_DIR / "entry.py")],
    pathex=[str(WORKER_DIR)],  # 使 `worker` 包可被解析
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "IPython", "torch", "tensorflow"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="paperlens-ocr",
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
    name="paperlens-ocr",
)

# 冻结后冒烟：构建环境内运行产物，import 全部核心模块并跑一次最小推理
import subprocess
import sys

smoke_exe = Path(DISTPATH) / "paperlens-ocr" / "paperlens-ocr.exe"
if not smoke_exe.is_file():
    raise SystemExit(f"冒烟失败：未找到产物 {smoke_exe}")
rc = subprocess.run([str(smoke_exe), "--smoke"], timeout=600).returncode
if rc != 0:
    raise SystemExit(f"冒烟失败：paperlens-ocr --smoke 退出码 {rc}")
print(f"冒烟通过：{smoke_exe}")
