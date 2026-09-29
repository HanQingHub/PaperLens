// 画笔纯函数：落库有效性判定 + 笔触 path 构建（组件与测试共用，无副作用依赖）。
import type { InkStroke } from '../../stores/readerStore'

/** 自由笔触相邻采样点最小间距（page 单位）：抑制微抖、限制点数 */
export const MIN_POINT_DIST = 1.2
/** 图形最小尺寸（page 单位）：小于此值视为误触丢弃 */
export const MIN_SHAPE_SIZE = 3

/** 落库有效性：freehand ≥1 点（单击成点：渲染层 smoothPathD 单点分支 + 圆帽成点，
 *  橡皮擦 hitTest 单点分支命中）；line/arrow/dblArrow/circle/arc 按欧氏长度（arc 为
 *  弧线端点语义，水平/垂直合法）；其余图形（rect/ellipse 及包围盒折线族）恰 2 点且
 *  双边 ≥ MIN_SHAPE_SIZE（零位移单击/压扁误触丢弃）；eraser 为纯前端擦除态，永不落库 */
export function isCommittableStroke(stroke: Pick<InkStroke, 'tool' | 'points'>): boolean {
  const { tool, points } = stroke
  if (tool === 'eraser') return false
  if (tool === 'pen' || tool === 'highlighter') return points.length >= 1
  if (points.length !== 2) return false
  const [a, b] = points
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  if (tool === 'line' || tool === 'arrow' || tool === 'dblArrow' || tool === 'circle' || tool === 'arc')
    return Math.hypot(dx, dy) >= MIN_SHAPE_SIZE
  return dx >= MIN_SHAPE_SIZE && dy >= MIN_SHAPE_SIZE
}

/** 折线族图形工具（shapeOutline 采样/顶点序列，渲染与橡皮擦命中同源） */
export const OUTLINE_TOOLS = [
  'roundRect',
  'parallelogram',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'heart',
  'cross',
  'cylinder',
  'semicircle',
  'arc',
] as const

export type OutlineTool = (typeof OUTLINE_TOOLS)[number]

const OUTLINE_SET: ReadonlySet<string> = new Set<string>(OUTLINE_TOOLS)

export function isOutlineTool(tool: InkStroke['tool']): tool is OutlineTool {
  return OUTLINE_SET.has(tool)
}

/**
 * 折线族图形 → 子路径数组（page 单位，a/b 为包围盒对角，先后顺序无关）。
 * closed 子路径首尾点重复——数组长度 = 去重顶点数 + 1；open 子路径（arc、cylinder
 * 身体）不重复。渲染（outlinePathD）与橡皮擦逐段命中共用同一几何。
 * roundRect 四角各 90° 圆弧 3 段采样；正多边形/五角星内切于包围盒（顶点角 −90° 起，
 * 顶朝上）；heart 参数曲线 40 采样按实际极值归一化拉伸进包围盒（y 翻转为屏幕系）；
 * cylinder = 上椭圆（closed）+ 左竖线→下前半弧→右竖线（open）；semicircle = 上半弧
 * + 底边闭合；arc = 上半弧开放（无底边）。
 */
