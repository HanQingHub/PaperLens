// 画笔层落库有效性纯函数测试：图形零位移单击/误触不落库不崩溃（闸门审核 R1 回归）。
import { describe, expect, it } from 'vitest'
import {
  boxShapePolygons,
  eraserRadius,
  hitTestInkStroke,
  isCommittableStroke,
  pointSegDist,
} from '../features/reader/inkStroke'

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
})
