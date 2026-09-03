// refLinks 纯函数测试：item 矩形换算 / 拼接文本正则映射（含跨 item 与行首判定）
import { describe, expect, it } from 'vitest'
import { intersectRect, findInIndex, type TextIndex, type TextItemPos } from '../features/reader/refLinks'

function item(start: number, str: string, opts: Partial<TextItemPos> = {}): TextItemPos {
  return {
    start,
    end: start + str.length,
    str,
    tx: 72,
    ty: 700,
    w: str.length * 5,
    h: 10,
    ...opts,
  }
}

describe('intersectRect', () => {
  it('完全落在 item 内：x 线性内插，y 以基线为锚', () => {
    const it0 = item(0, 'see [12] ok')
    // [12] 位于字符 4-8
    const r = intersectRect(it0, 4, 8)!
    expect(r).not.toBeNull()
    expect(r[0]).toBeCloseTo(72 + 4 * 5) // tx + offsetRatio * w
    expect(r[2]).toBeCloseTo(72 + 8 * 5)
    expect(r[1]).toBeCloseTo(700 - 0.25 * 10) // ty - 0.25h
    expect(r[3]).toBeCloseTo(700 + 0.85 * 10) // ty + 0.85h
  })

  it('与 item 无交集 → null', () => {
    const it0 = item(0, 'abc')
    expect(intersectRect(it0, 5, 9)).toBeNull()
    expect(intersectRect(it0, 3, 9)).toBeNull() // b <= a 边界
  })

  it('部分重叠取交集', () => {
    const it0 = item(0, 'abcdef')
    const r = intersectRect(it0, 4, 9)!
    expect(r[0]).toBeCloseTo(72 + 4 * 5)
    expect(r[2]).toBeCloseTo(72 + 6 * 5)
  })

  it('空交集返回 null（空串 item 亦不例外）', () => {
    const it0 = item(0, '', { w: 10 })
    const r = intersectRect(it0, 0, 0)
    expect(r).toBeNull()
  })
})

describe('findInIndex', () => {
  // 拼接文本："Body cites [7] here.\n[12] Wang, On Things.\n[13] Li, Others."
  // item 边界故意切碎：跨 item 命中需逐段展开
  const idx: TextIndex = {
    text: 'Body cites [7] here.\n[12] Wang, On Things.\n[13] Li, Others.',
    items: [
      item(0, 'Body cites [7'),
      item(13, '] here.\n', { tx: 140, ty: 640 }),
      item(21, '[12] Wang, On Things.\n', { tx: 72, ty: 620 }),
      item(43, '[13] Li, Others.', { tx: 72, ty: 600 }),
    ],
  }

  it('正文引用：非行首命中，跨 item 命中产出多段矩形', () => {
    const rects = findInIndex(idx, /\[(\d{1,3})\]/g, false)
    expect(rects.length).toBeGreaterThanOrEqual(3)
    // [7] 跨 item0/item1：两段矩形
    const first = rects[0]
    expect(first[0]).toBeCloseTo(72 + 11 * 5)
  })

  it('lineStartOnly：仅行首 [n]（文本起始或 \\n 之后）', () => {
    const rects = findInIndex(idx, /\[(\d{1,3})\]/g, true)
    // [12]（index 21）与 [13]（index 43）行首；[7]（index 11）非行首
    // 但 [12] 起点前一字符是 '\n'（item1 以 '\n' 结尾）→ 行首成立
    expect(rects.length).toBe(2)
  })

  it('全局标志缺失也能全局扫描', () => {
    const rects = findInIndex(idx, /\[\d{1,3}\]/, false)
    expect(rects.length).toBeGreaterThanOrEqual(3)
  })
})
