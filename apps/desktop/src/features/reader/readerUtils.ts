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

// ── 断句 ──────────────────────────────────────────────────
const SENT_BOUNDARY = /[^.?!]*[.?!]+["')\]]?\s*/g
/** 常见缩写：句号不当作断点（占位符保护，切完还原） */
const ABBREV_RE = /\b(?:e\.g|i\.e|et al|Fig|Eq|Sec|Tab|Ref|etc|vs|No|Mr|Mrs|Dr|St|Prof|cf|pp|vol)\./gi
const MAX_SENTENCE_CHARS = 400

function chunkLong(s: string): string[] {
  if (s.length <= MAX_SENTENCE_CHARS) return [s]
  const words = s.split(/\s+/)
  const chunks: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && cur.length + w.length + 1 > MAX_SENTENCE_CHARS) {
      chunks.push(cur)
      cur = w
    } else {
      cur = cur ? `${cur} ${w}` : w
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

function splitSentences(text: string): string[] {
  const guarded = text.replace(ABBREV_RE, (m) => m.replace(/\./g, '\uE000'))
  const out: string[] = []
  SENT_BOUNDARY.lastIndex = 0
  let m: RegExpExecArray | null
  let consumed = 0 // 最后成功匹配的末尾（exec 失败会把 lastIndex 重置为 0）
  while ((m = SENT_BOUNDARY.exec(guarded)) !== null) {
    const s = m[0].trim()
    if (s) out.push(...chunkLong(s))
    consumed = m.index + m[0].length
  }
  const rest = guarded.slice(consumed).trim()
  if (rest) out.push(...chunkLong(rest))
  return out.map((s) => s.replace(/\uE000/g, '.'))
}

/** 从全文提取选区所在句 + 前后各 1 句（词/句翻译上下文注入用） */
export function extractSentenceContext(fullText: string, selText: string): {
  sentence: string
  prev: string
  next: string
} {
  const needle = selText.replace(/\s+/g, ' ').trim()
  if (!needle) return { sentence: selText, prev: '', next: '' }
  const flat = fullText.replace(/\s+/g, ' ')
  const idx = flat.indexOf(needle)
  if (idx < 0) return { sentence: selText, prev: '', next: '' }
  const before = flat.slice(0, idx)
  const after = flat.slice(idx + needle.length)
  const prevSentences = splitSentences(before)
  const nextSentences = splitSentences(after)
  const startFrag = prevSentences.length ? prevSentences[prevSentences.length - 1] : ''
  const endFrag = nextSentences.length ? nextSentences[0] : ''
  const sentence = `${startFrag} ${needle} ${endFrag}`.replace(/\s+/g, ' ').trim()
  const prev = prevSentences.length > 1 ? prevSentences[prevSentences.length - 2] : ''
  const next = nextSentences.length > 1 ? nextSentences[1] : ''
  return { sentence, prev, next }
}

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