"""数据目录：查询当前路径 + 迁移（复制 → 校验 → 写注册表，重启后生效）。"""
import os
import shutil
import sqlite3
import winreg
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.core.config import get_settings
from app.core.db import write_lock

router = APIRouter()

REG_KEY = r"Software\PaperLens"
REG_VALUE = "DataDir"


def _write_registry(path: str) -> None:
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_KEY) as key:
        winreg.SetValueEx(key, REG_VALUE, 0, winreg.REG_SZ, path)


@router.get("/data-dir")
def get_data_dir() -> dict:
    return {"path": str(get_settings().data_dir)}


@router.post("/data-dir/migrate")
async def migrate_data_dir(payload: dict) -> dict:
    target = str(payload.get("target") or "").strip().strip('"')
    if not target:
        raise HTTPException(400, "目标目录不能为空")
    src = get_settings().data_dir
    dst = Path(target)
    if dst.resolve() == src.resolve():
        raise HTTPException(400, "目标目录与当前数据目录相同")
    drive = os.path.splitdrive(target)[0]
    if not drive or not os.path.isdir(drive + os.sep):
        raise HTTPException(400, "目标必须是绝对路径且所在盘存在")
    if dst.exists() and any(dst.iterdir()):
        raise HTTPException(400, "目标目录已存在且非空")

    # 暂停 OCR 轮询与 worker，避免拷贝到半写状态；迁移完成后恢复
    from app.main import app

    manager = app.state.ocr_manager
    manager.pause()
    try:
        with write_lock:
            # WAL checkpoint 后再复制（避免复制到未合并的 -wal 数据）
            con = sqlite3.connect(str(src / "paperlens.db"))
            try:
                con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                con.close()
            try:
                shutil.copytree(src, dst)
            except Exception as e:
                shutil.rmtree(dst, ignore_errors=True)
                raise HTTPException(500, f"复制数据目录失败: {e}")
            if not (dst / "paperlens.db").exists():
                shutil.rmtree(dst, ignore_errors=True)
                raise HTTPException(500, "迁移校验失败：数据库未复制成功")
            # 最后写注册表：复制失败的场景天然回滚（下次启动仍用旧路径）
            try:
                _write_registry(str(dst))
            except Exception as e:
                raise HTTPException(500, f"数据已复制到 {dst}，但注册表写入失败（未切换）: {e}")
    finally:
        manager.start_poll()
    return {"ok": True, "path": str(dst), "restart_required": True}