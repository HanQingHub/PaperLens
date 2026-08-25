# PaperLens

面向科研人员的学术 PDF 阅读器：划词翻译、生词复习、批注笔记三位一体，完全离线运行，数据只保存在本机。

## 功能

- **划词翻译**：内置 ECDICT 词典（约 340 万词条）毫秒级出卡；内嵌本地 LLM（Qwen3.5，llama.cpp 内核）结合上下文给出语境译法，支持句译、翻译缓存
- **生词库**：划词一键收藏，正文自动高亮，SM-2 间隔重复复习，支持导出 CSV / Anki
- **批注**：连线批注、五色高亮、页边卡片，可写回 PDF 副本，支持导出 Markdown
- **术语表**：每篇论文自动抽取高频学术词并预译（TF-IDF），修正译法后全文生效
- **扫描版 OCR**：RapidOCR 纯 CPU 解析，扫描 PDF 也能选中、翻译、高亮
- **阅读统计**：累计时长、打开次数、30 天热力图、复习完成率
- **多账号**：本地注册登录，账号间数据完全隔离
- **完全离线**：不依赖任何云服务，断网可用，数据不出本机
<img width="2876" height="1794" alt="image" src="https://github.com/user-attachments/assets/c88a9e9d-ffc7-48f8-b5d3-252cc52b0842" />
<img width="2879" height="1772" alt="image" src="https://github.com/user-attachments/assets/2b3adef4-73be-4d37-9cef-b0cc3266fa77" />
<img width="2878" height="1798" alt="image" src="https://github.com/user-attachments/assets/30c8cb98-c07d-4002-96e8-7dfa47d1e545" />
<img width="2879" height="1799" alt="image" src="https://github.com/user-attachments/assets/4a1669aa-a09b-4fc1-b890-b366b669218c" />
<img width="2879" height="1799" alt="image" src="https://github.com/user-attachments/assets/067d5917-1157-40ce-b4ac-7af1666e367b" />
<img width="2879" height="1799" alt="image" src="https://github.com/user-attachments/assets/c888d005-5905-4a64-aa80-765f6e7fb9bd" />

## 系统要求

- Windows 10/11（x64，CPU 需支持 AVX2，2013 年后的处理器均可）
- 内存：日常使用约 400MB；加载 LLM 模型时约 2GB
- 首次启动需安装 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）

## 安装

从 [Releases](https://github.com/HanQingHub/PaperLens/releases) 下载 `PaperLens_<版本>_x64-setup.exe`。默认安装到 D 盘（D 盘不存在时安装到 `%LOCALAPPDATA%`）。

模型分发说明：

- 主安装包内置 0.8B 模型（Q4_K_M，约 508MB），开箱即用，适合日常阅读
- 2B 模型（约 1.2GB）单独打包为 `PaperLens_Qwen3.5-2B-Q4_K_M_installer.exe`，翻译质量更好；安装后自动解压到数据目录，重启应用即可在设置页切换

首次启动向导引导下载或导入 GGUF 模型，可跳过，稍后在设置页（LLM 模型管理）再操作。

## 从源码构建

前置环境：Node.js 20+、Rust（≥1.77.2）、Python 3.11+、Tauri CLI。

```bash
# 后端：创建虚拟环境并安装依赖
# （依赖直接装入 .venv，含 FastAPI / uvicorn / SQLAlchemy / Alembic /
#   llama-cpp-python / RapidOCR / pypdf / pypdfium2 等）
python -m venv .venv
.venv/Scripts/pip install <各依赖包>

# 前端
cd apps/desktop
npm install

# 开发模式（后端 + 前端热更新）
python scripts/dev.py --frontend
# 浏览器打开 http://localhost:5173

# 打包
cd apps/desktop
npx tauri build
```

打包说明：

- 后端 sidecar 用 PyInstaller 打包（`scripts/package_server_onefile.spec`），OCR worker 用 `scripts/package_ocr_worker.spec`，产物放到 `apps/desktop/src-tauri/binaries/` 与 `ocr-dist/`
- `scripts/ecdict_import.py` 从 stardict.db 裁剪生成随包分发的 `ecdict.db`
- 2B 模型安装包由 `scripts/model_installer.nsi` 制作（NSIS）

## 目录结构

```
apps/desktop/       Tauri v2 桌面应用（React 前端 + Rust 薄壳）
apps/server/        FastAPI sidecar（业务逻辑、翻译链路、数据库）
apps/ocr-worker/    OCR 独立 worker（RapidOCR）
scripts/            开发 / 打包脚本
assets/             词典、模型等大资产（构建期处理，不入库）
docs/               设计与需求文档
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · TypeScript · Vite · Zustand · pdf.js |
| 桌面壳 | Tauri v2（Rust） |
| 后端 | Python 3.11 · FastAPI · SQLAlchemy 2 · SQLite (WAL) |
| 翻译 | ECDICT 词典 + llama-cpp-python（Qwen3.5 GGUF） |
| OCR | RapidOCR（ONNX Runtime CPU） |

## 许可证

[MIT](LICENSE) © 2026 筝青寒
