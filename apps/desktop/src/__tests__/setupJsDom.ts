// jsdom 缺少的 API 打桩（highlight DOM 单测专用）
// 注意：jsdom 的 offsetWidth 恒为 0 → stretch 换算断言下沉到 Playwright E2E
import { vi } from 'vitest'

;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
  (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
;(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame =
  (h: number) => clearTimeout(h)

;(document as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint =
  (_x: number, _y: number) => null

// jsdom 的 Range 未实现 getClientRects / getBoundingClientRect → 打桩为固定盒
// （computeWordHighlights 依赖；钳制断言用 spyOn 覆盖为差异化盒：
//   span 行盒 13.2 / 词 Range 字形盒 19.5。真实坐标断言下沉 Playwright E2E）
const fakeRangeRect = {
  left: 0, top: 0, width: 50, height: 19.5, right: 50, bottom: 19.5, x: 0, y: 0,
  toJSON: () => ({}),
}
;(Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects =
  () => [fakeRangeRect]
;(Range.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect =
  () => fakeRangeRect

// getBoundingClientRect 统一返回固定盒（默认 0 会触发 <1px 过滤）
Element.prototype.getBoundingClientRect = vi.fn(() => ({
  left: 0, top: 0, width: 100, height: 13.2, right: 100, bottom: 13.2,
  x: 0, y: 0, toJSON: () => ({}),
})) as unknown as typeof Element.prototype.getBoundingClientRect
