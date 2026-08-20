"""冻结冒烟脚本：spec 后处理调用（paperlens-ocr.exe --smoke）。

import 全部核心模块，初始化 OCR 引擎并对 64×64 空白灰度图跑一次最小推理。
退出码 0=通过，非 0=失败。
"""
import sys


def run_smoke() -> int:
    import numpy as np

    from worker import ndjson, ocr_engine, paragraph, run

    try:
        engine = ocr_engine.get_engine()
        img = np.zeros((64, 64), dtype=np.uint8)
        boxes, txts, scores = engine(img)
        rec = ndjson.build_record(1, 0, 2.8, [], page_rot=0, engine=run.engine_name())
        assert rec["format_version"] == 1
        print(f"SMOKE OK engine={run.engine_name()} boxes={len(boxes)}")
        return 0
    except Exception as e:
        print(f"SMOKE FAIL: {e!r}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run_smoke())