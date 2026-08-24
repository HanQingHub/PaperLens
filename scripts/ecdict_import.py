"""从 stardict.db 裁剪生成 ecdict.db（dictionary + lemmas 两表）。

用法（默认参数即下述）：
  python scripts/ecdict_import.py --source assets/ecdict/stardict.db \
      --lemma assets/ecdict/lemma.en.txt --out .dev-data/ecdict.db
"""
import argparse
import sqlite3
import sys
import time
from pathlib import Path

BATCH = 50000


def import_dictionary(dst: sqlite3.Connection, source_db: Path):
    dst.execute("ATTACH DATABASE ? AS src", (str(source_db),))
    dst.execute(
        """CREATE TABLE dictionary(
        word TEXT PRIMARY KEY, pos TEXT, phonetic TEXT, translation TEXT,
        collins_star INTEGER, tag TEXT, exchange TEXT)"""
    )
    cur = dst.execute(
        "SELECT word, pos, NULLIF(phonetic, ''), translation, collins, tag, exchange FROM src.stardict"
    )
    total = 0
    t0 = time.perf_counter()
    while True:
        rows = cur.fetchmany(BATCH)
        if not rows:
            break
        dst.executemany(
            "INSERT INTO dictionary(word, pos, phonetic, translation, collins_star, tag, exchange)"
            " VALUES(?,?,?,?,?,?,?)",
            rows,
        )
        dst.commit()
        total += len(rows)
        print(f"  dictionary 已导入 {total} 行, {time.perf_counter() - t0:.0f}s", flush=True)
    dst.execute("DETACH DATABASE src")
    return total


def parse_lemmas(lemma_txt: Path):
    """lemma.en.txt 每行格式：`词元/词频 -> 变形1,变形2,...`（; 开头为注释）。"""
    with open(lemma_txt, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(";"):
                continue
            if " -> " not in line:
                continue
            head, _, tail = line.partition(" -> ")
            lemma = head.split("/")[0].strip().lower()
            if not lemma:
                continue
            for v in tail.split(","):
                v = v.strip().lower()
                if v:
                    yield v, lemma


def import_lemmas(dst: sqlite3.Connection, lemma_txt: Path):
    dst.execute("CREATE TABLE lemmas(word TEXT PRIMARY KEY, lemma TEXT)")
    batch = []
    total = 0
    for word, lemma in parse_lemmas(lemma_txt):
        batch.append((word, lemma))
        if len(batch) >= BATCH:
            dst.executemany("INSERT OR IGNORE INTO lemmas(word, lemma) VALUES(?,?)", batch)
            dst.commit()
            total += len(batch)
            batch = []
    if batch:
        dst.executemany("INSERT OR IGNORE INTO lemmas(word, lemma) VALUES(?,?)", batch)
        dst.commit()
        total += len(batch)
    return total


def verify(out_path: Path):
    con = sqlite3.connect(out_path)
    n_dict = con.execute("SELECT COUNT(*) FROM dictionary").fetchone()[0]
    n_lemma = con.execute("SELECT COUNT(*) FROM lemmas").fetchone()[0]
    print(f"dictionary 行数: {n_dict}")
    print(f"lemmas 行数: {n_lemma}")
    for w in ("attention", "studies", "went"):
        row = con.execute(
            "SELECT word, pos, phonetic, translation, collins_star FROM dictionary WHERE word=?",
            (w,),
        ).fetchone()
        if row:
            trans = (row[3] or "")[:80]
            print(f"dictionary[{w}]: pos={row[1]} phonetic={row[2]} collins={row[4]} translation={trans}")
        else:
            print(f"dictionary[{w}]: 未命中")
    for w in ("attention", "studies", "went"):
        row = con.execute("SELECT word, lemma FROM lemmas WHERE word=?", (w,)).fetchone()
        print(f"lemmas[{w}]: {row}")
    con.close()
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"文件大小: {size_mb:.1f} MB")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="stardict.db 裁剪导入 ecdict.db")
    ap.add_argument("--source", default="assets/ecdict/stardict.db")
    ap.add_argument("--lemma", default="assets/ecdict/lemma.en.txt")
    ap.add_argument("--out", default=".dev-data/ecdict.db")
    args = ap.parse_args()

    source = (repo / args.source).resolve() if not Path(args.source).is_absolute() else Path(args.source)
    lemma = (repo / args.lemma).resolve() if not Path(args.lemma).is_absolute() else Path(args.lemma)
    out = (repo / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    print(f"开始导入: {source} + {lemma} -> {out}")
    dst = sqlite3.connect(out)
    dst.execute("PRAGMA journal_mode=OFF")
    dst.execute("PRAGMA synchronous=OFF")
    t0 = time.perf_counter()
    import_dictionary(dst, source)
    print(f"dictionary 导入完成, {time.perf_counter() - t0:.0f}s")
    t1 = time.perf_counter()
    n = import_lemmas(dst, lemma)
    print(f"lemmas 导入完成: {n} 对, {time.perf_counter() - t1:.0f}s")
    dst.close()

    verify(out)
    print("导入与验证完成")


if __name__ == "__main__":
    main()
