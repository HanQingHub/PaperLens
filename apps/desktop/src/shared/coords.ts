// 坐标工具：PDF 用户空间（pt，原点左下）↔ 页内 CSS/视口 映射。
// reader 与 annotations 共用（上提共享层防止两模块循环依赖）。
// 渲染映射假设页面 rotation=0（学术论文常态），公式与 pdfjs PageViewport 一致。

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

/** 跨页选区过滤：只保留垂直中点落在页盒内的矩形（其余属于相邻页，
 * 用基准页原点换算会得到错位坐标）。 */
export function clientRectsInPage(
  clientRects: ArrayLike<DOMRect>,
  pageBox: { top: number; bottom: number },
): DOMRect[] {
  const out: DOMRect[] = []
  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i]
    const cy = (r.top + r.bottom) / 2
    if (cy >= pageBox.top && cy <= pageBox.bottom) out.push(r)
  }
  return out
}

/**
 * 选区矩形按行合并：同一行内的多个碎片矩形（逐词高亮 <i> 边界、
 * 行内分段）合并为单行矩形，消除行内竖缝与重叠暗条。
 * 先做包含去重：textLayer（absolute span）上 Range.getClientRects()
 * 会对同一文本产出双层矩形——文本字体盒 + span 行盒（同位置、行盒
 * 被字体盒包含），不去重则落库渲染为高低两层重叠块。行盒被完全
 * 包含时丢弃行盒，保留字体盒口径（与词高亮 inline 背景同高）。
 * 同行判定容差以 pt 为基准按当前缩放归一化（yTolPt×scale），
 * 下界 1px——低倍缩放下亚像素抖动不至于漏合并。
 */
export function mergeClientRects(rects: DOMRect[], yTolPt = 1.0, scale = 1): DOMRect[] {
  const yTol = Math.max(yTolPt * scale, 1.0)
  let valid = rects.filter((r) => r.width >= 1 && r.height >= 1)
  if (!valid.length) return []
  // 包含去重：A ⊇ B 时丢弃 B；值相等的 rect 恰保留先者
  //（后项 (j<i || !contains(b,a)) 保证互含/相等对不双丢）
  valid = valid.filter(
    (b, i) => !valid.some(
      (a, j) => j !== i &&
        a.left <= b.left + 0.5 && a.right >= b.right - 0.5 &&
        a.top <= b.top + 0.5 && a.bottom >= b.bottom - 0.5 &&
        (j < i ||
          !(b.left <= a.left + 0.5 && b.right >= a.right - 0.5 &&
            b.top <= a.top + 0.5 && b.bottom >= a.bottom - 0.5)),
    ),
  )
  if (!valid.length) return []
  valid.sort((a, b) => a.top - b.top || a.left - b.left)
  const rows: DOMRect[] = []
  for (const r of valid) {
    const cur = rows[rows.length - 1]
    // 同行判定：垂直中心距 < yTol（墨盒高度随字形含升/降部而变，高度本身不可作为同行判据）
    const curCy = cur ? (cur.top + cur.bottom) / 2 : 0
    const rCy = (r.top + r.bottom) / 2
    if (cur && Math.abs(rCy - curCy) < yTol) {
      const left = Math.min(cur.left, r.left)
      const right = Math.max(cur.right, r.right)
      const top = Math.min(cur.top, r.top)
      const bottom = Math.max(cur.bottom, r.bottom)
      rows[rows.length - 1] = {
        left, top, right, bottom,
        width: right - left, height: bottom - top,
      } as DOMRect
    } else {
      rows.push(r)
    }
  }
  return rows
}

/** PDF 用户空间同款按行合并（渲染前防御：历史数据中的重叠/碎片 rect）。
 * 容差单位 pt，与缩放无关。含同款包含去重。 */
export function mergePdfRects(
  rects: [number, number, number, number][],
  yTolPt = 1.0,
): [number, number, number, number][] {
  let valid = rects.filter((r) => r[2] - r[0] >= 0.01 && r[3] - r[1] >= 0.01)
  if (!valid.length) return []
  valid = valid.filter(
    (b, i) => !valid.some(
      (a, j) => j !== i &&
        a[0] <= b[0] + 0.01 && a[2] >= b[2] - 0.01 &&
        a[1] <= b[1] + 0.01 && a[3] >= b[3] - 0.01 &&
        (j < i ||
          !(b[0] <= a[0] + 0.01 && b[2] >= a[2] - 0.01 &&
            b[1] <= a[1] + 0.01 && b[3] >= a[3] - 0.01)),
    ),
  )
  if (!valid.length) return []
  valid.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const rows: [number, number, number, number][] = []
  for (const r of valid) {
    const cur = rows[rows.length - 1]
    const rCy = (r[1] + r[3]) / 2
    const curCy = cur ? (cur[1] + cur[3]) / 2 : 0
    if (cur && Math.abs(rCy - curCy) < yTolPt) {
      rows[rows.length - 1] = [
        Math.min(cur[0], r[0]),
        Math.min(cur[1], r[1]),
        Math.max(cur[2], r[2]),
        Math.max(cur[3], r[3]),
      ]
    } else {
      rows.push(r)
    }
  }
  return rows
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

/** 贝塞尔连线 path：M 锚点 C 控制点1 控制点2 卡片边缘（控制点取中垂线偏移） */
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