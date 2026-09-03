// linkLayer 纯函数测试：显式 dest 比率换算 / PDF 空间矩形命中
import { describe, expect, it } from 'vitest'
import { explicitDestToRatio, pointInPdfRects } from '../features/reader/linkLayer'

describe('explicitDestToRatio', () => {
  const H = 792

  it('XYZ：top 在页顶 → ratio 0；页底 → ratio 1；中部线性', () => {
    expect(explicitDestToRatio('XYZ', H, H)).toBe(0)
    expect(explicitDestToRatio('XYZ', 0, H)).toBe(1)
    expect(explicitDestToRatio('XYZ', H / 2, H)).toBeCloseTo(0.5)
  })

  it('FitH 同 XYZ 取 top', () => {
    expect(explicitDestToRatio('FitH', H / 4, H)).toBeCloseTo(0.75)
  })

  it('Fit/FitV/FitR/未知名 → 0（页顶）', () => {
    expect(explicitDestToRatio('Fit', 100, H)).toBe(0)
    expect(explicitDestToRatio('FitV', 100, H)).toBe(0)
    expect(explicitDestToRatio('FitR', 100, H)).toBe(0)
    expect(explicitDestToRatio('Weird', 100, H)).toBe(0)
  })

  it('top 缺失/非法 → 0；pageH 非法 → 0', () => {
    expect(explicitDestToRatio('XYZ', undefined, H)).toBe(0)
    expect(explicitDestToRatio('XYZ', null, H)).toBe(0)
    expect(explicitDestToRatio('XYZ', NaN, H)).toBe(0)
    expect(explicitDestToRatio('XYZ', 100, 0)).toBe(0)
  })

  it('比率钳制 [0,1]', () => {
    expect(explicitDestToRatio('XYZ', -100, H)).toBe(1)
    expect(explicitDestToRatio('XYZ', H + 100, H)).toBe(0)
  })
})

describe('pointInPdfRects', () => {
  const rects: [number, number, number, number][] = [[100, 700, 160, 712]]

  it('矩形内命中', () => {
    expect(pointInPdfRects(130, 706, rects)).toBe(true)
  })

  it('容差边界命中（默认 2pt）', () => {
    expect(pointInPdfRects(98, 706, rects)).toBe(true)
    expect(pointInPdfRects(130, 714, rects)).toBe(true)
  })

  it('矩形外不命中', () => {
    expect(pointInPdfRects(90, 706, rects)).toBe(false)
    expect(pointInPdfRects(130, 720, rects)).toBe(false)
  })

  it('自定义容差', () => {
    expect(pointInPdfRects(90, 706, rects, 12)).toBe(true)
    expect(pointInPdfRects(90, 706, rects, 1)).toBe(false)
  })

  it('空矩形集合不命中', () => {
    expect(pointInPdfRects(130, 706, [])).toBe(false)
  })
})
