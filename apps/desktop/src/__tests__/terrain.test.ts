import { describe, expect, it } from 'vitest'
import type { Paper } from '../api/types'
import { blockHeight, layoutTerrain, projectHue, readState, rng, seedOf, terrainCols, terrainRows } from '../frontend-next/terrain'

const NOW = Date.parse('2026-11-27T12:00:00Z')

function paper(over: Partial<Paper> & { id: number }): Paper {
  return {
    project_id: null, title: `t${over.id}`, authors: null, venue: null, year: null, doi: null, arxiv_id: null,
    file_hash: `h${over.id}`, file_type: 'pdf', page_count: 10, open_count: 0, is_scanned: false,
    ocr_status: 'none', tags: [], note: null, is_favorite: false, sort_order: 0,
    created_at: '2026-11-01T00:00:00Z', last_opened_at: null, ...over,
  }
}

describe('terrain · 列行', () => {
  it('≤36 篇固定 6 列，更多时按平方根，上限 11', () => {
    expect(terrainCols(0)).toBe(6)
    expect(terrainCols(36)).toBe(6)
    expect(terrainCols(37)).toBe(7)
    expect(terrainCols(64)).toBe(8)
    expect(terrainCols(200)).toBe(11)
  })
  it('行数至少为 1', () => {
    expect(terrainRows(0)).toBe(1)
    expect(terrainRows(36)).toBe(6)
    expect(terrainRows(37)).toBe(6)
  })
})

describe('terrain · 高度', () => {
  it('缺省与负数视为 0，上限 40 条', () => {
    expect(blockHeight(undefined)).toBe(8)
    expect(blockHeight(null)).toBe(8)
    expect(blockHeight(-3)).toBe(8)
    expect(blockHeight(0)).toBe(8)
    expect(blockHeight(40)).toBe(128)
    expect(blockHeight(99)).toBe(128)
    expect(blockHeight(Number.NaN)).toBe(8)
  })
})

describe('terrain · 阅读态', () => {
  it('未打开 → unread', () => {
    expect(readState({ open_count: 0, last_opened_at: '2026-11-26T00:00:00Z' }, NOW)).toBe('unread')
  })
  it('7 天内打开 → reading；更早 → read；非法日期 → read', () => {
    expect(readState({ open_count: 2, last_opened_at: '2026-11-26T12:00:00Z' }, NOW)).toBe('reading')
    expect(readState({ open_count: 2, last_opened_at: '2026-11-19T12:00:00Z' }, NOW)).toBe('read')
    expect(readState({ open_count: 2, last_opened_at: 'not-a-date' }, NOW)).toBe('read')
    expect(readState({ open_count: 1, last_opened_at: null }, NOW)).toBe('read')
  })
})

describe('terrain · 色相与种子', () => {
  it('未分组固定 30，同一项目稳定且落在 0–359', () => {
    expect(projectHue(null)).toBe(30)
    expect(projectHue(undefined)).toBe(30)
    expect(projectHue(7)).toBe(projectHue(7))
    for (let id = 1; id < 50; id++) {
      const h = projectHue(id)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })
  it('种子与伪随机可复现', () => {
    expect(seedOf('abc')).toBe(seedOf('abc'))
    expect(seedOf('abc')).not.toBe(seedOf('abd'))
    const a = rng(42), b = rng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('terrain · 布局', () => {
  it('按顺序铺格并带上编码', () => {
    const list = Array.from({ length: 8 }, (_, i) => paper({ id: i + 1, annotation_count: i, project_id: i % 2 ? 3 : null }))
    const blocks = layoutTerrain(list, NOW)
    expect(blocks).toHaveLength(8)
    expect(blocks[0]).toMatchObject({ id: 1, col: 0, row: 0, h: 8, state: 'unread', hue: 30 })
    expect(blocks[6]).toMatchObject({ id: 7, col: 0, row: 1, h: 26 })
    expect(blocks[1].hue).toBe(projectHue(3))
  })
})
