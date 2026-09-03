// 全局页签纯函数测试：论文页签决策 / 关闭去向路由 / 持久化数据清洗 / 路由映射
import { describe, expect, it } from 'vitest'
import {
  decideReaderOpen,
  routeAfterClose,
  sanitizeTabs,
  tabIdFromPath,
  routeOf,
  paperTabId,
  MAX_TABS,
  type AppTab,
} from '../features/reader/tabOps'

const T = (id: string, kind: AppTab['kind'], extra: Partial<AppTab> = {}): AppTab => ({
  id,
  kind,
  title: `t-${id}`,
  ...extra,
})

describe('tabIdFromPath', () => {
  it('四类路由映射', () => {
    expect(tabIdFromPath('/')).toBe('library')
    expect(tabIdFromPath('')).toBe('library')
    expect(tabIdFromPath('/review')).toBe('review')
    expect(tabIdFromPath('/settings')).toBe('settings')
    expect(tabIdFromPath('/reader/42')).toBe('reader-42')
  })

  it('尾斜杠归一（review/settings/reader 一致）', () => {
    expect(tabIdFromPath('/review/')).toBe('review')
    expect(tabIdFromPath('/settings/')).toBe('settings')
    expect(tabIdFromPath('/reader/42/')).toBe('reader-42')
  })

  it('前导零归一（/reader/042 → reader-42，与 paperTabId 同口径）', () => {
    expect(tabIdFromPath('/reader/042')).toBe('reader-42')
  })

  it('未知路由 → null', () => {
    expect(tabIdFromPath('/reader/abc')).toBeNull()
    expect(tabIdFromPath('/reader/0')).toBeNull()
    expect(tabIdFromPath('/reader/-1')).toBeNull()
    expect(tabIdFromPath('/unknown')).toBeNull()
  })
})

describe('routeOf', () => {
  it('kind → 路由', () => {
    expect(routeOf({ id: 'library', kind: 'library', title: '' })).toBe('/')
    expect(routeOf({ id: 'review', kind: 'review', title: '' })).toBe('/review')
    expect(routeOf({ id: 'settings', kind: 'settings', title: '' })).toBe('/settings')
    expect(routeOf(T('reader-7', 'reader', { paperId: 7 }))).toBe('/reader/7')
  })

  it('论文页签 paperId 非法 → 回文库（杜绝 /reader/undefined）', () => {
    expect(routeOf(T('reader-x', 'reader'))).toBe('/')
    expect(routeOf(T('reader-x', 'reader', { paperId: 3.5 }))).toBe('/')
  })
})

describe('decideReaderOpen', () => {
  it('已开 → 激活（去重，不新增）', () => {
    const tabs = [T('library', 'library'), T('reader-1', 'reader', { paperId: 1 })]
    expect(decideReaderOpen(tabs, { id: 1, title: 'x', file_type: 'pdf' })).toEqual({ op: 'activate' })
  })

  it('未开 → 新建（id/kind/fileType 正确）', () => {
    const d = decideReaderOpen([T('library', 'library')], { id: 9, title: 'x', file_type: 'markdown' })
    expect(d).toEqual({
      op: 'append',
      tab: { id: 'reader-9', kind: 'reader', title: 'x', paperId: 9, fileType: 'markdown' },
    })
  })

  it('满容 → full', () => {
    const tabs = Array.from({ length: MAX_TABS }, (_, i) => T(`reader-${i}`, 'reader', { paperId: i }))
    expect(decideReaderOpen(tabs, { id: 99, title: 'x', file_type: 'pdf' })).toEqual({ op: 'full' })
  })

  it('满容但命中已有 → 仍激活', () => {
    const tabs = Array.from({ length: MAX_TABS }, (_, i) => T(`reader-${i}`, 'reader', { paperId: i }))
    expect(decideReaderOpen(tabs, { id: 3, title: 'x', file_type: 'pdf' })).toEqual({ op: 'activate' })
  })
})

describe('routeAfterClose', () => {
  const tabs = [T('library', 'library'), T('reader-1', 'reader', { paperId: 1 }), T('reader-2', 'reader', { paperId: 2 })]

  it('关闭当前页签 → 右邻路由', () => {
    expect(routeAfterClose(tabs, 'reader-1', 'reader-1')).toBe('/reader/2')
  })

  it('关闭最后一个 → 左邻', () => {
    expect(routeAfterClose(tabs, 'reader-2', 'reader-2')).toBe('/reader/1')
  })

  it('关闭非当前页签 → null（不导航）', () => {
    expect(routeAfterClose(tabs, 'reader-2', 'library')).toBeNull()
  })

  it('当前页签不在列表 → null', () => {
    expect(routeAfterClose(tabs, 'reader-9', 'reader-9')).toBeNull()
  })
})

describe('sanitizeTabs', () => {
  it('过滤非法条目、固定类去重、修复 id/fileType', () => {
    const r = sanitizeTabs({
      tabs: [
        { id: 'library', kind: 'library', title: '文库' },
        { kind: 'review', title: '生词复习' }, // 缺 id：固定类按 kind 重建
        { kind: 'library', title: 'dup' }, // 固定类重复 → 丢弃
        { kind: 'reader', paperId: 3, title: 'c', fileType: 'markdown' },
        { kind: 'reader', paperId: 'bad', title: 'd' }, // paperId 非法 → 丢弃
        { kind: 'reader', paperId: 3.5, title: 'f' }, // 非整数 → 丢弃
        { kind: 'reader', paperId: -1, title: 'g' }, // 非正整数 → 丢弃
        { kind: 'reader', paperId: 0, title: 'h' }, // 非正整数 → 丢弃
        { kind: 'weird', title: 'e' }, // 未知 kind → 丢弃
      ],
    })
    expect(r).toEqual([
      { id: 'library', kind: 'library', title: '文库', paperId: undefined, fileType: undefined },
      { id: 'review', kind: 'review', title: '生词复习', paperId: undefined, fileType: undefined },
      { id: paperTabId(3), kind: 'reader', title: 'c', paperId: 3, fileType: 'markdown' },
    ])
  })

  it('非数组/空输入 → 空页签', () => {
    expect(sanitizeTabs(null)).toEqual([])
    expect(sanitizeTabs({ tabs: 'x' })).toEqual([])
  })
})
