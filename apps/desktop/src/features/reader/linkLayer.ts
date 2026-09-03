// PDF 链接注释层（纯逻辑）：注释获取/缓存、dest 解析、命中测试。
// 交互走 stage 坐标命中判定（项目规约：不给覆盖层恢复 pointer-events），
// 本模块不触碰 DOM。
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfRect } from '../../stores/readerStore'

export type PageLink =
  | { kind: 'internal'; rects: PdfRect[]; dest: unknown }
  | { kind: 'external'; rects: PdfRect[]; url: string }

// 文档级缓存：WeakMap 随 PDFDocumentProxy 回收，PDF 内容不可变故无需失效机制
const linkCache = new WeakMap<PDFDocumentProxy, Map<number, PageLink[]>>()

type RawAnnotation = {
  subtype?: string
  rect?: number[]
  url?: string
  unsafeUrl?: string
  dest?: unknown
  quadPoints?: unknown
}

/** quadPoints 防御性展开为 PDF 空间矩形（多行链接逐行命中更准）。
 *  pdfjs 6.x 输出扁平数组（每象限 8 个数，序 [minX,maxY,maxX,maxY,minX,minY,maxX,minY]，
 *  已归一化）；形态不符/异常时返回 null 由调用方回退 annotation.rect 包围盒 */
function quadsToRects(quadPoints: unknown): PdfRect[] | null {
  try {
    const flat = Array.isArray(quadPoints)
      ? (quadPoints as number[])
      : quadPoints instanceof Float32Array
        ? Array.from(quadPoints)
        : null
    if (!flat || flat.length < 8 || flat.length % 8 !== 0) return null
    const rects: PdfRect[] = []
    for (let i = 0; i < flat.length; i += 8) {
      const quad = flat.slice(i, i + 8)
      if (quad.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
    }
    return rects.length ? rects : null
  } catch {
    return null
  }
}

/** 获取并缓存页链接注释（文本页/OCR 页通用：链接属文档注释层，与文本层无关） */
export async function getPageLinks(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageLink[]> {
  let perPage = linkCache.get(pdf)
  if (!perPage) {
    perPage = new Map()
    linkCache.set(pdf, perPage)
  }
  const hit = perPage.get(pageIndex)
  if (hit) return hit

  const page = await pdf.getPage(pageIndex + 1)
  const annotations = (await page.getAnnotations()) as RawAnnotation[]
  const links: PageLink[] = []
  for (const a of annotations) {
    if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue
    const rect: PdfRect = [a.rect[0], a.rect[1], a.rect[2], a.rect[3]]
    if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) continue
    const rects = (a.quadPoints != null && quadsToRects(a.quadPoints)) || [rect]
    const url = typeof a.url === 'string' && a.url ? a.url : null
    if (url) {
      // 仅 http/https 外链（Rust 侧 open_external 二次校验；相对路径/其他 scheme 丢弃）
      if (!/^https?:\/\//i.test(url)) continue
      links.push({ kind: 'external', rects, url })
    } else if (a.dest != null) {
      links.push({ kind: 'internal', rects, dest: a.dest })
    }
  }
  perPage.set(pageIndex, links)
  return links
}

/** XYZ/FitH 显式 dest → 页内滚动比率（纯函数，可测）：
 *  top 为目标页用户空间 y（向上），ratio = 1 - top/pageH；
 *  Fit/FitV/FitR 及未知名无有效 top → 0（页顶） */
export function explicitDestToRatio(name: string, top: number | undefined | null, pageH: number): number {
  if (!pageH || pageH <= 0) return 0
  if ((name === 'XYZ' || name === 'FitH') && typeof top === 'number' && Number.isFinite(top)) {
    return Math.max(0, Math.min(1, 1 - top / pageH))
  }
  return 0
}

/** dest（named 字符串或显式数组）→ 目标页（1-based）+ 页内滚动比率。
 *  显式数组参数下标按 PDF 32000 语法分派：[page /XYZ left top zoom] top=d[3]；
 *  [page /FitH top] top=d[2] */
export async function resolveDest(
  pdf: PDFDocumentProxy,
  dest: unknown,
): Promise<{ pageNo: number; ratio: number } | null> {
  try {
    let d = dest
    if (typeof d === 'string') d = await pdf.getDestination(d)
    if (!Array.isArray(d) || d.length < 2) return null
    const pageIdx = await pdf.getPageIndex(d[0] as { num: number; gen: number })
    const pageNo = pageIdx + 1
    const name = typeof d[1] === 'string' ? d[1] : ((d[1] as { name?: string })?.name ?? '')
    if (name === 'XYZ' || name === 'FitH') {
      const topIdx = name === 'XYZ' ? 3 : 2
      const top = typeof d[topIdx] === 'number' ? (d[topIdx] as number) : null
      const page = await pdf.getPage(pageNo)
      const pageH = page.getViewport({ scale: 1 }).height
      return { pageNo, ratio: explicitDestToRatio(name, top, pageH) }
    }
    return { pageNo, ratio: 0 }
  } catch {
    return null
  }
}

/** PDF 用户空间点命中测试（tol 为 pt 容差，纯函数，可测） */
export function pointInPdfRects(x: number, y: number, rects: PdfRect[], tol = 2): boolean {
  return rects.some((r) => x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol)
}
