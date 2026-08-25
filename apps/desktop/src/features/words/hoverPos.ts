// 悬停卡定位纯函数（零依赖：不引 store/api，node 测试环境可直接 import）
export interface HoverCardPos {
  left: number
  top: number
  placement: 'top' | 'bottom'
}

/** 定位纯函数：词矩形 → 卡片位置（上方优先，越界翻转 + 边缘 clamp） */
export function computeHoverCardPos(
  rect: DOMRect,
  vw: number,
  vh: number,
  cardW = 240,
  cardH = 92,
  gap = 8,
  margin = 8,
): HoverCardPos {
  let top = rect.top - cardH - gap
  let placement: 'top' | 'bottom' = 'top'
  if (top < margin) {
    top = rect.bottom + gap
    placement = 'bottom'
  }
  if (top + cardH > vh - margin) top = Math.max(margin, vh - cardH - margin)
  let left = rect.left + rect.width / 2 - cardW / 2
  left = Math.max(margin, Math.min(left, vw - cardW - margin))
  return { left, top, placement }
}
