// 画笔层落库有效性纯函数测试：图形零位移单击/误触不落库不崩溃（闸门审核 R1 回归）。
import { describe, expect, it } from 'vitest'
import { eraserRadius, hitTestInkStroke, isCommittableStroke, pointSegDist } from '../features/reader/inkStroke'

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

  it('自由笔触：≥2 点通过，单击（1 点）丢弃', () => {
    expect(isCommittableStroke({ tool: 'pen', points: [[10, 10]] })).toBe(false)
    expect(isCommittableStroke({ tool: 'pen', points: [[10, 10], [11, 11]] })).toBe(true)
    expect(isCommittableStroke({ tool: 'highlighter', points: [[10, 10]] })).toBe(false)
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

  it('半径档影响命中（细擦够不着、粗擦够得着）', () => {
    const pen = { tool: 'pen' as const, points: [[0, 0], [100, 0]] as [number, number][], width: 2 }
    expect(hitTestInkStroke(pen, [50, 9], eraserRadius(1.5))).toBe(false)
    expect(hitTestInkStroke(pen, [50, 9], eraserRadius(5))).toBe(true)
  })
})
