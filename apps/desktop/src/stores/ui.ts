// UI 布局状态：侧栏折叠、右侧面板
import { create } from 'zustand'

export type RightPanelTab = 'annotations' | 'stats' | 'glossary' | 'words' | null

interface UiState {
  sidebarCollapsed: boolean
  isSidebarAnimating: boolean
  rightTab: RightPanelTab
  toggleSidebar: () => void
  setSidebarAnimating: (v: boolean) => void
  openPanel: (tab: Exclude<RightPanelTab, null>) => void
  closePanel: () => void
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: localStorage.getItem('pl_sidebar') === '1',
  isSidebarAnimating: false,
  rightTab: null,
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('pl_sidebar', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  setSidebarAnimating: (v) => set({ isSidebarAnimating: v }),
  openPanel: (tab) => set((s) => ({ rightTab: s.rightTab === tab ? null : tab })),
  closePanel: () => set({ rightTab: null }),
}))
