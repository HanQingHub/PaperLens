"""OCR worker 打包入口（PyInstaller onedir）。

等价于 `python -m worker.run --data-dir <目录>`；参数解析与主循环复用 worker.run.main()。
"""
from worker.run import main

if __name__ == "__main__":
    main()
