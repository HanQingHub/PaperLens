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