"""OCR worker 打包入口（PyInstaller onedir）。

等价于 `python -m worker.run --data-dir <目录>`；参数解析与主循环复用 worker.run.main()。
`--smoke` 用于冻结后冒烟：运行 smoke_test.run_smoke() 后退出。
"""
import sys

from worker.run import main


def _smoke_entry() -> int:
    from smoke_test import run_smoke

    return run_smoke()


if __name__ == "__main__":
    if "--smoke" in sys.argv:
        sys.exit(_smoke_entry())
    main()