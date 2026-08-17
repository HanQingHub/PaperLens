// UI 布局状态：侧栏折叠、右侧面板
import { create } from 'zustand'

export type RightPanelTab = 'annotations' | 'review' | 'stats' | 'glossary' | null

interface UiState {
  sidebarCollapsed: boolean
  rightTab: RightPanelTab
  toggleSidebar: () => void
  openPanel: (tab: Exclude<RightPanelTab, null>) => void
  closePanel: () => void
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: localStorage.getItem('pl_sidebar') === '1',
  rightTab: null,
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('pl_sidebar', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  openPanel: (tab) => set((s) => ({ rightTab: s.rightTab === tab ? null : tab })),
  closePanel: () => set({ rightTab: null }),
}))
