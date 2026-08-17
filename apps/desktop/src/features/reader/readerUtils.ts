// 阅读器工具：页面文本提取（缓存）、句子上下文断句、PDF↔CSS 坐标映射
// 坐标约定：批注/锚点/卡片一律存 PDF 用户空间（pt，原点左下，§8.6）；
// 渲染映射假设页面 rotation=0（学术论文常态），公式与 pdfjs PageViewport 一致。
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

// ── 坐标映射（rotation=0）─────────────────────────────────
export interface PageGeom {
  baseW: number // scale=1 页宽
  baseH: number
  scale: number
}

/** 视口选区矩形 → PDF 用户空间矩形 */
export function clientRectsToPdf(
  clientRects: ArrayLike<DOMRect>,
  pageEl: HTMLElement,
  geom: PageGeom,
): [number, number, number, number][] {
  const box = pageEl.getBoundingClientRect()
  const { baseH, scale } = geom
  const round = (v: number) => Math.round(v * 100) / 100
  const rects: [number, number, number, number][] = []
  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i]
    if (r.width < 1 || r.height < 1) continue
    const x0 = (r.left - box.left) / scale
    const x1 = (r.right - box.left) / scale
    const y0 = baseH - (r.bottom - box.top) / scale
    const y1 = baseH - (r.top - box.top) / scale
    rects.push([round(x0), round(y0), round(x1), round(y1)])
  }
  return rects
}

/** PDF 用户空间矩形 → 页内 CSS 定位 */
export function pdfRectToCss(rect: [number, number, number, number], geom: PageGeom) {
  const [x0, y0, x1, y1] = rect
  const { baseH, scale } = geom
  return {
    left: x0 * scale,
    top: (baseH - y1) * scale,
    width: (x1 - x0) * scale,
    height: (y1 - y0) * scale,
  }
}

/** PDF 点 → 页内 CSS 点 */
export function pdfPointToCss(x: number, y: number, geom: PageGeom) {
  return { x: x * geom.scale, y: (geom.baseH - y) * geom.scale }
}

/** 页内 CSS 点 → PDF 点 */
export function cssPointToPdf(x: number, y: number, geom: PageGeom) {
  return { x: x / geom.scale, y: geom.baseH - y / geom.scale }
}

/** OCR block bbox（PDF 用户空间，y 向上）→ CSS 定位 */
export const bboxToCss = pdfRectToCss

// ── 杂项 ──────────────────────────────────────────────────
/** 复制附引用（FR-10）：作者 (年), p.N；作者缺失用标题前 20 字 */
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

/** 贝塞尔连线 path：M 锚点 C 控制点1 控制点2 卡片边缘（§8.6 控制点取中垂线偏移） */
export function linkPath(ax: number, ay: number, cx: number, cy: number) {
  const dx = cx - ax
  const bow = Math.min(56, Math.abs(dx) * 0.22 + 16) * (ay > cy ? 1 : -1)
  return `M ${ax} ${ay} C ${ax + dx * 0.25} ${ay + bow}, ${ax + dx * 0.75} ${cy - bow}, ${cx} ${cy}`
}

/** 卡片连线接入边（卡片朝向锚点一侧的中点） */
export function cardEdgeX(cardLeft: number, cardW: number, anchorX: number) {
  return anchorX > cardLeft + cardW / 2 ? cardLeft : cardLeft + cardW
}

/** 矩形中心点 */
export function rectCenter(rect: [number, number, number, number]) {
  return { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 }
}
