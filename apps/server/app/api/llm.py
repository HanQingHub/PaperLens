import asyncio
import hashlib
import json
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import get_settings
from app.services.llm_service import BUILTIN_MODELS, llm_service

router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/models")
def list_models():
    return llm_service.scan_models()


class DownloadIn(BaseModel):
    model_id: str


@router.post("/download")
async def download(body: DownloadIn):
    model = next((m for m in BUILTIN_MODELS if m["id"] == body.model_id), None)
    if model is None:
        raise HTTPException(status_code=404, detail="未知模型")

    settings = get_settings()
    settings.ensure_dirs()
    dest: Path = settings.models_dir / model["file"]
    part = dest.with_suffix(".gguf.part")
    expected_sha = model.get("sha256")
    sources = list(model["sources"])

    def sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def gen():
        headers = {"User-Agent": "PaperLens/1.0"}
        for i, url in enumerate(sources):
            start = part.stat().st_size if part.exists() else 0
            req_headers = dict(headers)
            if start > 0:
                req_headers["Range"] = f"bytes={start}-"
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=15), follow_redirects=True) as client:
                    async with client.stream("GET", url, headers=req_headers) as resp:
                        if resp.status_code not in (200, 206):
                            raise httpx.HTTPStatusError(f"HTTP {resp.status_code}", request=resp.request, response=resp)
                        total = int(resp.headers.get("content-length") or 0) + (start if resp.status_code == 206 else 0)
                        resumed = resp.status_code == 206 and start > 0
                        mode = "ab" if resumed else "wb"
                        if not resumed and part.exists():
                            part.unlink()
                        downloaded = start if resumed else 0
                        h = hashlib.sha256()
                        if resumed and expected_sha:
                            with open(part, "rb") as f:
                                for chunk in iter(lambda: f.read(1 << 20), b""):
                                    h.update(chunk)
                        with open(part, mode) as out:
                            async for chunk in resp.aiter_bytes(1 << 20):
                                out.write(chunk)
                                h.update(chunk)
                                downloaded += len(chunk)
                                yield sse("progress", {
                                    "downloaded": downloaded,
                                    "total_bytes": total,
                                    "percent": round(downloaded * 100 / total, 2) if total else None,
                                })
                if expected_sha:
                    actual = await asyncio.to_thread(_sha256_file, part)
                    if actual != expected_sha:
                        part.unlink(missing_ok=True)
                        raise ValueError("sha256 校验失败")
                part.rename(dest)
                yield sse("done", {"model_id": model["id"], "file": model["file"], "size_bytes": dest.stat().st_size})
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                if i == len(sources) - 1:
                    yield sse("error", {"code": "internal", "detail": f"下载失败：{e}"})
                    return
                continue

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class LoadIn(BaseModel):
    model_id: str


@router.post("/load", status_code=202)
async def load(body: LoadIn):
    if llm_service.state == "ready" and llm_service.model_id == body.model_id:
        return {"state": "ready"}
    if llm_service.state == "loading":
        return {"state": "loading"}
    await llm_service.unload()  # 切换模型：先卸载再加载
    llm_service.start_load(body.model_id)
    return {"state": "loading"}


@router.post("/unload")
async def unload():
    await llm_service.unload()
    return {"state": "unloaded"}


@router.get("/status")
def status():
    return llm_service.status()


@router.post("/import")
async def import_model(
    file: UploadFile | None = File(None),
    gguf: UploadFile | None = File(None),
):
    upload = gguf or file
    if upload is None:
        raise HTTPException(status_code=422, detail="缺少 GGUF 文件（字段 gguf/file）")
    settings = get_settings()
    settings.ensure_dirs()
    filename = upload.filename or ""
    if not filename.lower().endswith(".gguf"):
        raise HTTPException(status_code=400, detail="仅支持 GGUF 文件")
    dest = settings.models_dir / Path(filename).name
    tmp = settings.models_dir / f".import-{uuid.uuid4().hex}.gguf"
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = await upload.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        if dest.exists():
            dest.unlink()
        tmp.rename(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return {"id": dest.stem.lower(), "file": dest.name, "size_bytes": dest.stat().st_size}
