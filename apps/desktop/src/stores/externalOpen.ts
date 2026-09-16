// 文件关联打开队列：shell 启动参数/单实例回调注入的 PDF 路径。
// 队列只进不出（消费方 shift），处理中标志串行化消费——
// 同一路径重复入队由服务端 hash 去重兜底（复用既有 Paper）。
// 纯内存态，无 localStorage（禁止被 node 环境单测间接引入的模块读浏览器 API）。
import { create } from 'zustand'

interface ExternalOpenState {
  queue: string[]
  processing: boolean
  push: (paths: string[]) => void
  shift: () => string | undefined
  setProcessing: (v: boolean) => void
}

export const useExternalOpen = create<ExternalOpenState>((set, get) => ({
  queue: [],
  processing: false,
  push: (paths) => {
    if (paths.length === 0) return
    set((s) => ({ queue: [...s.queue, ...paths] }))
  },
  shift: () => {
    const q = get().queue
    if (q.length === 0) return undefined
    set({ queue: q.slice(1) })
    return q[0]
  },
  setProcessing: (v) => set({ processing: v }),
}))
