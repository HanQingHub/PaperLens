// libraryData 纯函数单测：过滤 / 排序 / 概览统计 / 分页
import { describe, expect, it } from 'vitest'
import { filterWords, libraryStats, paginate, sortWords } from '../features/words/libraryData'
import type { Word } from '../api/types'

// 以本地日期构造词：due_at 走 toISOString()（UTC 串），期望值按本地日历日断言，跨时区稳定
function localIso(y: number, m: number, d: number, hour = 10): string {
  return new Date(y, m - 1, d, hour).toISOString()
}

let seq = 0
function w(partial: Partial<Word>): Word {
  seq++
  return {
    id: partial.id ?? seq,
    lemma: partial.lemma ?? `word${seq}`,
    stage: partial.stage ?? 0,
    translation: partial.translation ?? null,
    group_name: partial.group_name ?? null,
    ease: 2.5,
    interval_days: 0,
    due_at: partial.due_at ?? null,
    review_count: partial.review_count ?? 0,
    first_seen_at: '',
    last_seen_at: '',
  }
}

describe('filterWords', () => {
  const rows = [
    w({ lemma: 'Pipeline', translation: '流水线' }),
    w({ lemma: 'curriculum', translation: '课程' }),
    w({ lemma: 'abandon', group_name: null }),
    w({ lemma: 'benchmark', group_name: '' }),
    w({ lemma: 'dataset', group_name: 'NLP组', stage: 2 }),
  ]

  it('q 对 lemma 与释义做大小写无关包含匹配', () => {
    expect(filterWords(rows, { q: 'PIPE' })).toHaveLength(1)
    expect(filterWords(rows, { q: '课程' })).toHaveLength(1)
    expect(filterWords(rows, { q: '  pipeline  ' })).toHaveLength(1)
  })

  it('stage 与 group 过滤', () => {
    expect(filterWords(rows, { stage: 2 })).toHaveLength(1)
    // '' = 未分组：group_name 为 null 或 '' 都算（对齐服务端 IS NULL OR ='' 语义）
    expect(filterWords(rows, { group: '' })).toHaveLength(4)
    expect(filterWords(rows, { group: 'NLP组' })).toHaveLength(1)
    expect(filterWords(rows, { group: 'nlp组' })).toHaveLength(0) // 精确匹配
    expect(filterWords(rows, { group: null })).toHaveLength(5)
  })

  it('组合条件取交集', () => {
    expect(filterWords(rows, { q: 'set', group: 'NLP组', stage: 2 })).toHaveLength(1)
    expect(filterWords(rows, { q: 'set', group: '', stage: 0 })).toHaveLength(0)
  })
})

describe('sortWords', () => {
  const rows = [
    w({ id: 3, lemma: 'zebra', review_count: 1, due_at: localIso(2026, 8, 30) }),
    w({ id: 1, lemma: 'apple', review_count: 5, due_at: localIso(2026, 8, 28) }),
    w({ id: 2, lemma: 'mango', review_count: 3, due_at: null }),
  ]

  it('added 按 id 倒序（新收在前）', () => {
    expect(sortWords(rows, 'added').map((x) => x.id)).toEqual([3, 2, 1])
  })

  it('lemma 字母序 / reviews 次数倒序', () => {
    expect(sortWords(rows, 'lemma').map((x) => x.lemma)).toEqual(['apple', 'mango', 'zebra'])
    expect(sortWords(rows, 'reviews').map((x) => x.review_count)).toEqual([5, 3, 1])
  })

  it('due 升序且 null 沉底，不改入参', () => {
    const sorted = sortWords(rows, 'due')
    expect(sorted.map((x) => x.id)).toEqual([1, 3, 2])
    expect(rows[0].id).toBe(3)
  })
})

describe('libraryStats', () => {
  const now = new Date(2026, 7, 29, 12) // 本地 2026-08-29 12:00
  const rows = [
    w({ stage: 0, due_at: localIso(2026, 8, 29, 8) }), // 今天早上 → 到期 + 落今日桶
    w({ stage: 1, due_at: localIso(2026, 8, 31) }), // 未来 → 只落桶
    w({ stage: 0, due_at: localIso(2026, 8, 25) }), // 已过且非今日 → dueToday，桶外
    w({ stage: 2, due_at: localIso(2026, 8, 29, 1) }), // 已掌握 → 不计入到期
    w({ stage: 0, due_at: null }), // 未复习 → 跳过
    w({ stage: 2 }),
  ]

  it('阶段计数与今日到期', () => {
    const s = libraryStats(rows, now)
    expect(s.total).toBe(6)
    expect(s.stage0).toBe(3)
    expect(s.stage1).toBe(1)
    expect(s.stage2).toBe(2)
    expect(s.dueToday).toBe(2) // 今晨到期 + 过期未掌握
  })

  it('forecast 恰 7 桶、首桶为今天、按本地日历日落桶', () => {
    const s = libraryStats(rows, now)
    expect(s.forecast).toHaveLength(7)
    expect(s.forecast[0].date).toBe('2026-08-29')
    expect(s.forecast[0].count).toBe(1)
    expect(s.forecast[2].date).toBe('2026-08-31')
    expect(s.forecast[2].count).toBe(1)
    expect(s.forecast[6].date).toBe('2026-09-04')
    expect(s.forecast[6].count).toBe(0)
  })
})

describe('paginate', () => {
  it('空表返回 1 页空行', () => {
    expect(paginate([], 1, 50)).toEqual({ rows: [], pages: 1 })
  })

  it('切片与页数', () => {
    const rows = Array.from({ length: 120 }, (_, i) => i)
    expect(paginate(rows, 1, 50)).toEqual({ rows: rows.slice(0, 50), pages: 3 })
    expect(paginate(rows, 3, 50).rows).toHaveLength(20)
    expect(paginate(rows, 2, 50).rows[0]).toBe(50)
  })

  it('page 越界收敛到最后一页', () => {
    const rows = [1, 2, 3]
    expect(paginate(rows, 99, 50)).toEqual({ rows: [1, 2, 3], pages: 1 })
    expect(paginate(rows, 0, 2)).toEqual({ rows: [1, 2], pages: 2 })
  })
})
