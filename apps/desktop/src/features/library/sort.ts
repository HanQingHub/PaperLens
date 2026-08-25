// 文库视图排序决策：视图 → 实际请求后端的排序键。
// all/favorite 尊重用户下拉选择；recent 恒按最近打开；project（分组浏览）
// 恒为 manual——sort_order 是项目内手动顺序的唯一权威，系统排序不得覆盖。
export type LibraryView = 'all' | 'favorite' | 'recent' | 'project'
export type SortKey = 'created' | 'title' | 'last_opened'

export function resolveSort(view: LibraryView, sort: SortKey): 'created' | 'title' | 'last_opened' | 'manual' {
  switch (view) {
    case 'recent':
      return 'last_opened'
    case 'project':
      return 'manual'
    default:
      return sort
  }
}
