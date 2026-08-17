"""纯手写 PDF 字节流生成带真实文本层的多页 PDF（Helvetica + Tj + xref）。

CLI：
  python scripts/make_text_pdf.py --out .dev-data/samples/demo-text.pdf --pages 5
"""
import argparse
import sys
import textwrap
from pathlib import Path

PAGE_W, PAGE_H = 595, 842
MARGIN_X, TOP_Y, LINE_SPACING = 50, 720, 14
WRAP_WIDTH = 75
LINES_PER_PAGE = 47

ESSAY = [
    "The attention mechanism has become a cornerstone of modern deep learning research. "
    "Unlike earlier recurrent architectures that compress a sequence into a fixed-size hidden state, "
    "attention allows a neural network to dynamically weigh the relevance of every input token when "
    "producing each element of the output. This simple yet powerful idea was first popularized in "
    "neural machine translation systems, where alignment between source and target words had "
    "previously required handcrafted components.",
    "In the transformer architecture, self-attention computes a weighted sum of value vectors, where "
    "the weights are derived from query-key compatibility scores. Because every position attends to "
    "every other position, the computational cost grows quadratically with sequence length, which has "
    "motivated a large body of work on sparse and linear attention variants. Researchers have proposed "
    "local windowed attention, low-rank factorizations, and kernel-based approximations to reduce this "
    "overhead while preserving model quality.",
    "Training deep attention networks reliably requires careful handling of gradient flow. Residual "
    "connections and layer normalization stabilize optimization, while warmup schedules prevent the "
    "gradient from exploding during early training steps. When the gradient signal is weak or noisy, "
    "the attention weights may collapse onto a single position, a failure mode that several analyses "
    "have documented in both vision and language transformers.",
    "Multi-head attention extends the basic mechanism by projecting queries, keys, and values into "
    "several subspaces in parallel. Each head can specialize: syntactic heads track agreement patterns, "
    "positional heads follow adjacent tokens, and rare-word heads link entities across long distances. "
    "Pruning studies show that many heads are redundant, and aggressive head pruning often leaves "
    "performance nearly unchanged while substantially reducing inference cost.",
    "In vision, the vision transformer patches an image into small regions and treats each patch as a "
    "token. Combined with large-scale pretraining, such models rival convolutional networks on "
    "classification and detection benchmarks. Cross-attention further enables multimodal fusion, "
    "aligning image regions with words in captioning models and grounding phrases in visual question "
    "answering tasks.",
    "The success of pretrained language models such as BERT and GPT rests on masked or causal attention "
    "over massive text corpora. Fine-tuning transfers the general representations to downstream tasks "
    "with only small annotated datasets. Prompt-based methods push this further by reframing "
    "classification as text generation, exploiting the flexibility of the decoder-only transformer.",
    "Efficiency research continues to flourish. FlashAttention reorders the computation to reduce "
    "memory traffic, quantization shrinks weight matrices to eight-bit integers, and speculative "
    "decoding drafts multiple tokens in parallel before verification. Together these techniques make "
    "it feasible to deploy large transformer models on consumer hardware, including fully offline "
    "desktop applications that never transmit user data to the cloud.",
    "Interpretability remains an open challenge. Although attention maps are intuitive, several studies "
    "caution that they are explanations only under restricted assumptions. Alternative probes measure "
    "information flow by perturbing activations and observing the effect on predictions, yielding more "
    "rigorous accounts of what a network has learned.",
    "Looking forward, attention is likely to remain central to architectures that unify text, images, "
    "audio, and structured knowledge. As hardware evolves and training recipes mature, the boundary "
    "between attention and other differentiable memory mechanisms may blur, but the principle of "
    "content-based addressing will continue to guide the design of intelligent systems.",
]


def _escape(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _page_content(text: str, page_no: int, total: int) -> str:
    ops = ["BT", "/F1 11 Tf", f"{MARGIN_X} {TOP_Y} Td", f"{LINE_SPACING} TL"]
    for j, line in enumerate(text.split("\n")):
        if j > 0:
            ops.append("T*")
        if line:
            ops.append(f"({_escape(line)}) Tj")
    ops.append("ET")
    footer = f"Page {page_no} of {total}"
    fx = (PAGE_W - len(footer) * 4.5) / 2
    ops += ["BT", "/F1 9 Tf", f"{fx:.1f} 40 Td", f"({_escape(footer)}) Tj", "ET"]
    return "\n".join(ops)


def build_text_pdf(pages: list, title: str = "PaperLens Demo Document") -> bytes:
    n = len(pages)
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}

    def add_obj(num: int, body: bytes):
        offsets[num] = len(out)
        out.extend(f"{num} 0 obj\n".encode() + body + b"\nendobj\n")

    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n))
    add_obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add_obj(2, f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    add_obj(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, text in enumerate(pages):
        content = _page_content(text, i + 1, n).encode("latin-1")
        add_obj(
            4 + 2 * i,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>".encode(),
        )
        add_obj(
            5 + 2 * i,
            b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        )
    info_num = 4 + 2 * n
    add_obj(info_num, f"<< /Title ({_escape(title)}) /Producer (make_text_pdf) >>".encode())

    xref_pos = len(out)
    out.extend(f"xref\n0 {info_num + 1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for num in range(1, info_num + 1):
        out.extend(f"{offsets[num]:010d} 00000 n \n".encode())
    out.extend(
        f"trailer\n<< /Size {info_num + 1} /Root 1 0 R /Info {info_num} 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF".encode()
    )
    return bytes(out)


def build_pages(n_pages: int) -> list:
    all_lines = []
    for p in ESSAY:
        all_lines.extend(textwrap.wrap(p, width=WRAP_WIDTH))
        all_lines.append("")
    pages, idx = [], 0
    for _ in range(n_pages):
        page_lines = []
        while len(page_lines) < LINES_PER_PAGE:
            page_lines.append(all_lines[idx % len(all_lines)])
            idx += 1
        pages.append("\n".join(page_lines))
    return pages


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="生成带文本层的演示 PDF")
    ap.add_argument("--out", default=".dev-data/samples/demo-text.pdf")
    ap.add_argument("--pages", type=int, default=5)
    args = ap.parse_args()
    out = Path(args.out) if Path(args.out).is_absolute() else repo / args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    pages = build_pages(args.pages)
    out.write_bytes(build_text_pdf(pages))
    print(f"已生成 {out}（{args.pages} 页, {out.stat().st_size / 1024:.1f} KB）")

    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(out))
    ok = True
    for i in range(len(pdf)):
        nchars = len(pdf[i].get_textpage().get_text_bounded())
        print(f"  page {i}: {nchars} 字符")
        ok = ok and nchars > 500
    pdf.close()
    print("验证" + ("通过（每页 >500 字符）" if ok else "未通过"))


if __name__ == "__main__":
    main()
