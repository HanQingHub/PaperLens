// 排序/移动纯函数（全部可单测，见 src/__tests__/dnd.test.ts）
import type { Paper } from '../../../api/types'

export interface PaperOrderPatch {
  id: number
  sort_order: number
  project_id: number | null
}

/**
 * 组内按索引移动。toIndex 为"移动前数组"中的插入位（悬停卡片前/后语义），
 * 内部对 from < to 做补偿，保证 [A,B,C,D] 中 B(1) 移到 C(2) 前仍是原位（no-op）。
 */
export function reorderItems<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= items.length || fromIndex === toIndex) return items
  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  const to = toIndex > fromIndex ? toIndex - 1 : toIndex
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}

/**
 * 悬停卡片 → 插入索引：side='after' 插到其后，否则其前；
 * 悬停卡片不在组内（含空组）→ 追加到组尾。
 * （指针 x 与卡片中点的比较依赖 DOM，由 hook 完成后传入 side）
 */
export function computeInsertIndex(items: Paper[], hoveredId: number, side: 'before' | 'after'): number {
  const idx = items.findIndex((p) => p.id === hoveredId)
  if (idx === -1) return items.length
  return side === 'after' ? idx + 1 : idx
}

/** 组内下一 sort_order（max+1；空组为 0） */
export function nextSortOrder(items: Paper[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((p) => p.sort_order)) + 1
}

/**
 * 差异 PATCH 清单：新数组按索引 0..n-1 重排后，只返回 sort_order 或
 * project_id 实际变化（或被显式标记为移动，跨组时 sort_order 可能巧合不变）的项。
 */
export function sortOrderDiff(papers: Paper[], movedIds: number[] = []): PaperOrderPatch[] {
  const moved = new Set(movedIds)
  const out: PaperOrderPatch[] = []
  papers.forEach((p, i) => {
    if (p.sort_order !== i || moved.has(p.id)) {
      out.push({ id: p.id, sort_order: i, project_id: p.project_id })
    }
  })
  return out
}

/** 收藏分区钳制：收藏只能在收藏区，非收藏只能在非收藏区（见计划 4.2.2） */
export function clampInsertIndexByFav(tgtItems: Paper[], moved: Paper, rawIdx: number): number {
  if (tgtItems.length === 0) return 0
  const favCount = tgtItems.filter((p) => p.is_favorite).length
  const movedInTgt = tgtItems.some((p) => p.id === moved.id)
  const effFav = movedInTgt && moved.is_favorite ? favCount - 1 : favCount
  const clamped = Math.max(0, Math.min(rawIdx, tgtItems.length))
  if (moved.is_favorite) {
    const maxRaw = movedInTgt ? effFav + 1 : effFav
    return Math.min(clamped, maxRaw)
  } else {
    const minRaw = effFav
    return Math.max(clamped, minRaw)
  }
}

/**
 * 跨组移动：源组移除、目标组插入 insertIndex（越界自动收敛到组尾），
 * 两组均重排为连续 sort_order（0..n-1）。project_id 由调用方随后指定。
 */
export function moveAcrossGroups(
  source: Paper[],
  target: Paper[],
  paperId: number,
  insertIndex: number,
): { source: Paper[]; target: Paper[] } {
  const from = source.findIndex((p) => p.id === paperId)
  if (from === -1) return { source, target }
  const moved = source[from]
  const nextSource = source
    .filter((_, i) => i !== from)
    .map((p, i) => ({ ...p, sort_order: i }))
  const to = Math.max(0, Math.min(insertIndex, target.length))
  const nextTarget = [...target.slice(0, to), moved, ...target.slice(to)].map((p, i) => ({
    ...p,
    sort_order: i,
  }))
  return { source: nextSource, target: nextTarget }
}
