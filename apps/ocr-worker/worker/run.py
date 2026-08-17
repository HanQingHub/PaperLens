"""OCR worker 入口：python -m worker.run --data-dir <目录>

扫描 {data_dir}/ocr/*/task.json，认领（rename 为 task.claimed.json）后串行逐页处理：
pypdfium2 灰度渲染 → RapidOCR → 段落聚合 → 追加 blocks.ndjson → result.json。
无任务连续 60s 后 exit 0。
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pypdfium2 as pdfium

from .ocr_engine import OcrEngine
from .paragraph import blocks_to_pdf, group_lines

IDLE_EXIT_S = 60
POLL_S = 2
PAGE_RETRY = 3
ENGINE_NAME = "rapidocr-3.9.2"


def log(msg):
    print(msg, flush=True)


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def find_task(ocr_root: Path):
    tasks = []
    if not ocr_root.is_dir():
        return None
    for d in ocr_root.iterdir():
        tj = d / "task.json"
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


def read_done_pages(ndjson: Path):
    done = set()
    if not ndjson.exists():
        return done
    with open(ndjson, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["page"])
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return done


def append_ndjson(ndjson: Path, record: dict):
    with open(ndjson, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_result(task_dir: Path, status, pages_done, error=None):
    result = {
        "status": status,
        "error": error,
        "pages_done": pages_done,
        "engine": ENGINE_NAME,
        "finished_at": utc_now(),
    }
    (task_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )


def ocr_page(engine, pdf, page_no, scale):
    page = pdf[page_no]
    page_h_pt = page.get_size()[1]
    bitmap = page.render(scale=scale, grayscale=True)
    img = bitmap.to_numpy()
    boxes, txts, scores = engine(img)
    blocks_px = group_lines(boxes, txts, scores)
    return blocks_to_pdf(blocks_px, scale, page_h_pt)


def process_task(claimed: Path, data_dir: Path):
    task_dir = claimed.parent
    task = json.loads(claimed.read_text(encoding="utf-8"))
    paper_id = task["paper_id"]
    pdf_path = Path(task["pdf_abs"]) if task.get("pdf_abs") else data_dir / task["pdf_rel"]
    todo = task["pages_todo"]
    scale = task.get("dpi_scale", 2.8)
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

    engine = None
    error = None
    try:
        for page_no in remaining:
            if not task_dir.exists():
                log(f"paper_id={paper_id} 任务目录已删除，放弃")
                return
            for attempt in range(1, PAGE_RETRY + 1):
                try:
                    t0 = time.perf_counter()
                    if engine is None:
                        engine = OcrEngine()
                    blocks = ocr_page(engine, pdf, page_no, scale)
                    append_ndjson(
                        ndjson,
                        {"paper_id": paper_id, "page": page_no,
                         "dpi_scale": scale, "blocks": blocks},
                    )
                    log(f"  page {page_no}: {len(blocks)} blocks, {time.perf_counter() - t0:.1f}s")
                    break
                except Exception as e:
                    error = f"page {page_no} 第 {attempt} 次失败: {e}"
                    log(f"  {error}")
                    if not task_dir.exists():
                        log(f"paper_id={paper_id} 任务目录已删除，放弃")
                        return
            else:
                write_result(task_dir, "failed", len(read_done_pages(ndjson)), error)
                log(f"paper_id={paper_id} 连续失败 {PAGE_RETRY} 次，标记 failed")
                return
        write_result(task_dir, "done", len(todo))
        log(f"paper_id={paper_id} 完成，共 {len(todo)} 页")
    finally:
        pdf.close()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="PaperLens OCR worker")
    ap.add_argument("--data-dir", required=True)
    args = ap.parse_args()
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
