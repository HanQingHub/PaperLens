# 生成 Markdown 文件样式图标（Markdown 蓝徽章底 + 白色 MD 字样，多层 ico）
# 用途：PaperLens.md ProgID 的 DefaultIcon（关联后 .md 文件显示 PaperLens md 徽章）
# 运行：.venv\Scripts\python.exe scripts\gen_md_icon.py
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "apps/desktop/src-tauri/resources/icons/md-file.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]
BASE = 256

BLUE = (81, 154, 186)      # Markdown 蓝
WHITE = (245, 245, 245)


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 文档主体（圆角矩形，四周留边）
    margin = 24
    d.rounded_rectangle((margin, margin, BASE - margin, BASE - margin), radius=36, fill=(*BLUE, 255))
    # "MD" 字样（字号随基图绘制，再整体缩放）
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 108)
    except OSError:
        font = ImageFont.load_default()
    text = "MD"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((BASE - tw) / 2 - bbox[0], (BASE - th) / 2 - bbox[1] - 6), text, font=font, fill=(*WHITE, 255))
    # 底部细白条（层次感，克制）
    d.rounded_rectangle((margin + 44, BASE - margin - 62, BASE - margin - 44, BASE - margin - 50),
                        radius=6, fill=(*WHITE, 90))
    if size == BASE:
        return img
    return img.resize((size, size), Image.LANCZOS)


imgs = [render(s) for s in SIZES]
OUT.parent.mkdir(parents=True, exist_ok=True)
imgs[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=imgs[:-1])
print(f"ICO-OK {OUT}")
