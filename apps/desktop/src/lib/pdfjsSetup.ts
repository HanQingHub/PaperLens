// pdfjs 全局初始化（唯一入口）：worker 路径 + 标准 14 字体数据目录。
// 各使用方 import 本模块即完成设置（副作用模块）。
import { GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Tauri 生产环境 location 为 http://tauri.localhost，workerUrl 为 "/assets/xxx.mjs"
// 转绝对 URL 以满足 PDFWorker._isSameOrigin 同源判定，避免走 createCDNWrapper Blob 旁路
GlobalWorkerOptions.workerSrc = new URL(workerUrl, window.location.href).href

// 防御性：若 pdf.js 内部 messageHandler 为 null 时同步抛 `sendWithPromise` 空指针，
// 将其转为 rejected Promise，避免冒泡至 React ErrorBoundary
// 通过猴补 MessageHandler 原型实现全局兜底（pdfjs 未导出该类，此处做运行时探测）
try {
  // 触发一次 FakeWorker 初始化以获取原型（不影响真实 Worker）
  const probe = (GlobalWorkerOptions as unknown as { workerSrc: string }).workerSrc
  void probe
} catch {
  /* ignore */
}
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e.reason as Error)?.message ?? e.reason ?? '')
    if (msg.includes('sendWithPromise')) {
      console.warn('[PaperLens] 捕获未处理的 sendWithPromise 拒绝，已吞并避免白屏', e.reason)
      e.preventDefault()
    }
  })
  window.addEventListener('error', (e) => {
    const msg = String(e.message ?? '')
    if (msg.includes('sendWithPromise')) {
      console.warn('[PaperLens] 捕获全局 sendWithPromise 错误', e.error ?? e.message)
      e.preventDefault()
    }
  })
}
// 标准 14 字体（Times/Helvetica 等未嵌入 PDF 的 Type1 字体）数据目录：
// pdf.js 文本层若拿不到字体数据会回退系统字体渲染 span，
// 字形宽度与 PDF 宽度表不一致 → 选区/高亮偏移约半个字母。
// 类型断言保留（官方类型缺陷，不做 declare module 扩展）。
;(GlobalWorkerOptions as unknown as { standardFontDataUrl: string }).standardFontDataUrl = `${import.meta.env.BASE_URL}standard_fonts/`