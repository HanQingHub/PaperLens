// computeWordHighlights DOM 单测（jsdom 环境）
// 分桶 / 行盒钳制 / 历史 <i> 清理 / 早退分支
// 真实坐标命中（caret/scaleX/stretch）断言下沉 Playwright E2E
import { beforeEach, describe, expect, it } from 'vitest'
import { computeWordHighlights, type HighlightOptions } from '../features/reader/highlight'
import type { WordBucket } from '../features/reader/highlight'

function makeContainer(lineText: string): { container: HTMLElement; span: HTMLElement } {
  const container = document.createElement('div')
  container.innerHTML = `<div class="textLayer"><span>${lineText}</span></div>`
  document.body.appendChild(container)
  const span = container.querySelector('span') as HTMLElement
  return { container, span }
}

const baseOpts = (over: Partial<HighlightOptions> = {}): HighlightOptions => ({
  stageMap: new Map([['attention', 0]]),
  enabled: true,
  strength: 2,
  ...over,
})

const CTX = { stageLeft: 0, stageTop: 0, stageWidth: 800, stretch: 1 }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('computeWordHighlights', () => {
  it('空需求早退：enabled=false 且无搜索词 → 空分桶', () => {
    const { container } = makeContainer('The attention mechanism')
    expect(computeWordHighlights(container, CTX, baseOpts({ enabled: false }))).toEqual([])
  })

  it('词库命中：分桶 hl-stage-0-s{strength}，垂直钳制到行盒 + 水平外扩', () => {
    const { container } = makeContainer('The attention mechanism')
    const buckets = computeWordHighlights(container, CTX, baseOpts())
    expect(buckets).toHaveLength(1)
    expect(buckets[0].name).toBe('hl-stage-0-s2')
    expect(buckets[0].rects).toHaveLength(1)
    const r = buckets[0].rects[0]
    expect(r.top).toBe(0)
    expect(r.height).toBe(13.2) // 行盒精确值（stub：Range 字形盒 19.5 ⊇ span 13.2）
    // 水平外扩 padX = 13.2×0.1 = 1.32；leftRaw=-1.32 被页宽钳到 0，右缘 50+1.32
    expect(r.left).toBe(0)
    expect(r.width).toBeCloseTo(51.32)
  })

  it('强度档位编码进桶名（s1/s3）', () => {
    const { container } = makeContainer('attention')
    expect(computeWordHighlights(container, CTX, baseOpts({ strength: 1 }))[0].name).toBe('hl-stage-0-s1')
    expect(computeWordHighlights(container, CTX, baseOpts({ strength: 3 }))[0].name).toBe('hl-stage-0-s3')
  })

  it('stage-2 词走下划线桶，不分强度', () => {
    const { container } = makeContainer('attention')
    const buckets = computeWordHighlights(
      container,
      CTX,
      baseOpts({ stageMap: new Map([['attention', 2]]) }),
    )
    expect(buckets[0].name).toBe('hl-stage-2')
  })

  it('搜索词命中 search-hit；当前聚焦词 search-hit-current', () => {
    const { container } = makeContainer('attention mechanism')
    const buckets = computeWordHighlights(
      container,
      CTX,
      baseOpts({
        enabled: false,
        searchTerms: new Set(['attention', 'mechanism']),
        currentTerm: 'mechanism',
      }),
    )
    const byName = Object.fromEntries(buckets.map((b) => [b.name, b.rects.length]))
    expect(byName['search-hit']).toBe(1)
    expect(byName['search-hit-current']).toBe(1)
  })

  it('未命中词不产生分桶', () => {
    const { container } = makeContainer('nothing special here')
    expect(computeWordHighlights(container, CTX, baseOpts())).toEqual([])
  })

  it('历史 <i> 碎片被清理：span 恢复单文本节点且词扫描正常', () => {
    const { container, span } = makeContainer('The <i class="hl-stage-0">attention</i> mechanism')
    expect(span.childNodes.length).toBeGreaterThan(1)
    const buckets = computeWordHighlights(container, CTX, baseOpts())
    expect(span.childNodes.length).toBe(1)
    expect(span.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(span.textContent).toBe('The attention mechanism')
    expect(buckets[0].rects).toHaveLength(1)
  })

  it('endOfContent span 跳过', () => {
    const container = document.createElement('div')
    container.innerHTML = '<div class="textLayer"><span class="endOfContent">attention</span></div>'
    document.body.appendChild(container)
    expect(computeWordHighlights(container, CTX, baseOpts())).toEqual([])
  })

  it('span 盒与词盒错位（交集 <2px）：保留原字形盒区间（退化防御）', () => {
    const { container, span } = makeContainer('attention')
    // 覆盖 span 盒为远端位置（舞台 y 100 起），Range 桩固定在 y 0..19.5 → 交集空
    span.getBoundingClientRect = () => ({
      left: 0, top: 100, width: 100, height: 13.2, right: 100, bottom: 113.2,
      x: 0, y: 100, toJSON: () => ({}),
    }) as DOMRect
    const buckets = computeWordHighlights(container, CTX, baseOpts())
    expect(buckets[0].rects[0].top).toBe(0)
    expect(buckets[0].rects[0].height).toBe(19.5)
  })

  it('stretch 换算：可视坐标 ÷ stretch 进舞台坐标', () => {
    const { container } = makeContainer('attention')
    // Range 桩 left=0/width=50 可视 → ÷0.5 → 宽 100；span 盒 13.2 可视 → 舞台 26.4，
    // padX = min(26.4×0.1, 4) = 2.64；leftRaw=-2.64 钳到 0 → 宽 102.64
    const buckets = computeWordHighlights(
      container,
      { stageLeft: 0, stageTop: 0, stageWidth: 800, stretch: 0.5 },
      baseOpts(),
    )
    expect(buckets[0].rects[0].width).toBeCloseTo(102.64)
  })

  it('lineBands 统一垂直口径：同行两词带同高、不被垂直切分（v2.5 缺陷 A 回归）', () => {
    const { container } = makeContainer('attention mechanism')
    const buckets = computeWordHighlights(
      container,
      { ...CTX, lineBands: [{ top: 2, bottom: 16.3 }] },
      baseOpts({
        enabled: false,
        searchTerms: new Set(['attention', 'mechanism']),
        currentTerm: 'mechanism',
      }),
    )
    const all = buckets.flatMap((b) => b.rects)
    expect(all).toHaveLength(2)
    for (const r of all) {
      expect(r.top).toBe(2)
      expect(r.height).toBeCloseTo(14.3) // 行带高度，而非被剁半的 7.15
    }
  })

  it('同桶同行贴近带合并：桩矩形全同 → 两词并成单矩形', () => {
    const { container } = makeContainer('attention attention')
    const buckets = computeWordHighlights(container, CTX, baseOpts())
    expect(buckets[0].rects).toHaveLength(1) // 外扩后交叠 → 合并，无双涂层缝
  })
})

describe('WordBucket 类型契约（编译期）', () => {
  it('分桶结构 name + rects', () => {
    const buckets: WordBucket[] = [{ name: 'search-hit', rects: [{ left: 0, top: 0, width: 1, height: 1 }] }]
    expect(buckets[0].rects[0].left).toBe(0)
  })
})
