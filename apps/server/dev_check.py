"""dev 起服实测脚本：注册→上传→列表→翻译 SSE（ECDICT 兜底）→OCR 入队→统计。

用法：PAPERLENS_DATA_DIR 指向 .dev-data，服务器已在 127.0.0.1:8737 运行后执行。
"""
import json
import sqlite3
import sys
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8737"
DATA_DIR = Path(__file__).parent / ".dev-data"
RESULTS = []


def step(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name} {detail}")


def make_pdf(path: Path):
    sys.path.insert(0, str(Path(__file__).parent / "tests"))
    from pdfgen import make_pdf_bytes

    path.write_bytes(make_pdf_bytes([("Hello world of attention", "Second line")], title="Dev Test Paper"))
    return path


def make_mini_ecdict(path: Path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE dictionary(word TEXT PRIMARY KEY, pos TEXT, phonetic TEXT, translation TEXT,"
                " collins_star INTEGER, tag TEXT, exchange TEXT)")
    con.execute("CREATE TABLE lemmas(word TEXT PRIMARY KEY, lemma TEXT)")
    con.executemany("INSERT INTO dictionary VALUES (?,?,?,?,?,?,?)", [
        ("attention", "n.", "əˈtenʃn", "注意;关注\n注意力", 3, "", ""),
        ("world", "n.", "wɜːld", "世界", 2, "", ""),
    ])
    con.commit()
    con.close()


def main():
    make_mini_ecdict(DATA_DIR / "ecdict.db")
    with httpx.Client(base_url=BASE, timeout=30, trust_env=False) as c:
        for _ in range(30):
            try:
                if c.get("/api/health").status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            step("服务器健康检查", False)
            return
        step("服务器健康检查", True)

        r = c.post("/api/auth/register", json={"username": "devuser", "password": "secret123"})
        if r.status_code == 409:
            r = c.post("/api/auth/login", json={"username": "devuser", "password": "secret123"})
        token = r.json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        step("注册/登录", bool(token))

        # 幂等：已有论文则复用（内容 hash 去重下重复上传也只是引用计数 +1）
        r = c.get("/api/papers", headers=h)
        if r.json():
            paper = r.json()[0]
            step("上传 PDF（复用已上传）", True, f"title={paper['title']} hash={paper['file_hash'][:8]}")
        else:
            pdf = make_pdf(DATA_DIR / "dev-sample.pdf")
            r = c.post("/api/papers/upload", files={"file": ("dev.pdf", open(pdf, "rb"), "application/pdf")},
                       data={"is_scanned": "false"}, headers=h)
            paper = r.json()["paper"]
            step("上传 PDF", r.status_code == 200 and paper["page_count"] == 1,
                 f"title={paper['title']} hash={paper['file_hash'][:8]}")

        r = c.get("/api/papers", headers=h)
        step("论文列表", len(r.json()) >= 1)

        # 翻译 SSE：无模型 → ECDICT 层兜底 + error(llm_loading_timeout)
        events = []
        with c.stream("POST", "/api/translate/word",
                      json={"paper_id": paper["id"], "word": "attention", "sentence": "the attention is high"},
                      headers=h) as resp:
            text = "".join(resp.iter_text())
        cur = {}
        for line in text.splitlines():
            if line.startswith("event: "):
                cur["event"] = line[7:]
            elif line.startswith("data: "):
                cur["data"] = json.loads(line[6:])
                events.append(cur)
                cur = {}
        kinds = [e["event"] for e in events]
        ecdict_hit = any(e["event"] == "hit" and e["data"].get("layer") == "ecdict" for e in events)
        has_error = any(e["event"] == "error" and e["data"]["code"] == "llm_loading_timeout" for e in events)
        step("翻译 SSE（ECDICT 兜底）", ecdict_hit and has_error, f"events={kinds}")

        # OCR 入队（若 worker 已运行会立即认领，状态可能推进到 running/done）
        r = c.post(f"/api/papers/{paper['id']}/ocr", headers=h)
        r2 = c.get(f"/api/papers/{paper['id']}/ocr-status", headers=h)
        ocr_dir = DATA_DIR / "ocr" / str(paper["id"])
        protocol_files = any((ocr_dir / f).exists() for f in
                             ("task.json", "task.claimed.json", "result.json", "blocks.ndjson"))
        step("OCR 入队", r.status_code == 202 and r2.json()["status"] in ("pending", "running", "done")
             and (protocol_files or r2.json()["status"] == "done"),
             f"status={r2.json()['status']}")

        r = c.get("/api/stats/overview", headers=h)
        body = r.json()
        step("统计总览", r.status_code == 200 and len(body["calendar"]) == 30, f"total_s={body['total_s']}")

        r = c.get("/api/llm/status", headers=h)
        step("LLM 状态", r.json()["state"] == "unloaded")

    failed = [x for x in RESULTS if not x[1]]
    print(f"\n=== {len(RESULTS) - len(failed)}/{len(RESULTS)} 步通过 ===")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