export function shapeOutline(tool: OutlineTool, a: [number, number], b: [number, number]): [number, number][][] {
  const minX = Math.min(a[0], b[0])
  const maxX = Math.max(a[0], b[0])
  const minY = Math.min(a[1], b[1])
  const maxY = Math.max(a[1], b[1])
  const w = maxX - minX
  const h = maxY - minY
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  if (tool === 'pentagon' || tool === 'hexagon' || tool === 'octagon') {
    const n = tool === 'pentagon' ? 5 : tool === 'hexagon' ? 6 : 8
    const r = Math.min(w, h) / 2
    const pts: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const t = -Math.PI / 2 + (i * 2 * Math.PI) / n
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)])
    }
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'star') {
    const R = Math.min(w, h) / 2
    const r = R * 0.382
    const pts: [number, number][] = []
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? R : r
      const t = -Math.PI / 2 + (i * Math.PI) / 5
      pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)])
    }
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'heart') {
    const N = 40
    const raw: [number, number][] = []
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2
      raw.push([
        16 * Math.sin(t) ** 3,
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      ])
    }
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const [x, y] of raw) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    // 心形 y 轴向上，屏幕系 y 向下：翻转后线性映射进包围盒（零宽/高防 0 除退化）
    const mx = (v: number) => (x1 > x0 ? minX + ((v - x0) / (x1 - x0)) * w : minX)
    const my = (v: number) => (y1 > y0 ? maxY - ((v - y0) / (y1 - y0)) * h : maxY)
    const pts: [number, number][] = raw.map(([x, y]) => [mx(x), my(y)])
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'cross') {
    const ax = w / 3
    const ay = h / 3
    const pts: [number, number][] = [
      [minX + ax, minY],
      [minX + 2 * ax, minY],
      [minX + 2 * ax, minY + ay],
      [maxX, minY + ay],
      [maxX, minY + 2 * ay],
      [minX + 2 * ax, minY + 2 * ay],
      [minX + 2 * ax, maxY],
      [minX + ax, maxY],
      [minX + ax, minY + 2 * ay],
      [minX, minY + 2 * ay],
      [minX, minY + ay],
      [minX + ax, minY + ay],
    ]
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'parallelogram') {
    const off = w * 0.25
    const pts: [number, number][] = [
      [minX + off, minY],
      [maxX, minY],
      [maxX - off, maxY],
      [minX, maxY],
    ]
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'roundRect') {
    const r = Math.min(w, h) * 0.18
    const pts: [number, number][] = []
    // 顺时针四角：圆心 + 90° 圆弧起始角（各 4 点采样，相邻角间直边由端点直连）
    const corners: [number, number, number][] = [
      [maxX - r, minY + r, -Math.PI / 2],
      [maxX - r, maxY - r, 0],
      [minX + r, maxY - r, Math.PI / 2],
      [minX + r, minY + r, Math.PI],
    ]
    for (const [ccx, ccy, start] of corners) {
      for (let i = 0; i < 4; i++) {
        const t = start + (i / 3) * (Math.PI / 2)
        pts.push([ccx + r * Math.cos(t), ccy + r * Math.sin(t)])
      }
    }
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  if (tool === 'cylinder') {
    const rx = w / 2
    const ry = Math.min(w / 2, h / 3)
    const topCy = minY + ry
    const botCy = maxY - ry
    const top: [number, number][] = []
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2
      top.push([cx + rx * Math.cos(t), topCy + ry * Math.sin(t)])
    }
    top.push([top[0][0], top[0][1]])
    const body: [number, number][] = [
      [minX, topCy],
      [minX, botCy],
    ]
    // 弧起点 t=π 与 [minX, botCy] 同坐标：从 i=1 起采样避免零长段
    for (let i = 1; i <= 12; i++) {
      const t = Math.PI + (i / 12) * Math.PI
      body.push([cx + rx * Math.cos(t), botCy + ry * Math.abs(Math.sin(t))])
    }
    body.push([maxX, topCy])
    return [top, body]
  }
  if (tool === 'semicircle') {
    const rx = w / 2
    const ry = h
    const pts: [number, number][] = []
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI + (i / 16) * Math.PI
      pts.push([cx + rx * Math.cos(t), maxY + ry * Math.sin(t)])
    }
    pts.push([pts[0][0], pts[0][1]])
    return [pts]
  }
  // arc：开放弧线（无底边），端点距离语义见 isCommittableStroke
  const rx = w / 2
  const ry = h
  const pts: [number, number][] = []
  for (let i = 0; i <= 16; i++) {
    const t = Math.PI + (i / 16) * Math.PI
    pts.push([cx + rx * Math.cos(t), maxY + ry * Math.sin(t)])
  }
  return [pts]
}

/** shapeOutline → SVG path d（k=坐标倍率）：closed 子路径（首尾重复）以 Z 收口，
 *  open 直接连；StrokeShape 渲染与图形面板图标生成共用 */
