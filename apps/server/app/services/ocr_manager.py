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
import time
from pathlib import Path

from app.core.config import Settings
from app.core.util import now_iso
from app.models import OcrDoc, Paper

logger = logging.getLogger(__name__)

# 心跳新鲜阈值（秒）：与 worker 侧 apps/ocr-worker/worker/run.py HEARTBEAT_STALE_S 同值。
HEARTBEAT_STALE_S = 900
# 任务协议文件全集：认领/完成/恢复各清理点统一引用，防止新增文件残留。
_TASK_FILES = ("task.json", "task.claimed.json", "result.json", ".heartbeat")


class OCRManager:
    def __init__(self, settings: Settings, session_factory) -> None:
        self.settings = settings
        self._session_factory = session_factory
        self.worker_proc: subprocess.Popen | None = None
        self._poll_task: asyncio.Task | None = None
        self._spawned_at = 0.0
        self._poll_failures = 0
        self._paused = (self.settings.ocr_dir / ".paused").exists()
        # blocks.ndjson 解析缓存：key=paper 目录，value=((size, mtime_ns), 已完成页)
        self._done_cache: dict[Path, tuple[tuple[int, int], frozenset[int]]] = {}

    # ---- 任务入队 ----
    def enqueue(self, paper_id: int, pdf_abs: Path, pages_total: int, pages_todo: list[int] | None = None) -> None:
        d = self.settings.ocr_dir / str(paper_id)
        d.mkdir(parents=True, exist_ok=True)
        done_pages = self._done_pages(d)
        todo = pages_todo if pages_todo is not None else [p for p in range(pages_total) if p not in done_pages]
        if not todo:
            self._finalize_db(paper_id, "done", pages_done=len(done_pages), engine=None, error=None)
            return
        # 先落库再落任务文件：worker 2s 轮询，反序会让"认领→running"被随后的
        # pending 覆盖，界面永久停在排队中
        self._set_status(paper_id, "pending", pages_total=pages_total, pages_done=len(done_pages))
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
        self.start_poll()
        if not self._paused:
            try:
                spawn = self.spawn_worker()
            except Exception:
                logger.exception("OCR spawn_worker 失败 paper_id=%s", paper_id)
                spawn = "missing"
            if spawn == "missing":
                # 组件缺失：必须落可见错误，否则界面永远转圈
                self._finalize_db(
                    paper_id, "failed", pages_done=len(done_pages), engine=None,
                    error="OCR 组件未部署或无法启动（缺少 paperlens-ocr）",
                )
                for f in _TASK_FILES:
                    (d / f).unlink(missing_ok=True)

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

    def spawn_worker(self) -> str:
        """拉起 OCR worker。返回 "alive"（已在跑/已拉起）/ "throttled"（5s 防风暴窗口内，
        稍后重试即可）/ "missing"（组件未部署，需落可见失败态）。"""
        import time

        if self.worker_proc is not None and self.worker_proc.poll() is None:
            return "alive"
        if time.monotonic() - self._spawned_at < 5:
            return "throttled"
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
                    logger.error("OCR 组件缺失：%s 下未找到 paperlens-ocr.exe", base)
                    return "missing"
                log_file = str(self.settings.logs_dir / "ocr-worker.log")
                try:
                    self.settings.logs_dir.mkdir(parents=True, exist_ok=True)
                except Exception:
                    pass
                # worker 日志走 stdout（新旧产物一致），重定向落盘保证可观测性；
                # 不传 --log-file：旧版 worker 产物不识别该参数会 exit 2
                self.worker_proc = subprocess.Popen(
                    [str(exe), "--data-dir", str(self.settings.data_dir)],
                    stdout=open(log_file, "a", encoding="utf-8"),
                    stderr=subprocess.STDOUT,
                )
                return "alive"

            cwd = Path(__file__).resolve().parents[3] / "ocr-worker"
            if not cwd.is_dir():
                logger.error("OCR worker 源码目录缺失：%s", cwd)
                return "missing"
            log_file = str(self.settings.logs_dir / "ocr-worker.log")
            try:
                self.settings.logs_dir.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
            self.worker_proc = subprocess.Popen(
                [sys.executable, "-m", "worker.run", "--data-dir", str(self.settings.data_dir), "--log-file", log_file],
                cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return "alive"
        except Exception:
            logger.exception("OCR spawn_worker 异常")
            raise

    def worker_alive(self) -> bool:
        return self.worker_proc is not None and self.worker_proc.poll() is None

    def component_available(self) -> bool:
        """OCR worker 可执行体是否就位（打包看 resources 目录，源码看 apps/ocr-worker）。"""
        if not getattr(sys, "frozen", False):
            return (Path(__file__).resolve().parents[3] / "ocr-worker").is_dir()
        env_exe = os.environ.get("PAPERLENS_OCR_EXE")
        if env_exe and self._strip_verbatim(Path(env_exe)).is_file():
            return True
        base = Path(sys.executable).resolve().parent
        return any(c.is_file() for c in (
            base / "paperlens-ocr" / "paperlens-ocr.exe",
            base.parent / "paperlens-ocr" / "paperlens-ocr.exe",
            base / "paperlens-ocr.exe",
        ))

    def is_paused(self) -> bool:
        return self._paused

    def pause_queue(self) -> None:
        self._paused = True
        try:
            self.settings.ocr_dir.mkdir(parents=True, exist_ok=True)
            (self.settings.ocr_dir / ".paused").write_text("paused", encoding="utf-8")
        except Exception:
            pass

    def resume_queue(self) -> None:
        self._paused = False
        try:
            (self.settings.ocr_dir / ".paused").unlink(missing_ok=True)
        except Exception:
            pass
        self.start_poll()
        try:
            self.spawn_worker()
        except Exception:
            logger.exception("OCR resume spawn failed")

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

    def _done_pages(self, d: Path) -> frozenset[int]:
        """已完成页集合（按 (size, mtime_ns) 缓存）。

        1s 轮询会对全部 ocr 目录调用本方法；blocks.ndjson 单篇可达数 MB，逐行
        json.loads 全量重解析实测 ~250ms/轮（59 篇 15MB），空闲期也要每秒跑一次，
        是 server 进程常驻 CPU 的主要来源。worker 每追加一页 size/mtime 必然变化，
        因此按 stat 指纹做缓存仍能即时看到进度，且空闲期只剩一次 stat。
        """
        nd = d / "blocks.ndjson"
        try:
            st = nd.stat()
        except OSError:
            self._done_cache.pop(d, None)
            return frozenset()
        sig = (st.st_size, st.st_mtime_ns)
        cached = self._done_cache.get(d)
        if cached is not None and cached[0] == sig:
            return cached[1]
        done = frozenset(self._parse_done_pages(nd))
        self._done_cache[d] = (sig, done)
        return done

    @staticmethod
    def _parse_done_pages(nd: Path) -> set[int]:
        done: set[int] = set()
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
                    for f in _TASK_FILES:
                        (d / f).unlink(missing_ok=True)
                    if status == "done":
                        tfidf_service.schedule(paper_id, loop)
                elif claimed.exists():
                    # 有 .heartbeat 看心跳；无则回退 claimed.mtime（legacy 残留/
                    # 认领后首跳前的极小窗口）。不可取 max：认领时刻恒新，
                    # 会把长页推理中停跳的心跳误判为存活
                    hb = d / ".heartbeat"
                    try:
                        activity = hb.stat().st_mtime
                    except OSError:
                        activity = claimed.stat().st_mtime
                    stale = time.time() - activity > HEARTBEAT_STALE_S
                    if self.worker_alive():
                        if stale:
                            # 不 stop_worker：该目录可能是前序崩溃遗留的孤儿 claimed，
                            # 当前 worker 或正在健康处理其他任务；陈旧回收交给 worker
                            # find_task 的回收逻辑接管（可能自动重做并救回）
                            logger.warning(
                                "OCR paper_id=%s 心跳超时（%.0fs 无进展），标记 failed",
                                paper_id, time.time() - activity,
                            )
                            self._finalize_db(paper_id, "failed", pages_done=pages_done,
                                               engine=None, error="OCR 心跳超时（疑似 worker 卡死）")
                        else:
                            self._set_status(paper_id, "running", pages_done=pages_done)
                    elif self.worker_proc is not None:
                        # 句柄存在且已退出：worker 明确崩溃，快速判死并清理
                        logger.warning(
                            "OCR worker 已退出但 paper_id=%s 任务仍被认领（claimed 无 result），标记 failed",
                            paper_id,
                        )
                        self._finalize_db(paper_id, "failed", pages_done=pages_done,
                                           engine=None, error="worker 进程异常退出")
                        for f in _TASK_FILES:
                            (d / f).unlink(missing_ok=True)
                    elif stale:
                        # server 重启后无句柄且心跳超时：确认无人处理中，判死并
                        # 清理（否则残留 claimed 会让 retry 早退、任务无法重入队）
                        logger.warning("OCR paper_id=%s 重启后无 worker 句柄且心跳超时，标记 failed", paper_id)
                        self._finalize_db(paper_id, "failed", pages_done=pages_done,
                                           engine=None, error="worker 心跳超时（服务重启后失联）")
                        for f in _TASK_FILES:
                            (d / f).unlink(missing_ok=True)
                    else:
                        # server 重启后无句柄但心跳新鲜：其他实例的活任务，保持 running
                        self._set_status(paper_id, "running", pages_done=pages_done)
                elif task.exists():
                    paper = db.get(Paper, paper_id)
                    if paper is not None and paper.ocr_status == "none":
                        self._set_status(paper_id, "pending", pages_done=pages_done)
                    if not self._paused and not self.worker_alive():
                        if not self.component_available():
                            logger.error("OCR 组件缺失，paper_id=%s 标记 failed", paper_id)
                            self._finalize_db(
                                paper_id, "failed", pages_done=pages_done, engine=None,
                                error="OCR 组件未部署或无法启动（缺少 paperlens-ocr）",
                            )
                            for f in _TASK_FILES:
                                (d / f).unlink(missing_ok=True)
                        else:
                            try:
                                self.spawn_worker()
                            except Exception:
                                logger.exception("OCR spawn 失败 paper_id=%s", paper_id)
                elif not task.exists() and not claimed.exists() and not result.exists():
                    paper = db.get(Paper, paper_id)
                    doc_tmp = db.get(OcrDoc, paper_id)
                    total = (doc_tmp.pages_total if doc_tmp and doc_tmp.pages_total else None) or (paper.page_count if paper else None) or 0
                    if paper and paper.ocr_status == "pending" and pages_done > 0 and pages_done == total and len(self._done_pages(d)) == pages_done:
                        self._finalize_db(paper_id, "done", pages_done=pages_done, engine=None, error=None)
                        for f in _TASK_FILES:
                            (d / f).unlink(missing_ok=True)
                        tfidf_service.schedule(paper_id, loop)
            db.commit()
        finally:
            db.close()

    # ---- 库内状态（papers.ocr_status 为权威源，ocr_docs 同值双写）----
    def _set_status(self, paper_id: int, status: str, pages_total: int | None = None, pages_done: int | None = None) -> None:
        db = self._session_factory()
        try:
            changed = False
            paper = db.get(Paper, paper_id)
            if paper is not None and paper.ocr_status != status:
                paper.ocr_status = status
                changed = True
            doc = db.get(OcrDoc, paper_id)
            if doc is None:
                if paper is None:
                    return
                doc = OcrDoc(paper_id=paper_id, status=status, pages_done=pages_done or 0)
                db.add(doc)
                changed = True
            elif doc.status != status:
                doc.status = status
                changed = True
            if status == "running" and not doc.started_at:
                doc.started_at = now_iso()
                changed = True
            if pages_total is not None and doc.pages_total != pages_total:
                doc.pages_total = pages_total
                changed = True
            if pages_done is not None and doc.pages_done != pages_done:
                doc.pages_done = pages_done
                changed = True
            if status == "pending" and (doc.error or doc.started_at):
                doc.error = None
                doc.started_at = None
                changed = True
            # 轮询每秒一次：无变化不提交，避免 SQLite WAL 空写放大
            if changed:
                db.commit()
            else:
                db.rollback()
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
            if engine:
                doc.engine = engine
            # 页数只增不减：并发下 worker 已写入的页不能被后到的较小值回退
            doc.pages_done = max(int(doc.pages_done or 0), int(pages_done or 0))
            if not doc.pages_total:
                doc.pages_total = paper.page_count if paper is not None else doc.pages_done
            doc.finished_at = now_iso()
            doc.error = str(error)[:2000] if error else None
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
                for f in _TASK_FILES:
                    (d / f).unlink(missing_ok=True)
                pdf = self.settings.files_dir / f"{paper.file_hash}.pdf"
                self.enqueue(paper.id, pdf, paper.page_count or 1)
            db.commit()
        finally:
            db.close()

    def cancel(self, paper_id: int) -> None:
        d = self.settings.ocr_dir / str(paper_id)
        self._done_cache.pop(d, None)
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
