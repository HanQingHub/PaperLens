// 画笔层落库有效性纯函数测试：图形零位移单击/误触不落库不崩溃（闸门审核 R1 回归）、
// 折线族图形几何（shapeOutline/outlinePathD）、落库解析白名单（parseAnnotation）。
import { describe, expect, it, vi } from 'vitest'
import {
  boxShapePolygons,
  eraserRadius,
  hitTestInkStroke,
  isCommittableStroke,
  outlinePathD,
  pointSegDist,
  shapeOutline,
} from '../features/reader/inkStroke'
import { parseAnnotation } from '../stores/readerStore'

// parseAnnotation 用例需 import readerStore——其 store 创建期读 localStorage（mode
// 持久化），node 测试环境无此 API：vi.hoisted 在模块加载前打桩（vi.hoisted 会被
// 提升至 import 之前执行）
vi.hoisted(() => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
})

describe('isCommittableStroke', () => {
  it('图形工具零位移单击（仅 1 点）：丢弃且不崩溃', () => {
    expect(isCommittableStroke({ tool: 'rect', points: [[50, 60]] })).toBe(false)
    expect(isCommittableStroke({ tool: 'arrow', points: [[50, 60]] })).toBe(false)
  })

  it('图形工具位移不足 MIN_SHAPE_SIZE：丢弃', () => {
    expect(isCommittableStroke({ tool: 'ellipse', points: [[10, 10], [12, 10]] })).toBe(false)
    expect(isCommittableStroke({ tool: 'rect', points: [[10, 10], [12, 14]] })).toBe(false)
  })

  it('图形工具正常尺寸：通过', () => {
    expect(isCommittableStroke({ tool: 'rect', points: [[10, 10], [15, 15]] })).toBe(true)
  })

  it('自由笔触：单击（1 点）成点，≥2 点画线', () => {
    expect(isCommittableStroke({ tool: 'pen', points: [[10, 10]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'highlighter', points: [[10, 10]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'pen', points: [[10, 10], [11, 11]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'pen', points: [[10, 10], [20, 10]] })).toBe(true)
  })

  it('直线/箭头按欧氏长度：水平/垂直线合法，近零长度丢弃', () => {
    expect(isCommittableStroke({ tool: 'line', points: [[10, 10], [100, 10]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'arrow', points: [[10, 10], [10, 100]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'line', points: [[10, 10], [12, 10.5]] })).toBe(false)
  })

  it('矩形/椭圆双边尺寸：压扁成线的丢弃', () => {
    expect(isCommittableStroke({ tool: 'rect', points: [[10, 10], [100, 10]] })).toBe(false)
    expect(isCommittableStroke({ tool: 'ellipse', points: [[10, 10], [15, 15]] })).toBe(true)
  })

  it('橡皮擦永不落库', () => {
    expect(isCommittableStroke({ tool: 'eraser', points: [[10, 10], [20, 20]] })).toBe(false)
  })

  it('circle/dblArrow 按欧氏长度判定（circle 为直径两端点语义）', () => {
    expect(isCommittableStroke({ tool: 'circle', points: [[10, 10], [10, 20]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'circle', points: [[10, 10], [11, 11]] })).toBe(false)
    expect(isCommittableStroke({ tool: 'dblArrow', points: [[10, 10], [100, 10]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'dblArrow', points: [[10, 10], [11.5, 10]] })).toBe(false)
  })

  it('三角形/菱形/梯形类按包围盒双边判定（压扁成线的丢弃）', () => {
    for (const tool of ['tri', 'triRight', 'diamond', 'trapezoid'] as const) {
      expect(isCommittableStroke({ tool, points: [[10, 10], [60, 50]] })).toBe(true)
      expect(isCommittableStroke({ tool, points: [[10, 10], [60, 11]] })).toBe(false)
      expect(isCommittableStroke({ tool, points: [[10, 10], [11, 50]] })).toBe(false)
      expect(isCommittableStroke({ tool, points: [[10, 10]] })).toBe(false)
    }
  })

  it('折线族包围盒类按双边判定（压扁丢弃），arc 按欧氏长度（端点语义）', () => {
    for (const tool of [
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
    ] as const) {
      expect(isCommittableStroke({ tool, points: [[10, 10], [60, 50]] })).toBe(true)
      expect(isCommittableStroke({ tool, points: [[10, 10], [60, 11]] })).toBe(false)
      expect(isCommittableStroke({ tool, points: [[10, 10], [11, 50]] })).toBe(false)
      expect(isCommittableStroke({ tool, points: [[10, 10]] })).toBe(false)
    }
    expect(isCommittableStroke({ tool: 'arc', points: [[10, 10], [100, 10]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'arc', points: [[10, 10], [12, 10.5]] })).toBe(false)
  })
})

describe('boxShapePolygons', () => {
  it('tri/triRight/diamond/trapezoid 顶点几何', () => {
    expect(boxShapePolygons('tri', [0, 0], [100, 50])).toEqual([
      [50, 0],
      [100, 50],
      [0, 50],
    ])
    expect(boxShapePolygons('triRight', [0, 0], [100, 50])).toEqual([
      [0, 0],
      [0, 50],
      [100, 50],
    ])
    expect(boxShapePolygons('diamond', [0, 0], [100, 50])).toEqual([
      [50, 0],
      [100, 25],
      [50, 50],
      [0, 25],
    ])
    expect(boxShapePolygons('trapezoid', [0, 0], [100, 50])).toEqual([
      [25, 0],
      [75, 0],
      [100, 50],
      [0, 50],
    ])
  })

  it('对角点先后顺序无关（min/max 归一）', () => {
    expect(boxShapePolygons('tri', [100, 50], [0, 0])).toEqual(boxShapePolygons('tri', [0, 0], [100, 50]))
  })
})

describe('eraserRadius', () => {
  it('三档粗细映射擦除半径 7/10/14（page 单位）', () => {
    expect(eraserRadius(1.5)).toBe(7)
    expect(eraserRadius(3)).toBe(10)
    expect(eraserRadius(5)).toBe(14)
  })
})

describe('pointSegDist', () => {
  it('线段中点垂距与端点外钳制', () => {
    expect(pointSegDist([5, 3], [0, 0], [10, 0])).toBe(3)
    expect(pointSegDist([-4, 0], [0, 0], [10, 0])).toBe(4)
  })
})

describe('hitTestInkStroke', () => {
  it('自由笔触：线上命中、远离脱靶', () => {
    const pen = { tool: 'pen' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(pen, [50, 1], 4)).toBe(true)
    expect(hitTestInkStroke(pen, [50, 30], 4)).toBe(false)
  })

  it('单击成点：单点笔迹点距命中、远离脱靶（橡皮可点擦）', () => {
    const dot = { tool: 'pen' as const, points: [[10, 10]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(dot, [12, 10], 4)).toBe(true)
    expect(hitTestInkStroke(dot, [30, 10], 4)).toBe(false)
  })

  it('直线：命中与脱靶', () => {
    const line = { tool: 'line' as const, points: [[10, 10], [100, 10]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(line, [55, 11], 4)).toBe(true)
    expect(hitTestInkStroke(line, [55, 40], 4)).toBe(false)
  })

  it('矩形：边命中、内部不命中（描边语义）', () => {
    const rect = { tool: 'rect' as const, points: [[10, 10], [110, 60]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(rect, [60, 11], 4)).toBe(true)
    expect(hitTestInkStroke(rect, [60, 35], 4)).toBe(false)
  })

  it('椭圆：轮廓命中、圆心不命中', () => {
    const ellipse = { tool: 'ellipse' as const, points: [[10, 10], [110, 60]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(ellipse, [60, 11], 4)).toBe(true)
    expect(hitTestInkStroke(ellipse, [60, 35], 4)).toBe(false)
  })

  it('circle：轮廓命中、圆心与内部不命中', () => {
    // 直径两端 (0,0)-(100,0)：圆心 (50,0) r=50
    const circle = { tool: 'circle' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(circle, [100, 0], 4)).toBe(true)
    expect(hitTestInkStroke(circle, [50, 50], 4)).toBe(true)
    expect(hitTestInkStroke(circle, [50, 0], 4)).toBe(false)
    expect(hitTestInkStroke(circle, [50, 30], 4)).toBe(false)
  })

  it('diamond/trapezoid：边命中、内部不命中', () => {
    const diamond = { tool: 'diamond' as const, points: [[0, 0], [100, 100]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(diamond, [50, 0], 4)).toBe(true)
    expect(hitTestInkStroke(diamond, [50, 50], 4)).toBe(false)
    const trapezoid = { tool: 'trapezoid' as const, points: [[0, 0], [100, 60]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(trapezoid, [50, 0], 4)).toBe(true)
    expect(hitTestInkStroke(trapezoid, [50, 30], 4)).toBe(false)
  })

  it('dblArrow：两端尖点圆域命中（arrow 仅终点端）', () => {
    const dbl = { tool: 'dblArrow' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    const single = { tool: 'arrow' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    // 起点端上方 12（tol=5、尖点圆域半径 15）：dblArrow 命中、arrow 不命中
    expect(hitTestInkStroke(dbl, [0, 12], 4)).toBe(true)
    expect(hitTestInkStroke(single, [0, 12], 4)).toBe(false)
    // 终点端：两者都命中
    expect(hitTestInkStroke(dbl, [100, 12], 4)).toBe(true)
    expect(hitTestInkStroke(single, [100, 12], 4)).toBe(true)
  })

  it('半径档影响命中（细擦够不着、粗擦够得着）', () => {
    const pen = { tool: 'pen' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(pen, [50, 9], eraserRadius(1.5))).toBe(false)
    expect(hitTestInkStroke(pen, [50, 9], eraserRadius(5))).toBe(true)
  })

  it('star：顶点命中、中心内部不命中（描边语义）', () => {
    const star = { tool: 'star' as const, points: [[0, 0], [100, 100]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(star, [50, 0], 4)).toBe(true)
    expect(hitTestInkStroke(star, [50, 50], 4)).toBe(false)
  })

  it('cylinder：上椭圆顶与下前弧最低点命中、轴心内部不命中', () => {
    const cyl = { tool: 'cylinder' as const, points: [[0, 0], [100, 80]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(cyl, [50, 0], 4)).toBe(true)
    expect(hitTestInkStroke(cyl, [50, 80], 4)).toBe(true)
    expect(hitTestInkStroke(cyl, [50, 40], 4)).toBe(false)
  })

  it('arc：弧顶命中、底边弦位不命中（开放弧线无底边）', () => {
    const arc = { tool: 'arc' as const, points: [[0, 0], [100, 40]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(arc, [50, 0], 4)).toBe(true)
    expect(hitTestInkStroke(arc, [50, 40], 4)).toBe(false)
  })
})

describe('shapeOutline（折线族图形）', () => {
  const A: [number, number] = [0, 0]
  const B: [number, number] = [100, 80]

  it('closed 子路径长度=去重顶点+1：pentagon 6/hexagon 7/octagon 9/star 11/cross 13/parallelogram 5/roundRect 17/semicircle 17', () => {
    expect(shapeOutline('pentagon', A, B)[0]).toHaveLength(6)
    expect(shapeOutline('hexagon', A, B)[0]).toHaveLength(7)
    expect(shapeOutline('octagon', A, B)[0]).toHaveLength(9)
    expect(shapeOutline('star', A, B)[0]).toHaveLength(11)
    expect(shapeOutline('cross', A, B)[0]).toHaveLength(13)
    expect(shapeOutline('parallelogram', A, B)[0]).toHaveLength(5)
    expect(shapeOutline('roundRect', A, B)[0]).toHaveLength(17)
    // semicircle/arc 弧段 16 段采样 = 17 点（含两端），closed 再加首点重复 = 18
    expect(shapeOutline('semicircle', A, B)[0]).toHaveLength(18)
    expect(shapeOutline('arc', A, B)[0]).toHaveLength(17)
  })

  it('closed 首尾点重复；arc 与 cylinder 身体开放（首尾不同）', () => {
    for (const t of ['roundRect', 'parallelogram', 'pentagon', 'hexagon', 'octagon', 'star', 'heart', 'cross', 'semicircle'] as const) {
      const sub = shapeOutline(t, A, B)[0]
      expect(sub[0]).toEqual(sub[sub.length - 1])
    }
    const arc = shapeOutline('arc', A, B)[0]
    expect(arc[0]).not.toEqual(arc[arc.length - 1])
    const cyl = shapeOutline('cylinder', A, B)
    expect(cyl).toHaveLength(2)
    expect(cyl[0][0]).toEqual(cyl[0][cyl[0].length - 1])
    expect(cyl[1][0]).not.toEqual(cyl[1][cyl[1].length - 1])
  })

  it('cylinder 上椭圆 24 采样闭合（25 点）；身体从左上沿经下前弧到右上沿', () => {
    const [top, body] = shapeOutline('cylinder', A, B)
    expect(top).toHaveLength(25)
    expect(body[0]).toEqual([0, 26.666666666666668])
    expect(body[body.length - 1]).toEqual([100, 26.666666666666668])
    // 下前弧最低点 (cx, maxY)——cos(3π/2) 非精确零（~1e-16 级）引入浮点误差，容差断言
    expect(body.some(([x, y]) => Math.abs(x - 50) < 1e-9 && Math.abs(y - 80) < 1e-9)).toBe(true)
  })

  it('正多边形顶点朝上内切于包围盒：pentagon 首点 (cx, minY)', () => {
    const sub = shapeOutline('pentagon', [0, 0], [100, 100])[0]
    expect(sub[0][0]).toBeCloseTo(50)
    expect(sub[0][1]).toBeCloseTo(0)
  })

  it('heart 首尾相同且采样全部落在包围盒内', () => {
    const sub = shapeOutline('heart', [10, 20], [110, 90])[0]
    expect(sub[0]).toEqual(sub[sub.length - 1])
    for (const [x, y] of sub) {
      expect(x).toBeGreaterThanOrEqual(10)
      expect(x).toBeLessThanOrEqual(110)
      expect(y).toBeGreaterThanOrEqual(20)
      expect(y).toBeLessThanOrEqual(90)
    }
  })

  it('对角点先后顺序无关（min/max 归一）', () => {
    expect(shapeOutline('star', B, A)).toEqual(shapeOutline('star', A, B))
  })
})

describe('outlinePathD', () => {
  it('closed 以 Z 收口、坐标随 k 倍率（首点 (cx,minY)×2）', () => {
    const d = outlinePathD('pentagon', [0, 0], [100, 100], 2)
    expect(d.startsWith('M 100 0')).toBe(true)
    expect(d).toContain('L')
    expect(d.endsWith(' Z')).toBe(true)
  })

  it('open（arc）不含 Z', () => {
    expect(outlinePathD('arc', [0, 0], [100, 40], 1).includes('Z')).toBe(false)
  })
})

describe('parseAnnotation ink 白名单', () => {
  const raw = (tool: string) => ({
    id: 9,
    paper_id: 1,
    page_no: 1,
    type: 'ink' as const,
    anchor_json: JSON.stringify({ tool, color: '#e74c3c', width: 3, points: [[0, 0], [100, 80]] }),
    card_json: null,
    color: 'yellow',
    text: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })

  it('折线族新工具落库解析通过', () => {
    for (const tool of [
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
    ] as const) {
      expect(parseAnnotation(raw(tool)).ink?.tool).toBe(tool)
    }
  })

  it('未知工具拒收（ink=null 渲染层跳过，旧版本应用读到新数据安全降级）', () => {
    expect(parseAnnotation(raw('hexagram')).ink).toBeNull()
  })
})
