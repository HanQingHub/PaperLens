// 阅读器工具：页面文本提取（缓存）、句子上下文断句、引用/字数辅助。
// 坐标映射见 shared/coords（reader 与 annotations 共用）。
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pageTextCache } from '../../stores/readerStore'
import type { OcrPageBlocks } from '../../api/types'

/** 获取页全文（带缓存）：文本页走 getTextContent */
export async function ensurePageText(pdf: PDFDocumentProxy, pageIndex: number): Promise<string> {
  const cached = pageTextCache.get(pageIndex)
  if (cached !== undefined) return cached
  const page = await pdf.getPage(pageIndex + 1)
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  pageTextCache.set(pageIndex, text)
  return text
}

export function ocrPageText(blocks: OcrPageBlocks['blocks']): string {
  return blocks.map((b) => b.text).join('\n')
}

export { splitSentences, extractSentenceContext } from './sentence'

// ── 杂项 ──────────────────────────────────────────────────
/** 复制附引用：作者 (年), p.N；作者缺失用标题前 20 字 */
export function citationSuffix(authors: string | null, year: number | null, title: string | null, pageNo: number) {
  const who = (authors ?? '').trim()
  const y = year != null ? ` (${year})` : ''
  const head = who || (title ?? '').slice(0, 20) || 'PaperLens'
  return `—— ${head}${y}, p.${pageNo}`
}

export function wordCount(text: string) {
  const m = text.trim().match(/[A-Za-z0-9'-]+/g)
  return m ? m.length : 0
}