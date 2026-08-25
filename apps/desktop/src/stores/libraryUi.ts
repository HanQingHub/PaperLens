// 文库页 UI 态：跨路由存活（进阅读器/设置往返不丢失浏览现场）；view 另持久化 pl_view 跨重启。
// 注意：模块作用域读 localStorage，禁止被 node 环境单测间接引入。
import { create } from 'zustand'
import type { LibraryView, SortKey } from '../features/library/sort'
import type { GroupKey } from '../features/library/dnd/types'

const VIEWS: LibraryView[] = ['all', 'project', 'recent', 'favorite']

const stored = localStorage.getItem('pl_view')
const initialView = VIEWS.includes(stored as LibraryView) ? (stored as LibraryView) : 'all'

interface LibraryUiState {
  view: LibraryView
  selectedProjectId: number | null
  qInput: string
  sort: SortKey
  expanded: Set<GroupKey>
  scrollTop: number
  setView: (v: LibraryView) => void
  setSelectedProjectId: (id: number | null) => void
  setQInput: (q: string) => void
  setSort: (s: SortKey) => void
  toggleExpanded: (key: GroupKey) => void
  setScrollTop: (top: number) => void
}

export const useLibraryUi = create<LibraryUiState>((set) => ({
  view: initialView,
  selectedProjectId: null,
  qInput: '',
  sort: 'created',
  expanded: new Set(),
  scrollTop: 0,
  setView: (v) => {
    localStorage.setItem('pl_view', v)
    set({ view: v })
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setQInput: (q) => set({ qInput: q }),
  setSort: (s) => set({ sort: s }),
  toggleExpanded: (key) =>
    set((st) => {
      const n = new Set(st.expanded)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return { expanded: n }
    }),
  setScrollTop: (top) => set({ scrollTop: top }),
}))
