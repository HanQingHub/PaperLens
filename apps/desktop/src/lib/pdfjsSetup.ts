// pdfjs 全局初始化（唯一入口）：worker 路径 + 标准 14 字体数据目录。
// 各使用方 import 本模块即完成设置（副作用模块）。
import { GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl
// 标准 14 字体（Times/Helvetica 等未嵌入 PDF 的 Type1 字体）数据目录：
// pdf.js 文本层若拿不到字体数据会回退系统字体渲染 span，
// 字形宽度与 PDF 宽度表不一致 → 选区/高亮偏移约半个字母。
// 类型断言保留（官方类型缺陷，不做 declare module 扩展）。
;(GlobalWorkerOptions as unknown as { standardFontDataUrl: string }).standardFontDataUrl = `${import.meta.env.BASE_URL}standard_fonts/`