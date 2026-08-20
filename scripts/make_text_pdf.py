"""生成带真实文本层的多页测试 PDF（中英文混排，reportlab）。

CLI：
  python scripts/make_text_pdf.py --out .dev-data/samples/demo-text.pdf --pages 3

字体：优先微软雅黑（C:/Windows/Fonts/msyh.ttc），缺失时回退 Helvetica（纯英文）。
"""
import argparse
import sys
import textwrap
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

EN_PARA = [
    "The attention mechanism has become a cornerstone of modern deep learning research. "
    "Unlike earlier recurrent architectures that compress a sequence into a fixed-size "
    "hidden state, attention allows a network to dynamically weigh the relevance of every "
    "input token when producing each element of the output.",
    "In the transformer architecture, self-attention computes a weighted sum of value "
    "vectors, where the weights are derived from query-key compatibility scores. Because "
    "every position attends to every other position, the computational cost grows "
    "quadratically with sequence length.",
    "Training deep attention networks reliably requires careful handling of gradient flow. "
    "Residual connections and layer normalization stabilize optimization, while warmup "
    "schedules prevent the gradient from exploding during early training steps.",
]

ZH_PARA = [
    "注意力机制已成为现代深度学习研究的基石。与早期将序列压缩为固定长度隐状态的循环架构"
    "不同，注意力机制允许神经网络在生成输出的每一个元素时，动态权衡每个输入词元的相关性。",
    "在 Transformer 架构中，自注意力计算值向量的加权和，权重由查询与键的兼容性得分推导。"
    "由于每个位置都要关注其他所有位置，计算成本随序列长度呈平方增长，这也催生了大量关于"
    "稀疏注意力与线性注意力的研究工作。",
    "可靠地训练深层注意力网络需要谨慎处理梯度流动。残差连接与层归一化稳定了优化过程，"
    "而热身调度则防止梯度在训练早期阶段爆炸。当梯度信号微弱或嘈杂时，注意力权重可能坍缩"
    "到单一位置，这是一种在多篇分析中均有记载的失效模式。",
]


def _font_setup():
    candidates = [
        (r"C:\Windows\Fonts\msyh.ttc", "MicrosoftYaHei", {}),
        (r"C:\Windows\Fonts\msyhbd.ttc", "MicrosoftYaHeiBold", {}),
        (r"C:\Windows\Fonts\simsun.ttc", "SimSun", {}),
        (r"C:\Windows\Fonts\simhei.ttf", "SimHei", {}),
    ]
    for path, name, opts in candidates:
        if Path(path).exists():
            try:
                pdfmetrics.registerFont(TTFont(name, path, subfontIndex=0, **opts))
                return name
            except Exception:
                continue
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        return "STSong-Light"
    except Exception:
        return "Helvetica"


def build_text_pdf(out: Path, n_pages: int, title: str = "PaperLens Demo Document"):
    font = _font_setup()
    c = canvas.Canvas(str(out), pagesize=A4)
    c.setTitle(title)
    c.setFont(font, 11)
    width, height = A4
    margin = 50
    leading = 16
    zh_paras = [p for p in ZH_PARA for _ in range(2)]
    for page in range(n_pages):
        y = height - margin
        c.setFont(font, 11)
        for para in [EN_PARA[page % len(EN_PARA)], zh_paras[page % len(zh_paras)]]:
            if y < margin + 80:
                c.showPage()
                c.setFont(font, 11)
                y = height - margin
            text = c.beginText(margin, y)
            text.setFont(font, 11)
            text.setLeading(leading)
            text.textLines(textwrap.wrap(para, width=45))
            c.drawText(text)
            y = text.getY() - leading
        c.setFont(font, 9)
        c.drawCentredString(width / 2, 40, f"Page {page + 1} of {n_pages}")
        c.showPage()
    c.save()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="生成带文本层的演示 PDF（中英文混排）")
    ap.add_argument("--out", default=".dev-data/samples/demo-text.pdf")
    ap.add_argument("--pages", type=int, default=3)
    args = ap.parse_args()
    out = Path(args.out) if Path(args.out).is_absolute() else repo / args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    build_text_pdf(out, args.pages)
    print(f"已生成 {out}（{args.pages} 页, {out.stat().st_size / 1024:.1f} KB）")

    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(out))
    ok = True
    for i in range(len(pdf)):
        text = pdf[i].get_textpage().get_text_bounded()
        nchars = len(text)
        has_zh = any("\u4e00" <= ch <= "\u9fff" for ch in text)
        print(f"  page {i}: {nchars} 字符, 含中文={has_zh}")
        ok = ok and nchars > 200 and has_zh
    pdf.close()
    print("验证" + ("通过（每页 >200 字符且含中文）" if ok else "未通过"))


if __name__ == "__main__":
    main()