export function outlinePathD(tool: OutlineTool, a: [number, number], b: [number, number], k: number): string {
  return shapeOutline(tool, a, b)
    .map((sub) => {
      const segs = sub.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x * k} ${y * k}`)
      const closed = sub.length > 1 && sub[0][0] === sub[sub.length - 1][0] && sub[0][1] === sub[sub.length - 1][1]
      return `${segs.join(' ')}${closed ? ' Z' : ''}`
    })
    .join(' ')
}

/** 包围盒类图形工具子集（boxShapePolygons 的合法入参，调用方已类型层收窄） */
type BoxShapeTool = Extract<InkStroke['tool'], 'tri' | 'triRight' | 'diamond' | 'trapezoid'>

/**
 * 包围盒类图形（tri/triRight/diamond/trapezoid）的顶点序列（page 单位，a/b 为
 * 包围盒对角）：渲染 path 与橡皮擦逐边命中共用同一几何，口径一致。
 * tri 等腰（底在下）；triRight 直角边贴左下；diamond 四边中点；
 * trapezoid 上底两端各内缩 25% 包围盒宽。
 */
export function boxShapePolygons(tool: BoxShapeTool, a: [number, number], b: [number, number]): [number, number][] {
  const minX = Math.min(a[0], b[0])
  const maxX = Math.max(a[0], b[0])
  const minY = Math.min(a[1], b[1])
  const maxY = Math.max(a[1], b[1])
  const cx = (minX + maxX) / 2
  if (tool === 'triRight') {
    return [
      [minX, minY],
      [minX, maxY],
      [maxX, maxY],
    ]
  }
  if (tool === 'diamond') {
    return [
      [cx, minY],
      [maxX, (minY + maxY) / 2],
      [cx, maxY],
      [minX, (minY + maxY) / 2],
    ]
  }
  if (tool === 'trapezoid') {
    const inset = (maxX - minX) * 0.25
    return [
      [minX + inset, minY],
      [maxX - inset, minY],
      [maxX, maxY],
      [minX, maxY],
    ]
  }
  // tri：等腰三角形（底在下）
  return [
    [cx, minY],
    [maxX, maxY],
    [minX, maxY],
  ]
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
 * pen/highlighter 逐段判交；line/arrow/dblArrow 主线段 + 尖点圆域（arrow 单端、
 * dblArrow 两端）；circle 沿圆周 48 点折线近似；rect 四边（内部不算命中）；
 * tri/triRight/diamond/trapezoid 按 boxShapePolygons 顶点逐边（内部不算命中）；
 * 折线族（OUTLINE_TOOLS）按 shapeOutline 子路径全段判交（closed 由首尾重复点覆盖
 * 闭合边，内部不算命中）；ellipse 采样 48 点折线近似判交。阈值 = 擦除半径 + 笔迹半宽。
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
  if (isOutlineTool(tool)) {
    for (const sub of shapeOutline(tool, a, b)) {
      for (let i = 0; i < sub.length - 1; i++) {
        if (pointSegDist(p, sub[i], sub[i + 1]) <= tol) return true
      }
    }
    return false
  }
  if (tool === 'line') return pointSegDist(p, a, b) <= tol
  if (tool === 'arrow' || tool === 'dblArrow') {
    if (pointSegDist(p, a, b) <= tol) return true
    // 尖点圆域（与 arrowHeadD 翼长同源）：arrow 仅终点，dblArrow 两端
    const tipR = tol + Math.max(10, width * 4)
    if (Math.hypot(p[0] - b[0], p[1] - b[1]) <= tipR) return true
    if (tool === 'dblArrow' && Math.hypot(p[0] - a[0], p[1] - a[1]) <= tipR) return true
    return false
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
  if (tool === 'tri' || tool === 'triRight' || tool === 'diamond' || tool === 'trapezoid') {
    const poly = boxShapePolygons(tool, a, b)
    for (let i = 0; i < poly.length; i++) {
      if (pointSegDist(p, poly[i], poly[(i + 1) % poly.length]) <= tol) return true
    }
    return false
  }
  if (tool === 'circle') {
    const cx = (a[0] + b[0]) / 2
    const cy = (a[1] + b[1]) / 2
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2
    if (r <= 0) return false
    const N = 48
    let prev: [number, number] = [cx + r, cy]
    for (let i = 1; i <= N; i++) {
      const t = (i / N) * Math.PI * 2
      const cur: [number, number] = [cx + r * Math.cos(t), cy + r * Math.sin(t)]
      if (pointSegDist(p, prev, cur) <= tol) return true
      prev = cur
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
