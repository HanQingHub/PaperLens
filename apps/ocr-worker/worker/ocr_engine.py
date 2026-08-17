from rapidocr import RapidOCR


class OcrEngine:
    """RapidOCR 封装（PDF 页方向恒正，use_cls=False）。
    输出 boxes 为 N×4×2 像素坐标（原点左上），已由 rapidocr 映射回原图。"""

    def __init__(self):
        self.engine = RapidOCR(params={"Global.use_cls": False})

    def __call__(self, gray_img):
        out = self.engine(gray_img)
        if out.boxes is None or out.txts is None:
            return [], [], []
        scores = [float(s) for s in out.scores] if out.scores is not None else []
        return out.boxes, list(out.txts), scores
