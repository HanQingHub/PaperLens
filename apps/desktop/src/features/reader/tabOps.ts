// 全局页签纯决策函数（与 store/存储解耦，便于 node 环境单测）。
// 页签 = 浏览器式全局页签：文库 / 生词复习 / 设置 / 论文阅读器四类；
// 固定类页签（文库/复习/设置）全应用至多一个（重复点击激活已有），
// 论文页签按 paperId 去重；活动态由当前路由派生（store 不持有活动指针）。

export type TabKind = 'library' | 'review' | 'settings' | 'reader'

export interface AppTab {
  /** 稳定标识：固定类 = kind；论文页签 = `reader-${paperId}` */
  id: string
  kind: TabKind
  title: string
  /** reader 页签专用 */
  paperId?: number
  fileType?: 'pdf' | 'markdown'
}

export const MAX_TABS = 12

/** 路由 → 页签 id（未知路由返回 null，不建页签） */
export function tabIdFromPath(path: string): string | null {
  if (path === '/' || path === '') return 'library'
  if (path === '/review' || path === '/review/') return 'review'
  if (path === '/settings' || path === '/settings/') return 'settings'
  const m = /^\/reader\/(\d+)(?:\/)?$/.exec(path)
  if (!m) return null
  // 归一前导零（/reader/042 → reader-42），与 paperTabId 口径一致；
  // 非正整数直接视为未知路由，不建页签
  const num = Number(m[1])
  if (!Number.isInteger(num) || num <= 0) return null
  return paperTabId(num)
}

export function routeOf(tab: AppTab): string {
  switch (tab.kind) {
    case 'library':
      return '/'
    case 'review':
      return '/review'
    case 'settings':
      return '/settings'
    default:
      // 防御：paperId 缺失/非法时回文库，杜绝 /reader/undefined 坏路由
      if (!Number.isInteger(tab.paperId) || (tab.paperId as number) <= 0) return '/'
      return `/reader/${tab.paperId}`
  }
}

/** 固定类页签（全应用单实例） */
export function isFixedKind(kind: TabKind): boolean {
  return kind !== 'reader'
}

/** 论文页签入参（Paper 的结构子集） */
export interface OpenPaperInput {
  id: number
  title: string
  file_type: 'pdf' | 'markdown'
}

export function paperTabId(paperId: number): string {
  return `reader-${paperId}`
}

/** 打开论文页签决策：去重激活（true，不新增）> 满容拒绝（false）> 新建 */
export function decideReaderOpen(
  tabs: AppTab[],
  paper: OpenPaperInput,
): { op: 'activate' } | { op: 'full' } | { op: 'append'; tab: AppTab } {
  const id = paperTabId(paper.id)
  if (tabs.some((t) => t.id === id)) return { op: 'activate' }
  if (tabs.length >= MAX_TABS) return { op: 'full' }
  return {
    op: 'append',
    tab: { id, kind: 'reader', title: paper.title, paperId: paper.id, fileType: paper.file_type },
  }
}

/** 关闭页签后的去向路由：关闭的是当前路由页签 → 右邻优先、左邻兜底；
 *  关闭非当前页签 → null（不导航）。兜底空页签由 store 处理。 */
export function routeAfterClose(tabs: AppTab[], closedId: string, currentId: string | null): string | null {
  if (closedId !== currentId) return null
  const i = tabs.findIndex((t) => t.id === closedId)
  if (i < 0) return null
  const next = tabs[i + 1] ?? tabs[i - 1]
  return next ? routeOf(next) : '/'
}

/** 持久化数据合法性过滤（未知 kind/非整数 paperId 丢弃、超上限截断） */
export function sanitizeTabs(raw: unknown): AppTab[] {
  const obj = (raw ?? {}) as { tabs?: unknown }
  const list = Array.isArray(obj.tabs) ? obj.tabs : []
  const tabs: AppTab[] = []
  for (const item of list) {
    const t = item as Partial<AppTab>
    if (t.kind !== 'library' && t.kind !== 'review' && t.kind !== 'settings' && t.kind !== 'reader') continue
    // 论文页签仅接受正整数 paperId（3.5/-1/0/NaN 一律丢弃，防孤儿占位耗 MAX_TABS）
    const id = t.kind === 'reader' ? (typeof t.paperId === 'number' && Number.isInteger(t.paperId) && t.paperId > 0 ? paperTabId(t.paperId) : null) : t.kind
    if (!id) continue
    if (tabs.some((x) => x.id === id)) continue // 固定类去重
    tabs.push({
      id,
      kind: t.kind,
      title: typeof t.title === 'string' ? t.title : '…',
      paperId: t.kind === 'reader' ? (t.paperId as number) : undefined,
      fileType: t.fileType === 'markdown' ? 'markdown' : t.kind === 'reader' ? 'pdf' : undefined,
    })
    if (tabs.length >= MAX_TABS) break
  }
  return tabs
}
