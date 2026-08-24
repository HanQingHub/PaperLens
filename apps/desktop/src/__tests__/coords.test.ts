// 坐标链纯函数测试：PDF 用户空间（pt，原点左下）↔ 页内 CSS 映射。
// 这些函数是文本层/OCR 叠加层/批注锚点全部对齐行为的基础（T05）。
import { describe, expect, it } from 'vitest'
import {
  cardEdgeX,
  clientRectsInPage,
  clientRectsToPdf,
  cssPointToPdf,
  linkPath,
  pdfPointToCss,
  pdfRectToCss,
  rectCenter,
} from '../shared/coords'

const geom = { baseW: 612, baseH: 792, scale: 2 }

describe('pdfRectToCss', () => {
  it('原点翻转：PDF 左下原点 → CSS 左上原点', () => {
    // PDF 矩形 [x0,y0,x1,y1] = [100, 700, 200, 712]
    const css = pdfRectToCss([100, 700, 200, 712], geom)
    expect(css.left).toBe(200)
    expect(css.width).toBe(200)
    expect(css.height).toBe(24)
    // top = (792 - 712) * 2 = 160
    expect(css.top).toBe(160)
  })

  it('页底矩形 top 落在 0', () => {
    const css = pdfRectToCss([0, 780, 612, 792], geom)
    expect(css.top).toBe(0)
    expect(css.height).toBe(24)
  })

  it('scale=1 恒等', () => {
    const css = pdfRectToCss([10, 20, 30, 50], { baseW: 100, baseH: 100, scale: 1 })
    expect(css).toEqual({ left: 10, top: 50, width: 20, height: 30 })
  })
})

describe('pdfPointToCss / cssPointToPdf', () => {
  it('互逆（roundtrip）', () => {
    for (const [x, y] of [[0, 0], [306, 396], [612, 792], [123.45, 678.9]] as const) {
      const c = pdfPointToCss(x, y, geom)
      const p = cssPointToPdf(c.x, c.y, geom)
      expect(Math.abs(p.x - x)).toBeLessThan(1e-9)
      expect(Math.abs(p.y - y)).toBeLessThan(1e-9)
    }
  })

  it('y 翻转：PDF 页顶点 → CSS top 0', () => {
    expect(pdfPointToCss(0, 792, geom).y).toBe(0)
    expect(pdfPointToCss(0, 0, geom).y).toBe(1584)
  })
})

describe('clientRectsToPdf', () => {
  const pageBox = { left: 1000, top: 2000, width: 1224, height: 1584, right: 2224, bottom: 3584 }

  function fakeRect(r: { left: number; top: number; right: number; bottom: number; width: number; height: number }) {
    return r as DOMRect
  }

  it('视口选区矩形 → PDF 坐标（含 y 翻转与两位小数舍入）', () => {
    // 页内 CSS 矩形：left=200, top=160, 宽 200 高 24（scale=2 下对应 PDF [100,700,200,712]）
    const r = fakeRect({ left: 1200, top: 2160, right: 1400, bottom: 2184, width: 200, height: 24 })
    const el = { getBoundingClientRect: () => pageBox } as unknown as HTMLElement
    const rects = clientRectsToPdf([r], el, geom)
    expect(rects).toEqual([[100, 700, 200, 712]])
  })

  it('过滤 <1px 的碎矩形', () => {
    const tiny = fakeRect({ left: 1100, top: 2160, right: 1100.5, bottom: 2160.5, width: 0.5, height: 0.5 })
    const el = { getBoundingClientRect: () => pageBox } as unknown as HTMLElement
    expect(clientRectsToPdf([tiny], el, geom)).toEqual([])
  })

  it('clientRectsInPage：跨页选区只保留基准页内的矩形（B3）', () => {
    const inPage = fakeRect({ left: 1100, top: 2100, right: 1400, bottom: 2124, width: 300, height: 24 })
    const nextPage = fakeRect({ left: 1100, top: 3584, right: 1400, bottom: 3608, width: 300, height: 24 })
    const straddle = fakeRect({ left: 1100, top: 3570, right: 1400, bottom: 3600, width: 300, height: 30 }) // 中点在页外
    const out = clientRectsInPage([inPage, nextPage, straddle], pageBox)
    expect(out).toEqual([inPage])
  })

  it('clientRectsInPage：页内全部矩形保留', () => {
    const a = fakeRect({ left: 1100, top: 2000, right: 1300, bottom: 2024, width: 200, height: 24 })
    const b = fakeRect({ left: 1100, top: 3560, right: 1300, bottom: 3584, width: 200, height: 24 })
    expect(clientRectsInPage([a, b], pageBox)).toEqual([a, b])
  })
})

describe('linkPath', () => {
  it('锚点在卡片上方时弓形向下、下方时弓形向上', () => {
    expect(linkPath(100, 100, 300, 300)).toBe('M 100 100 C 150 44, 250 356, 300 300')
    expect(linkPath(100, 300, 300, 100)).toBe('M 100 300 C 150 356, 250 44, 300 100')
  })

  it('长水平距离时弓形被钳制在 56', () => {
    // dx=600 → 0.22*600+16=148 → clamp 56（ay==cy 时 bow 取负）
    expect(linkPath(0, 500, 600, 500)).toBe('M 0 500 C 150 444, 450 556, 600 500')
  })
})

describe('cardEdgeX', () => {
  // 按基线实际行为断言（远端边接入）；docstring"朝向锚点一侧"与实现相反，
  // 见项目日志 INCONSISTENCY 条目
  it('锚点在卡片右半侧接入左边缘，左半侧接入右边缘', () => {
    expect(cardEdgeX(100, 200, 500)).toBe(100)
    expect(cardEdgeX(100, 200, 50)).toBe(300)
    expect(cardEdgeX(100, 200, 200)).toBe(300) // 恰在中点 → 左半侧分支
  })
})

describe('rectCenter', () => {
  it('矩形中心', () => {
    expect(rectCenter([0, 0, 10, 20])).toEqual({ x: 5, y: 10 })
  })
})
