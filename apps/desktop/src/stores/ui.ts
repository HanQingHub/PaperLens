// UI 布局状态：侧栏折叠、右侧面板、复习大界面标签
//（全局页签落地后论文导航由 readerTabs 持有，旧 lastPaperId 会话记忆已删除）
import { create } from 'zustand'

export type RightPanelTab = 'annotations' | 'stats' | 'glossary' | null
export type ReviewTab = 'review' | 'library'

interface UiState {
  sidebarCollapsed: boolean
  rightTab: RightPanelTab
  /** 复习大界面当前标签：复习卡片 / 词库管理（侧栏与阅读器入口经 openReview 预设） */
  reviewTab: ReviewTab
  toggleSidebar: () => void
  openPanel: (tab: Exclude<RightPanelTab, null>) => void
  closePanel: () => void
  openReview: (tab: ReviewTab) => void
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: localStorage.getItem('pl_sidebar') === '1',
  rightTab: null,
  reviewTab: 'review',
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('pl_sidebar', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  openPanel: (tab) => set((s) => ({ rightTab: s.rightTab === tab ? null : tab })),
  closePanel: () => set({ rightTab: null }),
  openReview: (tab) => set({ reviewTab: tab }),
}))
