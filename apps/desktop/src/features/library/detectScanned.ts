// 上传前用 pdfjs 预判扫描版：均匀抽样 3 页（N/4、N/2、3N/4）文本量，平均 <100 字符/页 → is_scanned
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export async function detectScanned(file: File): Promise<boolean> {
  const buf = await file.arrayBuffer()
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf) })
  const doc = await loadingTask.promise
  try {
    const n = doc.numPages
    if (n === 0) return false
    const pages = [...new Set([n >> 2, n >> 1, (3 * n) >> 2].map((p) => Math.min(Math.max(1, p), n)))]
    let total = 0
    for (const pageNo of pages) {
      const page = await doc.getPage(pageNo)
      try {
        const tc = await page.getTextContent()
        for (const item of tc.items) {
          if ('str' in item) total += item.str.trim().length
        }
      } finally {
        page.cleanup()
      }
    }
    return total / pages.length < 100
  } finally {
    await loadingTask.destroy() // 防内存泄漏：销毁 worker 与文档
  }
}
