// 词库列表数据变换：过滤 / 排序 / 概览统计 / 分页（纯函数，供词库视图与单测使用）
import type { Word } from '../../api/types'

export type WordSortKey = 'added' | 'lemma' | 'due' | 'reviews'

export function filterWords(
  words: Word[],
  opts: { q?: string; stage?: 0 | 1 | 2 | null; group?: string | null },
): Word[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  return words.filter((w) => {
    if (opts.stage != null && w.stage !== opts.stage) return false
    // group 语义与服务端 api/words.py list_words 对齐：null=全部；''=未分组（NULL 或 ''）；其他=精确匹配
    if (opts.group != null) {
      const g = w.group_name ?? ''
      if (opts.group === '' ? g !== '' : g !== opts.group) return false
    }
    if (q) {
      const hay = `${w.lemma.toLowerCase()}\n${(w.translation ?? '').toLowerCase()}`
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export function sortWords(words: Word[], key: WordSortKey): Word[] {
  const list = [...words]
  if (key === 'lemma') {
    list.sort((a, b) => a.lemma.localeCompare(b.lemma))
  } else if (key === 'reviews') {
    list.sort((a, b) => b.review_count - a.review_count)
  } else if (key === 'due') {
    // due_at 运行时可为 null（未复习词），沉底
    const t = (w: Word) => (w.due_at ? Date.parse(w.due_at) : Number.POSITIVE_INFINITY)
    list.sort((a, b) => t(a) - t(b))
  } else {
    list.sort((a, b) => b.id - a.id) // added：新收的在前
  }
  return list
}

function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 词库概览：阶段分布 + 今日到期 + 未来 7 天到期量（本地日历日，含今天；与 stats_service 的本地时区口径一致） */
export function libraryStats(words: Word[], now: Date): {
  total: number
  stage0: number
  stage1: number
  stage2: number
  dueToday: number
  forecast: { date: string; count: number }[]
} {
  let stage0 = 0
  let stage1 = 0
  let stage2 = 0
  let dueToday = 0
  const counts = [0, 0, 0, 0, 0, 0, 0]
  const indexByDate = new Map<string, number>()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    indexByDate.set(dateKey(d), i)
  }
  for (const w of words) {
    if (w.stage === 0) stage0++
    else if (w.stage === 1) stage1++
    else stage2++
    if (w.stage >= 2 || !w.due_at) continue
    const t = Date.parse(w.due_at)
    if (Number.isNaN(t)) continue
    if (t <= now.getTime()) dueToday++
    const i = indexByDate.get(dateKey(new Date(t)))
    if (i != null) counts[i]++
  }
  const forecast: { date: string; count: number }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    forecast.push({ date: dateKey(d), count: counts[i] })
  }
  return { total: words.length, stage0, stage1, stage2, dueToday, forecast }
}

export function paginate<T>(list: T[], page: number, size: number): { rows: T[]; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { rows: list.slice((p - 1) * size, p * size), pages }
}
