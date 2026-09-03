// 全局页签状态：文库 / 生词复习 / 设置 / 论文阅读器四类页签 + 每账号持久化 +
// 解析态 PDF 文档 LRU 缓存。活动态由当前路由派生（TabBar/AppShell 比对 location），
// store 不持有活动指针；固定类页签全应用单实例，论文页签按 paperId 去重。
//
// 所有权不变式（PDF 文档）：一个 PDFDocumentProxy 任意时刻至多被一处持有
//（显示中 / 缓存）——takeDoc 命中即移除；卸载时按"页签仍开 → stash /
// 页签已关 → destroy"二选一归还。
import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Paper } from '../api/types'
import { useCompareStore } from './compareStore'
import {
  MAX_TABS,
  decideReaderOpen,
  routeAfterClose,
  sanitizeTabs,
  tabIdFromPath,
  type AppTab,
  type OpenPaperInput,
  type TabKind,
} from '../features/reader/tabOps'

// ── 解析态文档缓存（LRU，上限 3）────────────────────────────
const DOC_CACHE_MAX = 3
const docCache = new Map<number, PDFDocumentProxy>() // Map 有序 = LRU 序

function destroyDoc(doc: PDFDocumentProxy) {
  try {
    // pdfjs 6 类型未暴露 destroy（运行时存在），与 ReaderPage 既有 cast 口径一致
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch(() => {})
  } catch {
    /* 世代竞态下 sendWithPromise 可能已空指针，静默 */
  }
}

/** 取出（take 语义）：命中即从缓存移除并返回 */
export function takeDoc(pid: number): PDFDocumentProxy | null {
  const doc = docCache.get(pid) ?? null
  if (doc) docCache.delete(pid)
  return doc
}

/** 存回缓存：同 pid 先丢弃旧条目；超容淘汰最旧并销毁 */
export function stashDoc(pid: number, doc: PDFDocumentProxy): void {
  const prev = docCache.get(pid)
  if (prev && prev !== doc) destroyDoc(prev)
  docCache.delete(pid)
  docCache.set(pid, doc)
  while (docCache.size > DOC_CACHE_MAX) {
    const oldestKey = docCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = docCache.get(oldestKey)
    docCache.delete(oldestKey)
    if (oldest) destroyDoc(oldest)
  }
}

/** 取出并销毁（关论文页签时释放缓存文档） */
export function dropDoc(pid: number): void {
  const doc = docCache.get(pid)
  if (doc) {
    docCache.delete(pid)
    destroyDoc(doc)
  }
}

export function clearDocs(): void {
  for (const doc of docCache.values()) destroyDoc(doc)
  docCache.clear()
}

// ── 页签状态 ────────────────────────────────────────────────

// ── 页签状态 ────────────────────────────────────────────────
// 持久化形态：localStorage `pl_tabs_v2_{userId}` = {tabs}
function lsKey(userId: number) {
  return `pl_tabs_v2_${userId}`
}

function persist(userId: number | null, tabs: AppTab[]) {
  if (userId == null) return
  try {
    localStorage.setItem(lsKey(userId), JSON.stringify({ tabs }))
  } catch {
    /* 隐私模式/配额满：静默降级为会话内页签 */
  }
}

function touchPersist(s: { hydratedFor: number | null; tabs: AppTab[] }) {
  persist(s.hydratedFor, s.tabs)
}

/** 每页签视图快照（论文切换间保留缩放） */
interface TabView {
  scale?: number
}

const tabViews = new Map<number, TabView>()

export function getView(pid: number): TabView {
  return tabViews.get(pid) ?? {}
}

interface AppTabsState {
  tabs: AppTab[]
  /** 已为哪个 userId hydrate（null = 未） */
  hydratedFor: number | null
  /** 打开论文页签：去重激活（true，不新增）；满容拒绝（false，调用方不导航） */
  openReaderTab: (paper: OpenPaperInput) => boolean
  /** 打开固定类页签：单实例去重（存在即保持，不存在则追加） */
  openKindTab: (kind: Exclude<TabKind, 'reader'>) => void
  /** 路由 → 页签对账（AppShell 同步 effect 用）：已有页签保持；缺失则补建
   *（固定类直接建；论文页签补占位标题，元数据由 ReaderPage 加载后 rename 修正） */
  ensureFromPath: (path: string) => void
  /** 关闭页签：论文页签联动释放缓存文档；页签清空自动补文库页签。
   *  返回关闭后应导航的路由（关闭非当前页签时为 null） */
  closeTab: (id: string, currentId: string | null) => string | null
  /** ReaderPage 加载成功后回填论文页签元数据 */
  rename: (pid: number, patch: { title?: string; fileType?: 'pdf' | 'markdown' }) => void
  touchView: (pid: number, view: TabView) => void
  /** 关闭指定论文的阅读器页签（删除论文联动） */
  closeReaderTab: (pid: number) => void
  hydrate: (userId: number) => void
  clearMemory: () => void
}

