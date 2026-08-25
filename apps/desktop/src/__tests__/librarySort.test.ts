// M1：文库视图排序决策矩阵
import { describe, expect, it } from 'vitest'
import { resolveSort } from '../features/library/sort'

describe('resolveSort', () => {
  it('all/favorite 视图尊重用户下拉选择', () => {
    expect(resolveSort('all', 'created')).toBe('created')
    expect(resolveSort('all', 'title')).toBe('title')
    expect(resolveSort('all', 'last_opened')).toBe('last_opened')
    expect(resolveSort('favorite', 'title')).toBe('title')
  })

  it('recent 恒按最近打开', () => {
    expect(resolveSort('recent', 'created')).toBe('last_opened')
  })

  it('project（分组浏览）恒为手动排序', () => {
    expect(resolveSort('project', 'created')).toBe('manual')
    expect(resolveSort('project', 'title')).toBe('manual')
  })
})
