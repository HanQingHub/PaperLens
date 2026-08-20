"""端到端冒烟测试：全链路验证（注册→上传→翻译四层→生词→批注→OCR→统计→备份）。

用法：.venv\\Scripts\\python.exe scripts\\e2e_smoke.py [--port 8737] [--skip-llm] [--skip-ocr] [--spawn]

--spawn：脚本自行拉起独立后端（唯一数据目录 .dev-data/e2e-<pid>-<时间戳>，
结束后杀整棵进程树并清理数据目录；失败时保留目录供排查）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sse_utils import parse_sse  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
RESULTS: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = ""):
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def spawn_server(port: int) -> tuple[subprocess.Popen, Path]:
    """拉起 uvicorn（唯一数据目录），返回 (proc, data_dir)。端口被占则退出。"""
    try:
        # trust_env=False：本地环回不走系统代理（否则代理会伪造"占用"假象）
        httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=2, trust_env=False)
        print(f"[e2e] 端口 {port} 已被占用（手工服务器？），--spawn 需要空闲端口，换 --port 重试")
        sys.exit(2)
    except httpx.HTTPError:
        pass

    data_dir = REPO / ".dev-data" / f"e2e-{os.getpid()}-{int(time.time())}"
    data_dir.mkdir(parents=True, exist_ok=True)
    # 全新数据目录无 ecdict.db → 复用 dev_check 的迷你词典（ECDICT 层兜底 + lemma 还原断言）
    sys.path.insert(0, str(REPO / "apps" / "server"))
    from dev_check import make_mini_ecdict
    make_mini_ecdict(data_dir / "ecdict.db")
    env = os.environ.copy()
    env["PAPERLENS_DATA_DIR"] = str(data_dir)
    env["PAPERLENS_MODELS_DIR"] = str(REPO / "assets" / "models")
    env["PYTHONIOENCODING"] = "utf-8"
    py = REPO / ".venv" / "Scripts" / "python.exe"
    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(REPO / "apps" / "server"),
        env=env,
    )
    print(f"[e2e] 已拉起后端 pid={proc.pid} data_dir={data_dir}")

    t0 = time.time()
    while time.time() - t0 < 60:
        if proc.poll() is not None:
            print(f"[e2e] 后端进程提前退出 (code={proc.returncode})")
            sys.exit(2)
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=2, trust_env=False).status_code == 200:
                print(f"[e2e] 后端就绪（{time.time() - t0:.1f}s）")
                return proc, data_dir
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    print("[e2e] 后端 60s 内未就绪")
    kill_tree(proc)
    sys.exit(2)


def kill_tree(proc: subprocess.Popen):
    """杀整棵进程树（server 自行拉起的 OCR worker 是其子进程）。"""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def ensure_demo_pdf():
    """demo-text.pdf 缺失时用 make_text_pdf.py 生成（摆脱手工准备依赖）。"""
    demo = REPO / ".dev-data" / "samples" / "demo-text.pdf"
    if demo.is_file():
        return
    demo.parent.mkdir(parents=True, exist_ok=True)
    py = REPO / ".venv" / "Scripts" / "python.exe"
    r = subprocess.run([str(py), str(REPO / "scripts" / "make_text_pdf.py"),
                        "--out", str(demo), "--pages", "3"], capture_output=True)
    if r.returncode != 0 or not demo.is_file():
        print(f"[e2e] demo-text.pdf 生成失败：{r.stderr.decode(errors='replace')[-300:]}")
        sys.exit(2)


def run_tests(args, data_dir: Path) -> int:
    base = f"http://127.0.0.1:{args.port}/api"
    # trust_env=False：本地环回不走系统代理
    c = httpx.Client(timeout=120, trust_env=False)

    suffix = str(int(time.time()))[-6:]
    user, pwd = f"e2e_{suffix}", "Passw0rd!e2e"

    # ── 1 账号 ──
    r = c.post(f"{base}/auth/register", json={"username": user, "password": pwd})
    ok = r.status_code == 200 and r.json().get("token")
    step("注册", bool(ok), f"HTTP {r.status_code}")
    if not ok:
        sys.exit(1)
    tok = r.json()["token"]
    c.headers["Authorization"] = f"Bearer {tok}"

    r = c.post(f"{base}/auth/login", json={"username": user, "password": pwd, "remember": True})
    step("登录(remember)", r.status_code == 200 and r.json().get("token"), f"HTTP {r.status_code}")
    r = c.get(f"{base}/me")
    step("GET /me", r.status_code == 200 and r.json()["user"]["username"] == user)

    # ── 2 项目与上传 ──
    r = c.post(f"{base}/projects", json={"name": "E2E 项目"})
    proj_id = r.json().get("id")
    step("创建项目", r.status_code in (200, 201) and proj_id is not None)

    demo = REPO / ".dev-data" / "samples" / "demo-text.pdf"
    with open(demo, "rb") as f:
        r = c.post(
            f"{base}/papers/upload",
            data={"project_id": str(proj_id), "is_scanned": "false"},
            files={"file": ("demo-text.pdf", f, "application/pdf")},
            timeout=60,
        )
    paper = r.json().get("paper", {}) if r.status_code == 200 else {}
    pid = paper.get("id")
    step("上传文本型 PDF", bool(pid), f"paper_id={pid} pages={paper.get('page_count')} title={paper.get('title')!r}")

    # ── 3 LLM 加载 ──
    if not args.skip_llm:
        r = c.get(f"{base}/llm/models")
        models = r.json() if r.status_code == 200 else []
        model_id = next((m["id"] for m in models if m.get("downloaded") and "2b" in m["id"].lower()), None)
        if model_id is None and models:
            model_id = next((m["id"] for m in models if m.get("downloaded")), None)
        step("模型清单", bool(model_id), f"{len(models)} 个模型, 选用 {model_id}")
        if model_id:
            r = c.post(f"{base}/llm/load", json={"model_id": model_id})
            t0 = time.time()
            ready = False
            while time.time() - t0 < 120:
                st = c.get(f"{base}/llm/status").json()
                if st["state"] == "ready":
                    ready = True
                    break
                if st.get("error"):
                    break
                time.sleep(1)
            step("LLM 加载", ready, f"{time.time()-t0:.1f}s, rss={st.get('rss_mb')}MB")

    # ── 4 翻译四层 ──
    t0 = time.time()
    with c.stream(
        "POST",
        f"{base}/translate/word",
        json={"paper_id": pid, "word": "attention", "sentence": "We study the attention mechanism.", "prev": "", "next": ""},
        timeout=180,
    ) as resp:
        body = "".join(resp.iter_text())
    evs = parse_sse(body)
    names = [e for e, _ in evs]
    hit_layers = [d.get("layer") for e, d in evs if e == "hit"]
    has_delta = "delta" in names
    dt = time.time() - t0
    step(
        "划词翻译(首查 ECDICT+LLM)",
        "hit" in names and ("done" in names or "error" in names),
        f"{dt:.1f}s layers={hit_layers} delta={has_delta} events={names[:8]}",
    )
    llm_text = "".join(d.get("text", "") for e, d in evs if e == "delta")
    if llm_text:
        print(f"    LLM 输出前 160 字：{llm_text[:160]!r}", flush=True)

    t0 = time.time()
    with c.stream(
        "POST",
        f"{base}/translate/word",
        json={"paper_id": pid, "word": "attention", "sentence": "We study the attention mechanism.", "prev": "", "next": ""},
        timeout=60,
    ) as resp:
        body = "".join(resp.iter_text())
    evs2 = parse_sse(body)
    cache_hit = any(e == "hit" and d.get("layer") == "cache" for e, d in evs2)
    step("划词翻译(二查缓存)", cache_hit, f"{(time.time()-t0)*1000:.0f}ms layers={[d.get('layer') for e,d in evs2 if e=='hit']}")

    with c.stream(
        "POST",
        f"{base}/translate/sentence",
        json={"paper_id": pid, "text": "We study the attention mechanism in transformers.", "prev": "", "next": ""},
        timeout=180,
    ) as resp:
        body = "".join(resp.iter_text())
    evs3 = parse_sse(body)
    n3 = [e for e, _ in evs3]
    step("句译 SSE", "done" in n3 or "hit" in n3, f"events={n3[:6]}")

    # 词典端点
    r = c.get(f"{base}/dictionary/studies")
    ok = r.status_code == 200 and r.json().get("lemma") == "study"
    step("词典查询 studies→study(lemma.en.txt)", bool(ok), f"lemma={r.json().get('lemma') if r.status_code == 200 else r.status_code}")

    # ── 5 生词 ──
    r = c.post(
        f"{base}/words",
        json={"lemma": "attention", "translation": "注意力", "paper_id": pid, "sentence": "We study attention.", "context": ""},
    )
    word = r.json() if r.status_code in (200, 201) else {}
    step("入生词库", r.status_code in (200, 201) and word.get("lemma") == "attention", f"HTTP {r.status_code} stage={word.get('stage')}")
    if not word.get("id"):
        print("    ⚠ 生词创建返回缺 id，跳过复习/导出断言", flush=True)
        RESULTS.append(("SM-2 复习 q=5", False, "无 word.id"))
    else:
        r = c.post(f"{base}/words/{word['id']}/review", json={"q": 5})
        step("SM-2 复习 q=5", r.status_code == 200 and r.json().get("interval", 0) >= 1, str(r.json()))
    r = c.get(f"{base}/words", params={"q": "atten"})
    step("生词查询", r.status_code == 200 and len(r.json()) >= 1)
    r = c.get(f"{base}/words/export", params={"format": "csv"})
    csv_ok = r.status_code == 200 and r.content[:3] == b"\xef\xbb\xbf"
    step("生词导出 CSV(UTF-8 BOM)", csv_ok, f"{len(r.content)}B")

    # ── 6 批注 ──
    anchor = json.dumps({"rects": [[100, 700, 200, 712]], "text": "attention mechanism"})
    card = json.dumps({"x": 400, "y": 700, "w": 220, "h": 140})
    r = c.post(
        f"{base}/papers/{pid}/annotations",
        json={"page_no": 1, "type": "word_note", "anchor_json": anchor, "card_json": card, "text": "核心概念"},
    )
    anno = r.json() if r.status_code in (200, 201) else {}
    step("连线批注创建", bool(anno.get("id")), f"id={anno.get('id')} HTTP {r.status_code}")
    r = c.post(
        f"{base}/papers/{pid}/annotations",
        json={"page_no": 1, "type": "sentence", "anchor_json": anchor, "color": "green", "text": ""},
    )
    step("句子高亮批注", r.status_code in (200, 201))
    r = c.patch(f"{base}/annotations/{anno['id']}", json={"text": "核心概念(改)"})
    step("批注 PATCH", r.status_code == 200 and r.json().get("text") == "核心概念(改)")
    r = c.get(f"{base}/papers/{pid}/annotations")
    step("批注列表", r.status_code == 200 and len(r.json()) >= 2, f"{len(r.json())} 条")
    r = c.post(f"{base}/papers/{pid}/export-annotations-pdf", timeout=120)
    step("批注写回 PDF", r.status_code == 200 and r.content[:5] == b"%PDF-", f"{len(r.content)}B")
    (REPO / ".tmp-e2e-annotations.pdf").write_bytes(r.content if r.status_code == 200 else b"")
    r = c.post(f"{base}/papers/{pid}/export-annotations-md", timeout=60)
    step("批注导出 Markdown", r.status_code == 200 and len(r.content) > 0, f"{len(r.content)}B")

    # ── 7 术语表（TF-IDF 后台，等待至多 240s）──
    t0 = time.time()
    terms: list = []
    while time.time() - t0 < 240:
        r = c.get(f"{base}/papers/{pid}/glossary")
        terms = r.json() if r.status_code == 200 else []
        if len(terms) >= 5:
            break
        time.sleep(5)
    with_trans = [t for t in terms if t.get("domain_translation")]
    step("术语表自举(TF-IDF+预译)", len(terms) >= 5, f"{len(terms)} 条, 已预译 {len(with_trans)} 条, 用时 {time.time()-t0:.0f}s")
    if terms:
        r = c.post(f"{base}/glossary/terms", json={"paper_id": pid, "term": terms[0]["term"], "domain_translation": "用户修正译法"})
        step("术语用户修正", r.status_code in (200, 201) and r.json().get("source") == "user")

    # ── 8 阅读与统计 ──
    r = c.put(f"{base}/reading-progress/{pid}", json={"page_no": 2, "scroll_y": 0.35})
    step("进度保存", r.status_code == 200)
    r = c.get(f"{base}/reading-progress/{pid}")
    step("进度读取", r.status_code == 200 and r.json().get("page_no") == 2)
    now = int(time.time())
    r = c.post(
        f"{base}/reading-sessions",
        json={"paper_id": pid, "start_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 300)), "end_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))},
    )
    step("阅读会话记录", r.status_code in (200, 201))
    r = c.get(f"{base}/stats/overview")
    ov = r.json() if r.status_code == 200 else {}
    step("统计概览", r.status_code == 200 and ov.get("today_s", 0) >= 300, f"today_s={ov.get('today_s')} streak={ov.get('streak')}")

    # ── 9 摘录 ──
    r = c.post(f"{base}/excerpts", json={"paper_id": pid, "page_no": 1, "text": "Attention is all you need.", "translation": "注意力就是你所需要的一切。"})
    step("摘录保存", r.status_code in (200, 201))
    r = c.post(f"{base}/excerpts/export", params={"paper_id": pid})
    step("摘录导出 Markdown", r.status_code == 200 and len(r.content) > 0)

    # ── 10 设置 ──
    r = c.put(f"{base}/settings", json={"theme": "dark", "highlight_style": 3})
    ok = r.status_code == 200 and r.json().get("theme") == "dark"
    step("设置更新", bool(ok))

    # ── 11 OCR 全链路 ──
    if not args.skip_ocr:
        scanned = REPO / "assets" / "samples" / "scanned-philtrans-joule-1850.pdf"
        with open(scanned, "rb") as f:
            r = c.post(
                f"{base}/papers/upload",
                data={"project_id": str(proj_id), "is_scanned": "true"},
                files={"file": ("joule-1850.pdf", f, "application/pdf")},
                timeout=120,
            )
        sp = r.json().get("paper", {}) if r.status_code == 200 else {}
        spid = sp.get("id")
        step("上传扫描版", bool(spid), f"paper_id={spid} pages={sp.get('page_count')} ocr_status={sp.get('ocr_status')}")
        r = c.post(f"{base}/papers/{spid}/ocr", timeout=30)
        step("OCR 入队", r.status_code == 202, str(r.json()))
        t0 = time.time()
        st = {}
        while time.time() - t0 < 900:
            st = c.get(f"{base}/papers/{spid}/ocr-status").json()
            if st["status"] in ("done", "failed"):
                break
            time.sleep(3)
        step(
            "OCR 完成",
            st.get("status") == "done",
            f"{st.get('pages_done')}/{st.get('pages_total')} 页 用时 {time.time()-t0:.0f}s err={st.get('error')}",
        )
        if st.get("status") == "done":
            r = c.get(f"{base}/papers/{spid}/ocr-result", timeout=60)
            lines = [ln for ln in r.text.split("\n") if ln.strip()]
            first = json.loads(lines[0]) if lines else {}
            blocks_n = sum(len(p.get("blocks", [])) for p in (json.loads(l) for l in lines))
            nd = data_dir / "ocr" / str(spid) / "blocks.ndjson"
            step("OCR 结果拉取", len(lines) == st.get("pages_total"), f"{len(lines)} 页 NDJSON, {blocks_n} 块, 文件保留={nd.exists()}")
            # OCR 后划词翻译（叠加层场景等价于普通划词）
            with c.stream(
                "POST",
                f"{base}/translate/word",
                json={"paper_id": spid, "word": "heat", "sentence": first.get("blocks", [{}])[0].get("text", "")[:120], "prev": "", "next": ""},
                timeout=120,
            ) as resp:
                body = "".join(resp.iter_text())
            evs4 = parse_sse(body)
            step("OCR 页划词翻译", any(e == "hit" for e, _ in evs4), f"layers={[d.get('layer') for e,d in evs4 if e=='hit']}")

    # ── 12 备份 ──
    r = c.post(f"{base}/backup/export", timeout=120)
    step("备份导出 zip", r.status_code == 200 and r.content[:2] == b"PK", f"{len(r.content)}B")

    # ── 汇总 ──
    fails = [x for x in RESULTS if not x[1]]
    print(f"\n===== E2E 汇总：{len(RESULTS) - len(fails)}/{len(RESULTS)} 通过 =====", flush=True)
    for name, _, detail in fails:
        print(f"  ✗ {name}: {detail}", flush=True)
    return 1 if fails else 0


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8737)
    ap.add_argument("--skip-llm", action="store_true")
    ap.add_argument("--skip-ocr", action="store_true")
    ap.add_argument("--spawn", action="store_true",
                    help="自动拉起独立后端（唯一数据目录，结束后清理；不指定则连接已运行的服务器）")
    args = ap.parse_args()

    ensure_demo_pdf()
    proc = None
    data_dir = REPO / ".dev-data"
    rc = 1
    if args.spawn:
        proc, data_dir = spawn_server(args.port)
    try:
        rc = run_tests(args, data_dir)
    finally:
        if proc is not None:
            kill_tree(proc)
    if proc is not None:
        if rc == 0:
            shutil.rmtree(data_dir, ignore_errors=True)
            print(f"[e2e] 已清理数据目录 {data_dir}")
        else:
            print(f"[e2e] 数据目录保留供排查：{data_dir}")
    sys.exit(rc)


if __name__ == "__main__":
    main()