export const useReaderTabs = create<AppTabsState>((set, get) => ({
  tabs: [],
  hydratedFor: null,

  openReaderTab: (paper) => {
    const d = decideReaderOpen(get().tabs, paper)
    if (d.op === 'activate') return true
    if (d.op === 'full') return false
    set({ tabs: [...get().tabs, d.tab] })
    touchPersist(get())
    return true
  },

  openKindTab: (kind) => {
    if (get().tabs.some((t) => t.kind === kind)) return
    if (get().tabs.length >= MAX_TABS) return
    const titles: Record<Exclude<TabKind, 'reader'>, string> = {
      library: '文库',
      review: '生词复习',
      settings: '设置',
    }
    set({ tabs: [...get().tabs, { id: kind, kind, title: titles[kind] }] })
    touchPersist(get())
  },

  ensureFromPath: (path) => {
    const id = tabIdFromPath(path)
    if (!id) return
    if (get().tabs.some((t) => t.id === id)) return
    if (id === 'library') get().openKindTab('library')
    else if (id === 'review') get().openKindTab('review')
    else if (id === 'settings') get().openKindTab('settings')
    else {
      const pid = Number(id.slice('reader-'.length))
      if (get().tabs.length >= MAX_TABS) return // 满容：不建页签（入口处已预检，此处仅兜底）
      set({ tabs: [...get().tabs, { id, kind: 'reader', title: '…', paperId: pid, fileType: 'pdf' }] })
      touchPersist(get())
    }
  },

  closeTab: (id, currentId) => {
    const tabs = get().tabs
    if (!tabs.some((t) => t.id === id)) return null
    const closed = tabs.find((t) => t.id === id)!
    if (closed.kind === 'reader' && closed.paperId != null) {
      // 显示中文档按所有权不变式不在缓存中，其销毁由 ReaderPage 卸载清理负责
      dropDoc(closed.paperId)
      tabViews.delete(closed.paperId)
    }
    let next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) next = [{ id: 'library', kind: 'library', title: '文库' }]
    set({ tabs: next })
    touchPersist(get())
    return routeAfterClose(tabs, id, currentId)
  },

  rename: (pid, patch) => {
    const tabs = get().tabs
    const idx = tabs.findIndex((t) => t.kind === 'reader' && t.paperId === pid)
    if (idx < 0) return
    const cur = tabs[idx]
    const next = tabs.slice()
    next[idx] = {
      ...cur,
      title: patch.title !== undefined ? patch.title : cur.title,
      fileType: patch.fileType !== undefined ? patch.fileType : cur.fileType,
    }
    set({ tabs: next })
    touchPersist(get())
  },

  touchView: (pid, view) => {
    tabViews.set(pid, { ...getView(pid), ...view })
  },

  closeReaderTab: (pid) => {
    const t = get().tabs.find((x) => x.kind === 'reader' && x.paperId === pid)
    if (t) get().closeTab(t.id, null)
  },

  hydrate: (userId) => {
    const { hydratedFor } = get()
    if (hydratedFor === userId) return
    if (hydratedFor != null && hydratedFor !== userId) {
      // switchAccount：清内存与文档缓存（旧账号文档不得跨账号滞留），对照一并退出
      clearDocs()
      tabViews.clear()
      useCompareStore.getState().setPaper(null)
    }
    let restored: AppTab[] = []
    try {
      const raw = localStorage.getItem(lsKey(userId))
      if (raw) restored = sanitizeTabs(JSON.parse(raw))
    } catch {
      /* 损坏数据按空页签处理 */
    }
    // 非空不变式：空恢复（新账号/损坏数据）补文库页签，避免
    // AppShell ensure effect 已跑过后 hydrate 覆盖为空导致页签栏空白
    if (restored.length === 0) restored = [{ id: 'library', kind: 'library', title: '文库' }]
    set({ tabs: restored, hydratedFor: userId })
  },

  clearMemory: () => {
    clearDocs()
    tabViews.clear()
    // 复位 hydratedFor：同账号登出→再登录时重新读盘恢复页签
    set({ tabs: [], hydratedFor: null })
  },
}))

/** 指定论文的阅读器页签是否仍开着（ReaderPage 卸载清理的归还判据） */
export function hasReaderTab(pid: number): boolean {
  return useReaderTabs.getState().tabs.some((t) => t.kind === 'reader' && t.paperId === pid)
}

/** 文库打开入口的 Paper 适配（Paper 含多余字段，结构兼容 OpenPaperInput） */
export function paperToTabInput(p: Paper): OpenPaperInput {
  return { id: p.id, title: p.title, file_type: p.file_type ?? 'pdf' }
}
