"""OCR worker 入口：python -m worker.run --data-dir <目录>

扫描 {data_dir}/ocr/*/task.json，认领（rename 为 task.claimed.json）后串行逐页处理：
pypdfium2 灰度渲染 → RapidOCR → 段落聚合 → 追加 blocks.ndjson → result.json。
无任务连续 60s 后 exit 0。
"""
import argparse
import importlib.metadata
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pypdfium2 as pdfium

from .ndjson import append_ndjson, build_record, read_done_pages
from .ocr_engine import get_engine, rebuild_engine
from .paragraph import blocks_to_pdf, group_lines

IDLE_EXIT_S = 60
POLL_S = 2
PAGE_RETRY = 3

_LOG_FILE = None


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    if _LOG_FILE is not None:
        try:
            with open(_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def engine_name():
    """OCR 引擎标识：优先发行版版本，回退历史硬编码字符串。"""
    try:
        return f"rapidocr-{importlib.metadata.version('rapidocr')}"
    except importlib.metadata.PackageNotFoundError:
        return "rapidocr-3.9.2"


def find_task(ocr_root: Path):
    tasks = []
    if not ocr_root.is_dir():
        return None
    for d in ocr_root.iterdir():
        if not d.is_dir():
            continue
        tj = d / "task.json"
        if not tj.is_file():
            claimed = d / "task.claimed.json"
            if claimed.is_file() and not (d / "result.json").is_file():
                try:
                    os.rename(claimed, tj)
                except OSError:
                    continue
        if tj.is_file():
            try:
                pid = int(d.name)
            except ValueError:
                pid = 1 << 30
            tasks.append((pid, tj))
    if not tasks:
        return None
    tasks.sort(key=lambda t: t[0])
    return tasks[0][1]


def resolve_scale(task):
    """task.json dpi_scale → 环境变量 PAPERLENS_DPI_SCALE → 默认 2.8。"""
    scale = task.get("dpi_scale")
    if scale is None:
        env = os.environ.get("PAPERLENS_DPI_SCALE")
        if env is not None:
            try:
                scale = float(env)
            except ValueError:
                scale = None
    return scale if scale is not None else 2.8


def scale_valid(scale):
    return (
        isinstance(scale, (int, float))
        and not isinstance(scale, bool)
        and math.isfinite(scale)
        and scale > 0
    )


def write_result(task_dir: Path, status, pages_done, error=None):
    result = {
        "status": status,
        "error": error,
        "pages_done": pages_done,
        "engine": engine_name(),
        "finished_at": utc_now(),
    }
    (task_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )


def ocr_page(engine, pdf, page_no, scale):
    page = pdf[page_no]
    page_h_pt = page.get_size()[1]
    page_rot = page.get_rotation()
    bitmap = page.render(scale=scale, grayscale=True)
    img = bitmap.to_numpy()
    boxes, txts, scores = engine(img)
    blocks_px = group_lines(boxes, txts, scores)
    return blocks_to_pdf(blocks_px, scale, page_h_pt), page_rot


def process_task(claimed: Path, data_dir: Path):
    task_dir = claimed.parent
    try:
        task = json.loads(claimed.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
        bad = task_dir / "task.bad.json"
        try:
            claimed.replace(bad)
        except OSError:
            pass
        log(f"task.json 解析失败，现场保留为 {bad.name}: {e}")
        return
    paper_id = task["paper_id"]
    pdf_path = Path(task["pdf_abs"]) if task.get("pdf_abs") else data_dir / task["pdf_rel"]
    todo = task["pages_todo"]
    scale = resolve_scale(task)
    if not scale_valid(scale):
        write_result(task_dir, "failed", 0, f"dpi_scale 非法: {scale!r}")
        log(f"paper_id={paper_id} 拒绝任务：dpi_scale={scale!r} 非正或非有限")
        return
    ndjson = task_dir / "blocks.ndjson"
    done = read_done_pages(ndjson)
    remaining = [p for p in todo if p not in done]
    log(f"认领任务 paper_id={paper_id} pdf={pdf_path} 待处理页 {len(remaining)}/{len(todo)}")

    if not remaining:
        write_result(task_dir, "done", len(done))
        log(f"paper_id={paper_id} 全部页已完成，直接写 result")
        return

    try:
        pdf = pdfium.PdfDocument(str(pdf_path))
    except Exception as e:
        write_result(task_dir, "failed", len(done), f"打开 PDF 失败: {e}")
        log(f"paper_id={paper_id} 打开 PDF 失败: {e}")
        return

    error = None
    try:
        for page_no in remaining:
            if not task_dir.exists():
                log(f"paper_id={paper_id} 任务目录已删除，放弃")
                return
            for attempt in range(1, PAGE_RETRY + 1):
                try:
                    t0 = time.perf_counter()
                    if attempt >= 2:
                        rebuild_engine()
                    engine = get_engine()
                    blocks, page_rot = ocr_page(engine, pdf, page_no, scale)
                    append_ndjson(
                        ndjson,
                        build_record(
                            paper_id, page_no, scale, blocks,
                            page_rot=page_rot, engine=engine_name(),
                        ),
                    )
                    done.add(page_no)
                    log(f"  page {page_no}: {len(blocks)} blocks, {time.perf_counter() - t0:.1f}s")
                    break
                except Exception as e:
                    error = f"page {page_no} 第 {attempt} 次失败: {e}"
                    log(f"  {error}")
                    if not task_dir.exists():
                        log(f"paper_id={paper_id} 任务目录已删除，放弃")
                        return
            else:
                write_result(task_dir, "failed", len(done), error)
                log(f"paper_id={paper_id} 连续失败 {PAGE_RETRY} 次，标记 failed")
                return
        write_result(task_dir, "done", len(todo))
        log(f"paper_id={paper_id} 完成，共 {len(todo)} 页")
    finally:
        pdf.close()


def main():
    global _LOG_FILE
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="PaperLens OCR worker")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--log-file", default=None, help="追加写入日志文件（默认仅 stdout）")
    args = ap.parse_args()
    _LOG_FILE = Path(args.log_file).resolve() if args.log_file else None
    data_dir = Path(args.data_dir).resolve()
    ocr_root = data_dir / "ocr"

    idle_since = None
    while True:
        task_json = find_task(ocr_root)
        if task_json is None:
            now = time.time()
            if idle_since is None:
                idle_since = now
                log(f"无任务，{IDLE_EXIT_S}s 后退出（轮询 {ocr_root}）")
            if now - idle_since >= IDLE_EXIT_S:
                log("空闲超时，退出")
                return
            time.sleep(POLL_S)
            continue
        idle_since = None
        claimed = task_json.with_name("task.claimed.json")
        try:
            os.rename(task_json, claimed)
        except OSError:
            continue
        try:
            process_task(claimed, data_dir)
        except Exception as e:
            log(f"任务异常: {e}")
            if claimed.parent.exists():
                write_result(claimed.parent, "failed", 0, f"worker 异常: {e}")
        if claimed.exists():
            try:
                claimed.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    main()