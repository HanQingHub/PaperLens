// OCR 叠加层纯函数测试：逐行定位与字号推算（M4/M5）。
import { describe, expect, it } from 'vitest'
import { ocrLineCss, ocrLineFontSize } from '../features/reader/ocrOverlay'
import { OCR_LINE_HEIGHT_RATIO } from '../features/reader/constants'
import type { PageGeom } from '../shared/coords'

const geom: PageGeom = { baseW: 612, baseH: 792, scale: 2 }
const line = { bbox: [100, 700, 300, 712] as [number, number, number, number], text: 'a line', conf: 0.9 }

describe('ocrLineCss', () => {
  it('行 bbox → CSS 定位（与 pdfRectToCss 同语义）', () => {
    const css = ocrLineCss(line, geom)
    expect(css).toEqual({ left: 200, top: 160, width: 400, height: 24 })
  })

  it('缩放倍率改变时尺寸线性缩放', () => {
    const css = ocrLineCss(line, { ...geom, scale: 1.5 })
    expect(css.left).toBe(150)
    expect(css.height).toBe(18)
  })
})

describe('ocrLineFontSize', () => {
  it('字号 = 行高 × 校准系数', () => {
    // 行高 = (712-700) × 2 = 24 CSS px
    expect(ocrLineFontSize(line, geom)).toBeCloseTo(24 * OCR_LINE_HEIGHT_RATIO, 10)
  })

  it('零高度框不产生 NaN/Infinity', () => {
    const degenerate = { bbox: [100, 700, 300, 700] as [number, number, number, number], text: '', conf: 0 }
    expect(Number.isFinite(ocrLineFontSize(degenerate, geom))).toBe(true)
    expect(ocrLineFontSize(degenerate, geom)).toBe(0)
  })
})
