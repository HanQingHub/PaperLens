// 参考文献回链（纯逻辑）：定位文本索引、[n] 标记扫描（文献条目/正文引用）、矩形换算。
// 仅支持文本型 PDF（OCR 页无定位文本，天然无标记）；编号制引用 [n]，范围/作者-年份制不在范围。
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfRect } from '../../stores/readerStore'

export interface TextItemPos {
  start: number
  end: number
  str: string
  /** transform[4]：基线 x（PDF 用户空间） */
  tx: number
  /** transform[5]：基线 y（PDF 用户空间，向上） */
  ty: number
  /** item 渲染宽（PDF 用户空间） */
  w: number
  /** item 字号高（PDF 用户空间） */
  h: number
}

export interface TextIndex {
  text: string
  items: TextItemPos[]
}

// 文档级缓存：WeakMap 随 PDFDocumentProxy 回收（内容不可变，无需失效机制）
const indexCache = new WeakMap<PDFDocumentProxy, Map<number, TextIndex>>()

/** getTextContent → 拼接文本 + item 定位（hasEOL 补 '\n'，与 ensurePageText 同拼接口径） */
export async function buildTextIndex(pdf: PDFDocumentProxy, pageIndex: number): Promise<TextIndex> {
  let perPage = indexCache.get(pdf)
  if (!perPage) {
    perPage = new Map()
    indexCache.set(pdf, perPage)
  }
  const hit = perPage.get(pageIndex)
  if (hit) return hit
  const page = await pdf.getPage(pageIndex + 1)
  const content = await page.getTextContent()
  let text = ''
  const items: TextItemPos[] = []
  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const it = raw as { str: string; hasEOL?: boolean; width: number; height: number; transform: number[] }
    const start = text.length
    text += it.str
    if (it.hasEOL) text += '\n'
    items.push({
      start,
      end: text.length,
      str: it.str,
      tx: it.transform[4],
      ty: it.transform[5],
      w: it.width,
      h: it.height,
    })
  }
  const idx = { text, items }
  perPage.set(pageIndex, idx)
  return idx
}

/** 命中子区间 [s,e) ∩ item → PDF 用户空间矩形（纯函数，可测）。
 *  y 包络以基线 ty 为锚：y0 = ty - 0.25h（降部），y1 = ty + 0.85h（升部），
 *  供闪烁提示定位，精度足够；x 按字符数线性内插。 */
export function intersectRect(item: TextItemPos, s: number, e: number): PdfRect | null {
  const a = Math.max(s, item.start)
  const b = Math.min(e, item.end)
  if (b <= a) return null
  const len = item.str.length || 1
  const x0 = item.tx + ((a - item.start) / len) * item.w
  const x1 = item.tx + ((b - item.start) / len) * item.w
  const h = item.h > 0 ? item.h : 10
  return [x0, item.ty - 0.25 * h, x1, item.ty + 0.85 * h]
}

/** 在拼接文本上执行正则，命中区间映射回矩形（跨 item 命中逐段展开）。
 *  lineStartOnly: 命中起点必须位于文本起始或 '\n' 之后（文献条目行首 [n]） */
export function findInIndex(idx: TextIndex, re: RegExp, lineStartOnly: boolean): PdfRect[] {
  const out: PdfRect[] = []
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const rx = new RegExp(re.source, flags)
  let m: RegExpExecArray | null
  while ((m = rx.exec(idx.text)) !== null) {
    if (m[0].length === 0) {
      rx.lastIndex++
      continue
    }
    if (lineStartOnly) {
      const prev = m.index > 0 ? idx.text[m.index - 1] : '\n'
      if (prev !== '\n') continue
    }
    for (const item of idx.items) {
      if (item.end <= m.index || item.start >= m.index + m[0].length) continue
      const r = intersectRect(item, m.index, m.index + m[0].length)
      if (r) out.push(r)
    }
  }
  return out
}

// ── 页级标记扫描 ────────────────────────────────────────────

export interface PageMarkers {
  /** 行首 [n] → 矩形（文献条目标签；同号多行标签合并） */
  bib: Map<number, PdfRect[]>
  /** 非行首 [n]（正文引用标记） */
  cites: { n: number; rects: PdfRect[] }[]
}

const CITE_RE = /\[(\d{1,3})\]/g

const markerCache = new WeakMap<PDFDocumentProxy, Map<number, PageMarkers>>()

export async function getPageMarkers(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageMarkers> {
  let perPage = markerCache.get(pdf)
  if (!perPage) {
    perPage = new Map()
    markerCache.set(pdf, perPage)
  }
  const hit = perPage.get(pageIndex)
  if (hit) return hit
  const idx = await buildTextIndex(pdf, pageIndex)
  const bib = new Map<number, PdfRect[]>()
  const cites: { n: number; rects: PdfRect[] }[] = []
  const rx = new RegExp(CITE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = rx.exec(idx.text)) !== null) {
    const n = parseInt(m[1], 10)
    const lineStart = m.index === 0 || idx.text[m.index - 1] === '\n'
    const rects: PdfRect[] = []
    for (const item of idx.items) {
      if (item.end <= m.index || item.start >= m.index + m[0].length) continue
      const r = intersectRect(item, m.index, m.index + m[0].length)
      if (r) rects.push(r)
    }
    if (!rects.length) continue
    if (lineStart) {
      const cur = bib.get(n) ?? []
      bib.set(n, [...cur, ...rects])
    } else {
      cites.push({ n, rects })
    }
  }
  const markers: PageMarkers = { bib, cites }
  perPage.set(pageIndex, markers)
  return markers
}

/** 文献页启发式：行首编号条目 ≥5（正文页因换行偶发行首 [n]，阈值挡住绝大多数） */
export function isBibPage(m: PageMarkers): boolean {
  return m.bib.size >= 5
}
