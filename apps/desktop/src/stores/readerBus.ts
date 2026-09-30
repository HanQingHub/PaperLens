// 阅读器事件总线：右侧面板 ↔ 阅读器的跨模块通信（定位批注、刷新数据）
import { create } from 'zustand'

/** 在途批注操作注册表（笔迹落库 POST / 擦除 DELETE）：撤回/清除执行前必须等其
 *  全部落定——否则按 store 快照计算目标会漏掉在途新笔（撤回错删上一笔/清除漏删），
 *  或在 DELETE 提交前重拉 GET 使已擦笔复活。模块级存放：非渲染态，不进 zustand。 */
const pendingInkOps = new Set<Promise<unknown>>()

/** 注册在途批注操作，返回原 promise（链式调用无感）。计数同步进 bus：
 *  工具条据此在落库窗口内保持撤回/清除按钮可点（首笔 POST 在途时 store 尚无
 *  笔迹，仅按已落库计数启用会让按钮灰死、settle 协调无从触发）。 */
export function trackInkOp<T>(p: Promise<T>): Promise<T> {
  pendingInkOps.add(p)
  useReaderBus.setState((s) => ({ inkOpsInFlight: s.inkOpsInFlight + 1 }))
  return p.finally(() => {
    pendingInkOps.delete(p)
    useReaderBus.setState((s) => ({ inkOpsInFlight: s.inkOpsInFlight - 1 }))
  })
}

/** 等待全部在途批注操作落定：等待期间新注册的（连笔）继续等，直至静止 */
export async function settleInkOps(): Promise<void> {
  while (pendingInkOps.size > 0) await Promise.allSettled([...pendingInkOps])
}

interface ReaderBusState {
  paperId: number | null
  /** 由 ReaderPage 注册；面板调用 locateAnnotation 触发跳转 */
  gotoRef: ((pageNo: number, annotationId?: number) => void) | null
  registerGoto: (fn: ((pageNo: number, annotationId?: number) => void) | null) => void
  locateAnnotation: (annotationId: number, pageNo: number) => void
  /** 批注数据版本号：阅读器写入批注后 bump，面板监听刷新 */
  annotationsVersion: number
  bumpAnnotations: () => void
  /** 在途笔迹操作数（trackInkOp 注册/落定同步增减）：工具条据此在落库窗口内保持撤回/清除可点 */
  inkOpsInFlight: number
  /** 术语表版本号 */
  glossaryVersion: number
  bumpGlossary: () => void
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
  inkOpsInFlight: 0,
  glossaryVersion: 0,
  bumpGlossary: () => set((s) => ({ glossaryVersion: s.glossaryVersion + 1 })),
}))
