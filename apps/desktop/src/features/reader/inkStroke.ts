// 画笔纯函数：落库有效性判定 + 笔触 path 构建（组件与测试共用，无副作用依赖）。
import type { InkStroke } from '../../stores/readerStore'

/** 自由笔触相邻采样点最小间距（page 单位）：抑制微抖、限制点数 */
export const MIN_POINT_DIST = 1.2
/** 图形最小尺寸（page 单位）：小于此值视为误触丢弃 */
export const MIN_SHAPE_SIZE = 3

/** 落库有效性：freehand ≥2 点；line/arrow 按欧氏长度（水平/垂直线合法）；
 * rect/ellipse 恰 2 点且双边 ≥ MIN_SHAPE_SIZE（零位移单击/压扁误触丢弃） */
export function isCommittableStroke(stroke: Pick<InkStroke, 'tool' | 'points'>): boolean {
  const { tool, points } = stroke
  if (tool === 'pen' || tool === 'highlighter') return points.length >= 2
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
