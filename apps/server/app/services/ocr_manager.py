"""OCR 任务管理：文件制任务协议（worker 不写库）+ 1s 轮询 + 启动恢复。

协议：{data_dir}/ocr/{paper_id}/ 下
  task.json → worker 认领改名为 task.claimed.json → 逐页追加 blocks.ndjson
  → 完成写 result.json（server 落库后删除任务文件）。
"""
import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from app.core.config import Settings
from app.core.util import now_iso
from app.models import OcrDoc, Paper

logger = logging.getLogger(__name__)


class OCRManager:
    def __init__(self, settings: Settings, session_factory) -> None:
        self.settings = settings
        self._session_factory = session_factory
        self.worker_proc: subprocess.Popen | None = None
        self._poll_task: asyncio.Task | None = None
        self._spawned_at = 0.0
        self._poll_failures = 0

    # ---- 任务入队 ----
    def enqueue(self, paper_id: int, pdf_abs: Path, pages_total: int, pages_todo: list[int] | None = None) -> None:
        d = self.settings.ocr_dir / str(paper_id)
        d.mkdir(parents=True, exist_ok=True)
        done_pages = self._done_pages(d)
        todo = pages_todo if pages_todo is not None else [p for p in range(pages_total) if p not in done_pages]
        if not todo:
            self._finalize_db(paper_id, "done", pages_done=len(done_pages), engine=None, error=None)
            return
        try:
            pdf_rel = pdf_abs.resolve().relative_to(self.settings.data_dir.resolve()).as_posix()
        except ValueError:
            pdf_rel = None
        task = {
            "paper_id": paper_id,
            "pdf_rel": pdf_rel,
            "pdf_abs": str(pdf_abs.resolve()),
            "pages_total": pages_total,
            "pages_todo": todo,
            "dpi_scale": 2.8,
            "created_at": now_iso(),
        }
        (d / "task.json").write_text(json.dumps(task, ensure_ascii=False), encoding="utf-8")
        self._set_status(paper_id, "pending", pages_total=pages_total, pages_done=len(done_pages))
        self.start_poll()
        try:
            self.spawn_worker()
        except Exception:
            logger.exception("OCR spawn_worker 失败 paper_id=%s", paper_id)

    @staticmethod
    def _strip_verbatim(p: Path) -> Path:
        s = str(p)
        if s.startswith("\\\\?\\"):
            if s.startswith("\\\\?\\UNC\\"):
                s = "\\\\" + s[8:]
            else:
                s = s[4:]
            return Path(s)
        return p

    def spawn_worker(self) -> None:
        import time

        if self.worker_proc is not None and self.worker_proc.poll() is None:
            return
        if time.monotonic() - self._spawned_at < 5:
            return  # 防止 respawn 风暴
        self._spawned_at = time.monotonic()
        try:
            if getattr(sys, "frozen", False):
                # 打包形态：拉起独立 paperlens-ocr.exe
                candidates: list[Path] = []
                env_exe = os.environ.get("PAPERLENS_OCR_EXE")
                if env_exe:
                    candidates.append(self._strip_verbatim(Path(env_exe)))
                base = Path(sys.executable).resolve().parent
                candidates += [
                    base / "paperlens-ocr" / "paperlens-ocr.exe",
                    base.parent / "paperlens-ocr" / "paperlens-ocr.exe",
                    base / "paperlens-ocr.exe",
                ]
                exe = next((c for c in candidates if c.is_file()), None)
                if exe is None:
                    return  # OCR 组件未部署：任务保持 pending
                self.worker_proc = subprocess.Popen(
                    [str(exe), "--data-dir", str(self.settings.data_dir)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                return

            cwd = Path(__file__).resolve().parents[3] / "ocr-worker"
            if not cwd.is_dir():
                return  # worker 未实现：任务保持 pending
            self.worker_proc = subprocess.Popen(
                [sys.executable, "-m", "worker.run", "--data-dir", str(self.settings.data_dir)],
                cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            logger.exception("OCR spawn_worker 异常")
            raise

    def worker_alive(self) -> bool:
        return self.worker_proc is not None and self.worker_proc.poll() is None

    # ---- 轮询 ----
    def start_poll(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            try:
                self._poll_task = asyncio.get_running_loop().create_task(self._poll_loop())
            except RuntimeError:
                pass

    async def _poll_loop(self) -> None:
        loop = asyncio.get_running_loop()
        self._poll_failures = 0
        while True:
            await asyncio.sleep(1)
            try:
                await asyncio.to_thread(self.poll_once, loop)
                self._poll_failures = 0
            except Exception:
                self._poll_failures += 1
                logger.exception("OCR poll_once 失败（连续 %d 次）", self._poll_failures)
                if self._poll_failures >= 5:
                    logger.warning("OCR poll_once 连续失败 %d 次，请检查数据目录与数据库", self._poll_failures)

    @staticmethod
    def _done_pages(d: Path) -> set[int]:
        done: set[int] = set()
        nd = d / "blocks.ndjson"
        if not nd.exists():
            return done
        with open(nd, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    done.add(int(json.loads(line).get("page", -1)))
                except (ValueError, TypeError):
                    continue
        return done

    def poll_once(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        from app.services import tfidf_service

        root = self.settings.ocr_dir
        if not root.exists():
            return
        db = self._session_factory()
        try:
            for d in sorted(root.iterdir()):
                if not d.is_dir() or not d.name.isdigit():
                    continue
                paper_id = int(d.name)
                claimed = d / "task.claimed.json"
                task = d / "task.json"
                result = d / "result.json"
                pages_done = len(self._done_pages(d))
                if result.exists():
                    try:
                        data = json.loads(result.read_text(encoding="utf-8"))
                    except ValueError:
                        data = {"status": "failed", "error": "result.json 解析失败"}
                    status = data.get("status") if data.get("status") in ("done", "failed") else "failed"
                    self._finalize_db(
                        paper_id, status,
                        pages_done=max(pages_done, int(data.get("pages_done") or 0)),
                        engine=data.get("engine"), error=data.get("error"),
                    )
                    for f in (task, claimed, result):
                        f.unlink(missing_ok=True)
                    if status == "done":
                        tfidf_service.schedule(paper_id, loop)
                elif claimed.exists():
                    self._set_status(paper_id, "running", pages_done=pages_done)
                    if not self.worker_alive():
                        logger.warning(
                            "OCR worker 已退出但 paper_id=%s 任务仍被认领（claimed 无 result），标记 failed",
                            paper_id,
                        )
                        self._finalize_db(paper_id, "failed", pages_done=pages_done,
                                           engine=None, error="worker 进程异常退出")
                        for f in (task, claimed, result):
                            f.unlink(missing_ok=True)
                elif task.exists():
                    paper = db.get(Paper, paper_id)
                    if paper is not None and paper.ocr_status == "none":
                        self._set_status(paper_id, "pending", pages_done=pages_done)
                    if not self.worker_alive():
                        self.spawn_worker()
            db.commit()
        finally:
            db.close()

    # ---- 库内状态（papers.ocr_status 为权威源，ocr_docs 同值双写）----
    def _set_status(self, paper_id: int, status: str, pages_total: int | None = None, pages_done: int | None = None) -> None:
        db = self._session_factory()
        try:
            paper = db.get(Paper, paper_id)
            if paper is not None:
                paper.ocr_status = status
            doc = db.get(OcrDoc, paper_id)
            if doc is None:
                if paper is None:
                    return
                doc = OcrDoc(paper_id=paper_id, status=status)
                db.add(doc)
            doc.status = status
            if status == "running" and not doc.started_at:
                doc.started_at = now_iso()
            if pages_total is not None:
                doc.pages_total = pages_total
            if pages_done is not None:
                doc.pages_done = pages_done
            if status in ("pending",):
                doc.error = None
                doc.started_at = None
            db.commit()
        finally:
            db.close()

    def _finalize_db(self, paper_id: int, status: str, pages_done: int, engine: str | None, error: str | None) -> None:
        db = self._session_factory()
        try:
            paper = db.get(Paper, paper_id)
            if paper is not None:
                paper.ocr_status = status
            doc = db.get(OcrDoc, paper_id)
            if doc is None:
                if paper is None:
                    return
                doc = OcrDoc(paper_id=paper_id, status=status)
                db.add(doc)
            doc.status = status
            doc.engine = engine
            doc.pages_done = pages_done
            doc.finished_at = now_iso()
            if error:
                doc.error = str(error)[:2000]
            db.commit()
        finally:
            db.close()

    # ---- 恢复 / 取消 ----
    def recover(self) -> None:
        """启动恢复：ocr_status=running 残留 → 重置 pending 重新入队（跳过已完成页）。"""
        db = self._session_factory()
        try:
            papers = db.query(Paper).filter(Paper.ocr_status == "running").all()
            for paper in papers:
                paper.ocr_status = "pending"
                doc = db.get(OcrDoc, paper.id)
                if doc is not None:
                    doc.status = "pending"
                    doc.error = None
                d = self.settings.ocr_dir / str(paper.id)
                if not d.exists():
                    d.mkdir(parents=True, exist_ok=True)
                for f in ("task.json", "task.claimed.json", "result.json"):
                    (d / f).unlink(missing_ok=True)
                pdf = self.settings.files_dir / f"{paper.file_hash}.pdf"
                self.enqueue(paper.id, pdf, paper.page_count or 1)
            db.commit()
        finally:
            db.close()

    def cancel(self, paper_id: int) -> None:
        d = self.settings.ocr_dir / str(paper_id)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    def stop_worker(self, timeout: float = 10.0) -> None:
        """终止 worker 进程并等待退出（超时强杀）。"""
        proc = self.worker_proc
        self.worker_proc = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass

    def pause(self) -> None:
        """暂停轮询与 worker（数据目录迁移前调用，避免拷贝到半写状态）。"""
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None
        self.stop_worker(timeout=10.0)

    async def stop(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None
        await asyncio.to_thread(self.stop_worker)
