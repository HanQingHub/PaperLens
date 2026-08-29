// 坐标链纯函数测试：PDF 用户空间（pt，原点左下）↔ 页内 CSS 映射。
// 这些函数是文本层/OCR 叠加层/批注锚点全部对齐行为的基础（T05）。
import { describe, expect, it } from 'vitest'
import {
  cardEdgeX,
  clientRectsInPage,
  clientRectsToPdf,
  cssPointToPdf,
  linkPath,
  mergeClientRects,
  mergePdfRects,
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

describe('mergeClientRects', () => {
  function fakeRect(r: { left: number; top: number; right: number; bottom: number; width: number; height: number }) {
    return r as DOMRect
  }

  it('同行重叠碎片合并为单矩形', () => {
    const a = fakeRect({ left: 100, top: 50, right: 140, bottom: 70, width: 40, height: 20 })
    const b = fakeRect({ left: 138, top: 50, right: 180, bottom: 70, width: 42, height: 20 })
    const out = mergeClientRects([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].left).toBe(100)
    expect(out[0].right).toBe(180)
    expect(out[0].height).toBe(20)
  })

  it('同行词距 3-4px 的相邻矩形仍合并为一行（union 吸收间隙）', () => {
    const a = fakeRect({ left: 100, top: 50, right: 130, bottom: 70, width: 30, height: 20 })
    const b = fakeRect({ left: 134, top: 50, right: 170, bottom: 70, width: 36, height: 20 })
    const out = mergeClientRects([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].width).toBe(70)
  })

  it('跨行矩形不合并', () => {
    const a = fakeRect({ left: 100, top: 50, right: 180, bottom: 70, width: 80, height: 20 })
    const b = fakeRect({ left: 100, top: 74, right: 180, bottom: 94, width: 80, height: 20 })
    const out = mergeClientRects([a, b])
    expect(out).toHaveLength(2)
  })

  it('top 抖动 0.9px（< 下界 1px）视为同行合并', () => {
    const a = fakeRect({ left: 100, top: 50.0, right: 130, bottom: 70, width: 30, height: 20 })
    const b = fakeRect({ left: 134, top: 50.9, right: 170, bottom: 70.9, width: 36, height: 20 })
    expect(mergeClientRects([a, b])).toHaveLength(1)
  })

  it('scale 0.8 下 yTolPt=1.0 归一化后取下界 1px，0.9px 抖动仍合并', () => {
    const a = fakeRect({ left: 100, top: 50.0, right: 130, bottom: 70, width: 30, height: 20 })
    const b = fakeRect({ left: 134, top: 50.9, right: 170, bottom: 70.9, width: 36, height: 20 })
    expect(mergeClientRects([a, b], 1.0, 0.8)).toHaveLength(1)
  })

  it('scale 归一化：高倍下同行抖动按比例放宽', () => {
    const a = fakeRect({ left: 100, top: 50.0, right: 130, bottom: 70, width: 30, height: 20 })
    const b = fakeRect({ left: 134, top: 51.8, right: 170, bottom: 71.8, width: 36, height: 20 })
    // scale=2 → yTol=2px，1.8px 抖动合并；scale=1 → 不合并
    expect(mergeClientRects([a, b], 1.0, 2.0)).toHaveLength(1)
    expect(mergeClientRects([a, b], 1.0, 1.0)).toHaveLength(2)
  })

  it('空数组与碎矩形（宽/高 <1px）过滤', () => {
    expect(mergeClientRects([])).toEqual([])
    const tiny = fakeRect({ left: 100, top: 50, right: 100.5, bottom: 50.5, width: 0.5, height: 0.5 })
    expect(mergeClientRects([tiny])).toEqual([])
  })

  it('乱序输入按 top 排序后正确分行', () => {
    const row1a = fakeRect({ left: 134, top: 50, right: 170, bottom: 70, width: 36, height: 20 })
    const row2 = fakeRect({ left: 100, top: 74, right: 180, bottom: 94, width: 80, height: 20 })
    const row1b = fakeRect({ left: 100, top: 50, right: 130, bottom: 70, width: 30, height: 20 })
    const out = mergeClientRects([row1a, row2, row1b])
    expect(out).toHaveLength(2)
    expect(out[0].top).toBe(50)
    expect(out[0].width).toBe(70)
    expect(out[1].top).toBe(74)
  })

  it('双层 rect 包含去重：textLayer 同位置字体盒+行盒 → 保留字体盒（实测 E3 数据）', () => {
    // 同一词的双层 rect：字体盒 (t=305.7,h=25.5) 包含行盒 (t=309.7,h=17.9)
    const glyphBox = fakeRect({ left: 373.6, top: 305.7, right: 409.3, bottom: 331.2, width: 35.7, height: 25.5 })
    const lineBox = fakeRect({ left: 373.6, top: 309.7, right: 409.3, bottom: 327.6, width: 35.7, height: 17.9 })
    const out = mergeClientRects([lineBox, glyphBox])
    expect(out).toHaveLength(1)
    expect(out[0].height).toBe(25.5)
    expect(out[0].top).toBe(305.7)
  })

  it('双层 rect 去重后同行 union：实测 22 rect 序列收敛为按行矩形', () => {
    // 实测摘录：一行内 3 个词，每词双层（行盒在前字体盒在后交错）
    const rects = [
      fakeRect({ left: 373.6, top: 309.7, right: 409.3, bottom: 327.6, width: 35.7, height: 17.9 }),
      fakeRect({ left: 373.6, top: 305.7, right: 409.3, bottom: 331.2, width: 35.7, height: 25.5 }),
      fakeRect({ left: 408.7, top: 309.7, right: 413.3, bottom: 327.6, width: 4.6, height: 17.9 }),
      fakeRect({ left: 408.7, top: 305.7, right: 413.3, bottom: 331.2, width: 4.6, height: 25.5 }),
      fakeRect({ left: 438.3, top: 309.7, right: 448.2, bottom: 327.6, width: 9.9, height: 17.9 }),
      fakeRect({ left: 438.3, top: 305.7, right: 448.2, bottom: 331.2, width: 9.9, height: 25.5 }),
    ]
    const out = mergeClientRects(rects)
    expect(out).toHaveLength(1) // 去重后 3 个同 top 字体盒 → 同行 union
    expect(out[0].left).toBe(373.6)
    expect(out[0].right).toBe(448.2)
    expect(out[0].height).toBe(25.5)
  })

  it('justified 相邻行同列同宽（相离）不被包含去重误合并', () => {
    const row1 = fakeRect({ left: 100, top: 50, right: 500, bottom: 75.5, width: 400, height: 25.5 })
    const row2 = fakeRect({ left: 100, top: 70, right: 500, bottom: 95.5, width: 400, height: 25.5 })
    // 垂直部分重叠（行距 20 < 盒高 25.5）但互不包含 → 均保留，且 top 差 20 跨行不 union
    const out = mergeClientRects([row1, row2])
    expect(out).toHaveLength(2)
  })

  it('值完全相等的重复 rect 恰保留一个（不双丢）', () => {
    const a = fakeRect({ left: 100, top: 50, right: 180, bottom: 75.5, width: 80, height: 25.5 })
    const b = fakeRect({ left: 100, top: 50, right: 180, bottom: 75.5, width: 80, height: 25.5 })
    expect(mergeClientRects([a, b])).toHaveLength(1)
    // 反序同样恰留一个
    expect(mergeClientRects([b, a])).toHaveLength(1)
  })
})

describe('mergePdfRects', () => {
  it('同行（y0 接近）碎片合并为单 rect', () => {
    const out = mergePdfRects([
      [100, 700, 130, 712],
      [132, 700, 180, 712],
    ])
    expect(out).toEqual([[100, 700, 180, 712]])
  })

  it('跨行 rect 保留不合并', () => {
    const out = mergePdfRects([
      [100, 700, 180, 712],
      [100, 686, 180, 698],
    ])
    expect(out).toHaveLength(2)
  })

  it('tol 边界：y0 差恰 1pt 不合并，0.9pt 合并', () => {
    const a: [number, number, number, number] = [100, 700, 180, 712]
    const b: [number, number, number, number] = [100, 699.1, 180, 711.1]
    const c: [number, number, number, number] = [100, 699, 180, 711]
    expect(mergePdfRects([a, b])).toHaveLength(1)
    expect(mergePdfRects([a, c])).toHaveLength(2)
  })

  it('空数组与退化 rect 过滤', () => {
    expect(mergePdfRects([])).toEqual([])
    expect(mergePdfRects([[100, 700, 100, 712]])).toEqual([])
  })

  it('包含去重：被完全包含的 rect 丢弃（历史数据双层防御）', () => {
    const outer: [number, number, number, number] = [100, 700, 180, 712.6]
    const inner: [number, number, number, number] = [100, 702, 180, 710]
    expect(mergePdfRects([inner, outer])).toEqual([[100, 700, 180, 712.6]])
  })

  it('值完全相等的重复 rect 恰保留一个（不双丢）', () => {
    const r: [number, number, number, number] = [100, 700, 180, 712]
    expect(mergePdfRects([r, [100, 700, 180, 712]])).toEqual([[100, 700, 180, 712]])
    expect(mergePdfRects([[100, 700, 180, 712], r])).toEqual([[100, 700, 180, 712]])
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
