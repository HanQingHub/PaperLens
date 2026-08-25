// M2：生词悬停释义卡定位（上方优先、越界翻转、边缘 clamp）
import { describe, expect, it } from 'vitest'
import { computeHoverCardPos } from '../features/words/hoverPos'

function rect(top: number, bottom: number, left = 400, width = 80) {
  return { top, bottom, left, right: left + width, width, height: bottom - top } as DOMRect
}

describe('computeHoverCardPos', () => {
  const vw = 1440
  const vh = 900

  it('默认放词上方', () => {
    const p = computeHoverCardPos(rect(500, 524), vw, vh)
    expect(p.placement).toBe('top')
    expect(p.top).toBe(500 - 92 - 8)
  })

  it('贴顶时翻转到下方', () => {
    const p = computeHoverCardPos(rect(60, 84), vw, vh)
    expect(p.placement).toBe('bottom')
    expect(p.top).toBe(84 + 8)
  })

  it('上下都放不下时 clamp 在视口内', () => {
    const p = computeHoverCardPos(rect(40, 64), vw, 120)
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.top + 92).toBeLessThanOrEqual(120 - 8)
  })

  it('水平居中于词并 clamp 视口边缘', () => {
    const centered = computeHoverCardPos(rect(500, 524, 700), vw, vh)
    expect(centered.left).toBe(700 + 40 - 120)
    const atLeftEdge = computeHoverCardPos(rect(500, 524, 2), vw, vh)
    expect(atLeftEdge.left).toBe(8)
    const atRightEdge = computeHoverCardPos(rect(500, 524, vw - 10), vw, vh)
    expect(atRightEdge.left).toBe(vw - 240 - 8)
  })
})
