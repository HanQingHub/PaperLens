// 画笔纯函数：落库有效性判定 + 笔触 path 构建（组件与测试共用，无副作用依赖）。
import type { InkStroke } from '../../stores/readerStore'

/** 自由笔触相邻采样点最小间距（page 单位）：抑制微抖、限制点数 */
export const MIN_POINT_DIST = 1.2
/** 图形最小尺寸（page 单位）：小于此值视为误触丢弃 */
export const MIN_SHAPE_SIZE = 3

/** 落库有效性：freehand ≥1 点（单击成点：渲染层 smoothPathD 单点分支 + 圆帽成点，
 *  橡皮擦 hitTest 单点分支命中）；line/arrow 按欧氏长度（水平/垂直线合法）；
 *  rect/ellipse 恰 2 点且双边 ≥ MIN_SHAPE_SIZE（零位移单击/压扁误触丢弃）；
 *  eraser 为纯前端擦除态，永不落库 */
export function isCommittableStroke(stroke: Pick<InkStroke, 'tool' | 'points'>): boolean {
  const { tool, points } = stroke
  if (tool === 'eraser') return false
  if (tool === 'pen' || tool === 'highlighter') return points.length >= 1
  if (points.length !== 2) return false
  const [a, b] = points
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  if (tool === 'line' || tool === 'arrow') return Math.hypot(dx, dy) >= MIN_SHAPE_SIZE
  return dx >= MIN_SHAPE_SIZE && dy >= MIN_SHAPE_SIZE
}

/** 中点二次贝塞尔平滑：M p0 → Q pᵢ midᵢ → L pₙ（希沃/Edge 式圆滑笔触）；k=坐标倍率 */
export function smoothPathD(points: [number, number][], k: number): string {
  const s = points.map(([x, y]) => [x * k, y * k] as [number, number])
  if (s.length === 1) return `M ${s[0][0]} ${s[0][1]} l 0.01 0`
  let d = `M ${s[0][0]} ${s[0][1]}`
  for (let i = 1; i < s.length - 1; i++) {
    const mx = (s[i][0] + s[i + 1][0]) / 2
    const my = (s[i][1] + s[i + 1][1]) / 2
    d += ` Q ${s[i][0]} ${s[i][1]} ${mx} ${my}`
  }
  const last = s[s.length - 1]
  return `${d} L ${last[0]} ${last[1]}`
}

/** 箭头终点回撤双翼：沿线身方向 ±25°，长度随线宽放大 */
export function arrowHeadD(a: [number, number], b: [number, number], width: number, k: number): string {
  const [ax, ay] = [a[0] * k, a[1] * k]
  const [bx, by] = [b[0] * k, b[1] * k]
  const ang = Math.atan2(by - ay, bx - ax)
  const len = Math.max(10, width * 4) * k
  const wing = (sign: number) => {
    const w = ang + Math.PI + sign * (Math.PI / 7)
    return `M ${bx} ${by} L ${bx + Math.cos(w) * len} ${by + Math.sin(w) * len}`
  }
  return `${wing(1)} ${wing(-1)}`
}

/** 橡皮擦半径（page 单位）：复用三档粗细，擦除手感大于笔迹线宽 */
export function eraserRadius(width: number): number {
  return 4 + width * 2
}

/** 点到线段距离（page 单位） */
export function pointSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/**
 * 橡皮擦命中判定（描边语义：擦过笔迹路径即删整笔）：
 * pen/highlighter 逐段判交；line/arrow 主线段 + 箭头尖点；rect 四边（内部不算命中）；
 * ellipse 采样 48 点折线近似判交。阈值 = 擦除半径 + 笔迹半宽。
 */
export function hitTestInkStroke(
  stroke: Pick<InkStroke, 'tool' | 'points' | 'width'>,
  p: [number, number],
  radius: number,
): boolean {
  const { tool, points, width } = stroke
  if (!points.length) return false
  const tol = radius + width / 2
  if (tool === 'pen' || tool === 'highlighter') {
    for (let i = 0; i < points.length - 1; i++) {
      if (pointSegDist(p, points[i], points[i + 1]) <= tol) return true
    }
    // 单点笔迹（单击成点，正式落库）：按点距判
    if (points.length === 1 && Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) <= tol) return true
    return false
  }
  if (points.length !== 2) return false
  const [a, b] = points
  if (tool === 'line') return pointSegDist(p, a, b) <= tol
  if (tool === 'arrow') {
    if (pointSegDist(p, a, b) <= tol) return true
    return Math.hypot(p[0] - b[0], p[1] - b[1]) <= tol + Math.max(10, width * 4)
  }
  if (tool === 'rect') {
    const corners: [number, number][] = [
      [a[0], a[1]],
      [b[0], a[1]],
      [b[0], b[1]],
      [a[0], b[1]],
    ]
    for (let i = 0; i < 4; i++) {
      if (pointSegDist(p, corners[i], corners[(i + 1) % 4]) <= tol) return true
    }
    return false
  }
  if (tool === 'ellipse') {
    const cx = (a[0] + b[0]) / 2
    const cy = (a[1] + b[1]) / 2
    const rx = Math.abs(b[0] - a[0]) / 2
    const ry = Math.abs(b[1] - a[1]) / 2
    if (rx <= 0 || ry <= 0) return false
    const N = 48
    let prev: [number, number] = [cx + rx, cy]
    for (let i = 1; i <= N; i++) {
      const t = (i / N) * Math.PI * 2
      const cur: [number, number] = [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]
      if (pointSegDist(p, prev, cur) <= tol) return true
      prev = cur
    }
    return false
  }
  return false
}
