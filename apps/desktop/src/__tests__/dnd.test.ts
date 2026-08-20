// dnd/ 纯函数单测：dragKind / reorderItems / computeInsertIndex / nextSortOrder / sortOrderDiff / moveAcrossGroups
import { describe, expect, it } from 'vitest'
import type { Paper } from '../api/types'
import { PAPER_DRAG_MIME, PROJECT_DRAG_MIME } from '../features/library/dnd/types'
import { dragKind } from '../features/library/dnd/guard'
import {
  computeInsertIndex, moveAcrossGroups, nextSortOrder, reorderItems, sortOrderDiff,
} from '../features/library/dnd/reorder'

let seq = 0
function makePaper(id: number, sort_order: number, project_id: number | null = null): Paper {
  return {
    id,
    project_id,
    title: `p${id}`,
    authors: null,
    venue: null,
    year: null,
    doi: null,
    file_hash: `h${++seq}`,
    page_count: 1,
    open_count: 0,
    is_scanned: false,
    ocr_status: 'none',
    tags: [],
    note: null,
    is_favorite: false,
    sort_order,
    created_at: '2026-01-01T00:00:00',
    last_opened_at: null,
  }
}

describe('dragKind', () => {
  it('含 Files → files（优先级高于卡片）', () => {
    expect(dragKind(['Files'])).toBe('files')
    expect(dragKind(['Files', PAPER_DRAG_MIME])).toBe('files')
  })
  it('含卡片 MIME → paper', () => {
    expect(dragKind([PAPER_DRAG_MIME])).toBe('paper')
  })
  it('无已知类型 → null（文本拖选、项目条目拖拽等）', () => {
    expect(dragKind([])).toBeNull()
    expect(dragKind(['text/plain'])).toBeNull()
    expect(dragKind([PROJECT_DRAG_MIME])).toBeNull()
  })
})

describe('reorderItems', () => {
  const arr = ['a', 'b', 'c', 'd']
  it('移到末尾（首元素 → 尾后）', () => {
    expect(reorderItems(arr, 0, 4)).toEqual(['b', 'c', 'd', 'a'])
  })
  it('移到开头（尾元素 → 首前）', () => {
    expect(reorderItems(arr, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })
  it('相邻位 no-op：B 移到 C 前仍是原位', () => {
    expect(reorderItems(arr, 1, 2)).toEqual(arr)
  })
  it('B 移到 C 后', () => {
    expect(reorderItems(arr, 1, 3)).toEqual(['a', 'c', 'b', 'd'])
  })
  it('B 移到 A 前', () => {
    expect(reorderItems(arr, 1, 0)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('自身索引 / 越界索引返回原数组', () => {
    expect(reorderItems(arr, 2, 2)).toBe(arr)
    expect(reorderItems(arr, -1, 0)).toBe(arr)
    expect(reorderItems(arr, 9, 0)).toBe(arr)
  })
})

describe('computeInsertIndex', () => {
  const items = [makePaper(1, 0), makePaper(2, 1), makePaper(3, 2)]
  it('before → 悬停卡片自身索引', () => {
    expect(computeInsertIndex(items, 2, 'before')).toBe(1)
    expect(computeInsertIndex(items, 1, 'before')).toBe(0) // 首卡片
  })
  it('after → 悬停卡片索引 +1', () => {
    expect(computeInsertIndex(items, 2, 'after')).toBe(2)
    expect(computeInsertIndex(items, 3, 'after')).toBe(3) // 尾卡片
  })
  it('悬停卡片不在组内（含空组）→ 追加组尾', () => {
    expect(computeInsertIndex(items, 99, 'before')).toBe(3)
    expect(computeInsertIndex([], 1, 'after')).toBe(0)
  })
})

describe('nextSortOrder', () => {
  it('空组 → 0', () => {
    expect(nextSortOrder([])).toBe(0)
  })
  it('非空 → max+1（不依赖连续性）', () => {
    expect(nextSortOrder([makePaper(1, 0), makePaper(2, 1)])).toBe(2)
    expect(nextSortOrder([makePaper(1, 3), makePaper(2, 7)])).toBe(8)
  })
})

describe('sortOrderDiff', () => {
  it('全部不变 → 空清单', () => {
    const items = [makePaper(1, 0), makePaper(2, 1)]
    expect(sortOrderDiff(items)).toEqual([])
  })
  it('顺序变化 → 只含 sort_order 实际变化的项', () => {
    // 重排后 [p2, p1]：p2 0→1 变，p1 1→0 变 → 2 项
    const items = [makePaper(1, 1), makePaper(2, 0)]
    expect(sortOrderDiff(items)).toEqual([
      { id: 1, sort_order: 0, project_id: null },
      { id: 2, sort_order: 1, project_id: null },
    ])
    // 部分变：[p1,p2,p3,p4] 把 p2 移到 p3 后 → [p1,p3,p2,p4]，p1/p4 索引不变
    const items2 = [makePaper(1, 0), makePaper(2, 1), makePaper(3, 2), makePaper(4, 3)]
    const reordered = [items2[0], items2[2], items2[1], items2[3]]
    expect(sortOrderDiff(reordered).map((x) => x.id)).toEqual([3, 2])
  })
  it('movedIds 强制包含（跨组移动时 sort_order 可能巧合不变）', () => {
    const items = [makePaper(1, 0, 5), makePaper(2, 1, 5)] // p2 移入本组且落在 index 1（与原值相同）
    const diff = sortOrderDiff(items, [2])
    expect(diff).toEqual([{ id: 2, sort_order: 1, project_id: 5 }])
  })
})

describe('moveAcrossGroups', () => {
  it('跨组移动：源组移除、目标组插入，两组重排为连续 sort_order', () => {
    const src = [makePaper(1, 0, 5), makePaper(2, 1, 5), makePaper(3, 2, 5)]
    const tgt = [makePaper(4, 0, 6), makePaper(5, 1, 6)]
    const { source, target } = moveAcrossGroups(src, tgt, 2, 1)
    expect(source.map((p) => p.id)).toEqual([1, 3])
    expect(source.map((p) => p.sort_order)).toEqual([0, 1])
    expect(target.map((p) => p.id)).toEqual([4, 2, 5])
    expect(target.map((p) => p.sort_order)).toEqual([0, 1, 2])
  })
  it('移到未分组（project_id 由调用方指定，函数只重排）', () => {
    const src = [makePaper(1, 0, 5)]
    const tgt: Paper[] = []
    const { source, target } = moveAcrossGroups(src, tgt, 1, 0)
    expect(source).toEqual([])
    expect(target.map((p) => [p.id, p.sort_order])).toEqual([[1, 0]])
    expect(target[0].project_id).toBe(5) // project_id 未被函数改动
  })
  it('空目标组 + 插入首/尾索引越界 → 收敛到组尾', () => {
    const src = [makePaper(1, 0, 5), makePaper(2, 1, 5)]
    const r1 = moveAcrossGroups(src, [], 1, 0)
    expect(r1.target.map((p) => p.id)).toEqual([1])
    const r2 = moveAcrossGroups(r1.source, [], 2, 99)
    expect(r2.target.map((p) => p.id)).toEqual([2])
    expect(r2.target[0].sort_order).toBe(0)
  })
  it('paperId 不在源组 → 原样返回', () => {
    const src = [makePaper(1, 0, 5)]
    const tgt = [makePaper(2, 0, 6)]
    const { source, target } = moveAcrossGroups(src, tgt, 99, 0)
    expect(source).toBe(src)
    expect(target).toBe(tgt)
  })
})
