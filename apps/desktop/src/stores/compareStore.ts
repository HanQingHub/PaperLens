// 双论文对照模式状态（会话级内存态）：对照论文 + 窗格宽度占比。
// 切换阅读器标签时保留（对照关系跨标签存活）；离开阅读器路由时组件卸载销毁
// 文档，状态保留 → 重回自动重建；登出/账号切换由 App 层清空。
import { create } from 'zustand'
import type { Paper } from '../api/types'

/** 主窗格宽度占比，钳制 0.3~0.7 */
export const clampRatio = (r: number) => Math.max(0.3, Math.min(0.7, r))

interface CompareState {
  paperId: number | null
  paper: Paper | null
  ratio: number
  setPaper: (p: Paper | null) => void
  setRatio: (r: number) => void
}

export const useCompareStore = create<CompareState>((set) => ({
  paperId: null,
  paper: null,
  ratio: 0.52,
  setPaper: (p) => set({ paper: p, paperId: p?.id ?? null }),
  setRatio: (r) => set({ ratio: clampRatio(r) }),
}))
