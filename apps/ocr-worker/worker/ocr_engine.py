from threading import Lock

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
        scores = (
            [float(s) for s in out.scores]
            if out.scores is not None
            else [1.0] * len(out.boxes)
        )
        return out.boxes, list(out.txts), scores


_ENGINE = None
_ENGINE_LOCK = Lock()


def get_engine():
    """进程级引擎缓存：首次调用时创建，后续复用。
    创建/换新受锁保护（worker 单线程，锁仅为线程安全兜底）。"""
    global _ENGINE
    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = OcrEngine()
        return _ENGINE


def rebuild_engine():
    """丢弃缓存引擎并重建（PAGE_RETRY 时疑似损坏的引擎须换新）。"""
    global _ENGINE
    with _ENGINE_LOCK:
        _ENGINE = OcrEngine()
        return _ENGINE