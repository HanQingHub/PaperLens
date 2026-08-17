// 阅读器事件总线：右侧面板 ↔ 阅读器的跨模块通信（定位批注、刷新数据）
import { create } from 'zustand'

interface ReaderBusState {
  paperId: number | null
  /** 由 ReaderPage 注册；面板调用 locateAnnotation 触发跳转 */
  gotoRef: ((pageNo: number, annotationId?: number) => void) | null
  registerGoto: (fn: ((pageNo: number, annotationId?: number) => void) | null) => void
  locateAnnotation: (annotationId: number, pageNo: number) => void
  /** 批注数据版本号：阅读器写入批注后 bump，面板监听刷新 */
  annotationsVersion: number
  bumpAnnotations: () => void
  /** 术语表版本号 */
  glossaryVersion: number
  bumpGlossary: () => void
  /** 生词库版本号（新增生词后 bump） */
  wordsVersion: number
  bumpWords: () => void
}

export const useReaderBus = create<ReaderBusState>((set, get) => ({
  paperId: null,
  gotoRef: null,
  registerGoto: (fn) => set({ gotoRef: fn }),
  locateAnnotation: (annotationId, pageNo) => {
    get().gotoRef?.(pageNo, annotationId)
  },
  annotationsVersion: 0,
  bumpAnnotations: () => set((s) => ({ annotationsVersion: s.annotationsVersion + 1 })),
  glossaryVersion: 0,
  bumpGlossary: () => set((s) => ({ glossaryVersion: s.glossaryVersion + 1 })),
  wordsVersion: 0,
  bumpWords: () => set((s) => ({ wordsVersion: s.wordsVersion + 1 })),
}))
