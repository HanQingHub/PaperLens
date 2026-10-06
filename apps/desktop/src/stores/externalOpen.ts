// 文件关联打开队列：shell 启动参数/单实例回调注入的文档路径（.pdf/.md）。
// 队列只进不出（消费方 shift），处理中标志串行化消费——
// 同一路径重复入队由服务端 hash 去重兜底（复用既有 Paper）。
// 纯内存态，无 localStorage（禁止被 node 环境单测间接引入的模块读浏览器 API）。
import { create } from 'zustand'

// 临时阅读件（ephemeral）的会话级标记：关闭页签时据此调用删除端点。
// 服务端响应 ephemeral 双向维护（false 时 forget，覆盖"临时件升格"路径），
// 与 readerTabs 的 mdOpenedPids 同口径（切签保留、关签清除）。
const ephemeralPids = new Set<number>()

export function markEphemeral(pid: number): void {
  ephemeralPids.add(pid)
}

export function isEphemeral(pid: number): boolean {
  return ephemeralPids.has(pid)
}

export function forgetEphemeral(pid: number): void {
  ephemeralPids.delete(pid)
}

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
