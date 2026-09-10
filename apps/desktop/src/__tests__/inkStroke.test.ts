// 画笔层落库有效性纯函数测试：图形零位移单击/误触不落库不崩溃（闸门审核 R1 回归）。
import { describe, expect, it } from 'vitest'
import { isCommittableStroke } from '../features/reader/inkStroke'

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
})
