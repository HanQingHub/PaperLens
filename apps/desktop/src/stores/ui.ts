// UI 布局状态：侧栏折叠、右侧面板、最近打开的论文（内存态，重启即清，供侧栏文库恢复）
import { create } from 'zustand'

export type RightPanelTab = 'annotations' | 'stats' | 'glossary' | 'words' | null

interface UiState {
  sidebarCollapsed: boolean
  rightTab: RightPanelTab
  /** 本次会话最近打开的论文 id（仅内存，不持久化；重启后从文库导航进列表而非恢复论文） */
  lastPaperId: number | null
  toggleSidebar: () => void
  openPanel: (tab: Exclude<RightPanelTab, null>) => void
  closePanel: () => void
  setLastPaper: (id: number) => void
  clearLastPaper: () => void
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: localStorage.getItem('pl_sidebar') === '1',
  rightTab: null,
  lastPaperId: null,
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('pl_sidebar', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  openPanel: (tab) => set((s) => ({ rightTab: s.rightTab === tab ? null : tab })),
  closePanel: () => set({ rightTab: null }),
  setLastPaper: (id) => set({ lastPaperId: id }),
  clearLastPaper: () => set({ lastPaperId: null }),
}))
