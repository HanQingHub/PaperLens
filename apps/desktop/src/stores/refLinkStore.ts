// 参考文献回链会话状态：backward（点文献条目 → 找正文引用）/ forward（点正文引用 → 找文献条目）。
// 扫描带世代令牌（scanGen + pid 双校验）：切标签/换文档后旧扫描结果丢弃，防跨文档误跳转。
import { create } from 'zustand'
import type { PdfRect } from './readerStore'
import { useReader } from './readerStore'
import { getPageMarkers, isBibPage } from '../features/reader/refLinks'
import { toast } from '../features/shared/Toast'

export interface RefHit {
  /** 0-based 页索引 */
  page: number
  rects: PdfRect[]
}

let flashTimer = 0
function clearFlashTimer() {
  if (flashTimer) {
    window.clearTimeout(flashTimer)
    flashTimer = 0
  }
}

interface RefLinkState {
  /** 扫描归属文档 pid（世代令牌组成） */
  pid: number | null
  scanGen: number
  entryNo: number | null
  direction: 'backward' | 'forward' | null
  /** backward：正文引用命中（渐进追加，page 为 0-based） */
  hits: RefHit[]
  hitIdx: number
  /** 返回原位（pageNo 1-based + 页内比率） */
  origin: { pageNo: number; ratio: number } | null
  /** 闪烁提示（pageIndex 0-based，与 PageView 对齐） */
  flash: { pageIndex: number; rects: PdfRect[] } | null
  scanning: boolean
  /** 由 ReaderPage 注册（scrollToPosition 适配） */
  navRef: ((pageNo: number, ratio: number) => void) | null
  registerNav: (fn: ((pageNo: number, ratio: number) => void) | null) => void
  startBackward: (n: number, originPageNo: number, pid: number) => void
  startForward: (n: number, currentPageIdx: number, pid: number) => void
  nextHit: (dir: 1 | -1) => void
  goOrigin: () => void
  close: () => void
  setFlash: (pageIndex: number, rects: PdfRect[]) => void
}

export const useRefLink = create<RefLinkState>((set, get) => ({
  pid: null,
  scanGen: 0,
  entryNo: null,
  direction: null,
  hits: [],
  hitIdx: 0,
  origin: null,
  flash: null,
  scanning: false,
  navRef: null,
  registerNav: (fn) => set({ navRef: fn }),

  setFlash: (pageIndex, rects) => {
    clearFlashTimer()
    set({ flash: { pageIndex, rects } })
    flashTimer = window.setTimeout(() => {
      flashTimer = 0
      if (get().flash) set({ flash: null })
    }, 2500)
  },

  startBackward: (n, originPageNo, pid) => {
    clearFlashTimer()
    const myGen = get().scanGen + 1
    set({
      scanGen: myGen,
      pid,
      entryNo: n,
      direction: 'backward',
      hits: [],
      hitIdx: 0,
      origin: { pageNo: originPageNo, ratio: 0 },
      flash: null,
      scanning: true,
    })
    void (async () => {
      const pdf = useReader.getState().pdf
      const total = pdf?.numPages ?? 0
      for (let i = 0; i < total; i++) {
        // 世代令牌：换文档/关闭后丢弃旧扫描（三重校验）
        const st = get()
        if (st.scanGen !== myGen || st.pid !== pid || useReader.getState().paper?.id !== pid) return
        try {
          const markers = await getPageMarkers(pdf!, i)
          if (get().scanGen !== myGen || get().pid !== pid) return
          const found = markers.cites.filter((c) => c.n === n)
          if (found.length) {
            const hit: RefHit = { page: i, rects: found.flatMap((c) => c.rects) }
            const hits = [...get().hits, hit]
            set({ hits })
            if (hits.length === 1) {
              // 首次命中立即定位 + 闪烁
              get().navRef?.(i + 1, 0)
              get().setFlash(i, hit.rects)
            }
          }
        } catch {
          /* 单页扫描失败跳过 */
        }
      }
      if (get().scanGen === myGen) {
        set({ scanning: false })
        if (!get().hits.length) toast(`未在正文中找到 [${n}] 的引用`, 'error')
      }
    })()
  },

  startForward: (n, currentPageIdx, pid) => {
    clearFlashTimer()
    const myGen = get().scanGen + 1
    set({
      scanGen: myGen,
      pid,
      entryNo: n,
      direction: 'forward',
      hits: [],
      hitIdx: 0,
      origin: { pageNo: currentPageIdx + 1, ratio: 0 },
      flash: null,
      scanning: true,
    })
    void (async () => {
      const pdf = useReader.getState().pdf
      const total = pdf?.numPages ?? 0
      // 参考文献通常在后部：从当前页向后扫，未果再从头扫到当前页前
      const order: number[] = []
      for (let i = Math.max(0, currentPageIdx); i < total; i++) order.push(i)
      for (let i = 0; i < Math.min(currentPageIdx, total); i++) order.push(i)
      for (const i of order) {
        const st = get()
        if (st.scanGen !== myGen || st.pid !== pid || useReader.getState().paper?.id !== pid) return
        try {
          const markers = await getPageMarkers(pdf!, i)
          if (get().scanGen !== myGen || get().pid !== pid) return
          const rects = markers.bib.get(n)
          if (isBibPage(markers) && rects) {
            set({ scanning: false })
            get().navRef?.(i + 1, 0)
            get().setFlash(i, rects)
            return
          }
        } catch {
          /* 单页扫描失败跳过 */
        }
      }
      if (get().scanGen === myGen) {
        set({ scanning: false })
        toast(`未找到文献 [${n}]`, 'error')
      }
    })()
  },

  nextHit: (dir) => {
    const { hits, hitIdx } = get()
    if (!hits.length) return
    let i = hitIdx + dir
    if (i >= hits.length) i = 0
    if (i < 0) i = hits.length - 1
    set({ hitIdx: i })
    get().navRef?.(hits[i].page + 1, 0)
    get().setFlash(hits[i].page, hits[i].rects)
  },

  goOrigin: () => {
    const { origin } = get()
    if (origin) get().navRef?.(origin.pageNo, origin.ratio)
    get().close()
  },

  close: () => {
    clearFlashTimer()
    set((s) => ({ scanGen: s.scanGen + 1, entryNo: null, direction: null, hits: [], hitIdx: 0, origin: null, flash: null, scanning: false }))
  },
}))
