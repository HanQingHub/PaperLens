// 缩略图导航条：全页可滑动 + 点击跳转 + 当前页高亮跟随 + 悬停放大。
// 距当前页由近及远排序首轮渲染，剩余分片后台补全；
// 大文档（>800 页）仅渲染当前±64 与轨道可视区附近，其余页码占位、悬停/滚动按需补渲。
// 串行低优先（一次一张 + requestIdleCallback/setTimeout 让出主线程）避免与主视图争抢 pdf.js worker；dataURL 缓存防重渲染。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const RAIL_W = 72
const THUMB_W = 56
const MAX_THUMB_DIM = 4096
const BIG_DOC_PAGES = 800
const BIG_DOC_NEAR = 64

function idle(): Promise<void> {
  return new Promise((r) => {
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number }
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => r())
    else window.setTimeout(r, 0)
  })
}

export default function ThumbnailRail({
  pdf, numPages, currentPage, onGoto, generation,
}: {
  pdf: PDFDocumentProxy
  numPages: number
  currentPage: number
  onGoto: (page: number) => void
  generation?: number
}) {
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map())
  const cacheRef = useRef(new Map<number, string>())
  const seqRef = useRef(0)
  const railRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  // 大文档按需范围：轨道滚动时扩展（scrollTick 触发 effect 重算队列）
  const [scrollTick, setScrollTick] = useState(0)
  const scrollTickRef = useRef(0)
  const onRailScroll = useCallback(() => {
    const n = ++scrollTickRef.current
    // 节流：滚动停止 120ms 后再重算队列，避免滚动中频繁重启渲染循环
    window.setTimeout(() => {
      if (n === scrollTickRef.current) setScrollTick((t) => t + 1)
    }, 120)
  }, [])

  useEffect(() => {
    // 文档切换：清缓存并使旧循环失效
    cacheRef.current = new Map()
    setThumbs(new Map())
    seqRef.current++
  }, [pdf])

  const renderOne = useCallback(async (pageNo: number, my: number, genAtStart: number | undefined) => {
    if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return false
    try {
      const page = await pdf.getPage(pageNo)
      if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return false
      const vp0 = page.getViewport({ scale: 1 })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rawScale = (THUMB_W / vp0.width) * 2 * dpr
      const k = Math.min(rawScale, MAX_THUMB_DIM / vp0.width, MAX_THUMB_DIM / vp0.height)
      const viewport = page.getViewport({ scale: k })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      await (page.render({ canvas, viewport, intent: 'display' } as unknown as { canvas: HTMLCanvasElement; viewport: import('pdfjs-dist').PageViewport; intent: string }).promise)
      try { page.cleanup() } catch { /* ignore */ }
      if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return false
      if (document.hidden) await idle()
      cacheRef.current.set(pageNo, canvas.toDataURL('image/webp', 0.75))
      setThumbs(new Map(cacheRef.current))
      return true
    } catch {
      // 加密页/已销毁 transport 等渲染失败：缓存空串显示页码占位
      cacheRef.current.set(pageNo, '')
      setThumbs(new Map(cacheRef.current))
      return false
    }
  }, [pdf, generation])

  useEffect(() => {
    const my = ++seqRef.current
    const genAtStart = generation
    // 队列：默认全部页按距当前页距离排序；大文档截断为当前±NEAR + 轨道可视区±16
    let order: number[]
    if (numPages > BIG_DOC_PAGES) {
      const el = railRef.current
      const itemH = THUMB_W * 1.35 + 6
      let visLo = currentPage - BIG_DOC_NEAR
      let visHi = currentPage + BIG_DOC_NEAR
      if (el && itemH > 0) {
        const first = Math.floor(el.scrollTop / itemH) + 1
        const count = Math.ceil(el.clientHeight / itemH) + 1
        visLo = Math.min(visLo, first - 16)
        visHi = Math.max(visHi, first + count + 16)
      }
      const lo = Math.max(1, visLo)
      const hi = Math.min(numPages, visHi)
      order = []
      for (let p = lo; p <= hi; p++) order.push(p)
      order.sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
    } else {
      order = []
      for (let p = 1; p <= numPages; p++) order.push(p)
      order.sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
    }
    const pending = order.filter((p) => !cacheRef.current.has(p))
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      // 分片：每 8 页让出主线程一次
      for (let i = 0; i < pending.length; i++) {
        if (cancelled || seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return
        if (document.hidden) await idle()
        await renderOne(pending[i], my, genAtStart)
        if ((i + 1) % 8 === 0) await idle()
      }
    })()
    return () => { cancelled = true }
    // scrollTick：大文档轨道滚动后扩展按需范围；currentPage 变化重排优先级
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, currentPage, numPages, generation, scrollTick, renderOne])

  // 当前页自动滚动到可见（nearest + smooth，无大幅跳动）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentPage])

  // 悬停预加载：无缓存页提前渲染一张
  const prefetch = useCallback((pageNo: number) => {
    if (cacheRef.current.has(pageNo)) return
    const my = seqRef.current
    const genAtStart = generation
    void renderOne(pageNo, my, genAtStart)
  }, [renderOne, generation])

  const pages: number[] = []
  for (let p = 1; p <= numPages; p++) pages.push(p)

  return (
    <div
      ref={railRef}
      onScroll={onRailScroll}
      className="flex shrink-0 flex-col items-center gap-1.5 overflow-x-hidden overflow-y-auto border-l border-border bg-bg-soft px-2 py-2"
      style={{ width: RAIL_W }}
      title="缩略图导航：滚动浏览全部页面，点击跳转"
    >
      {pages.map((p) => {
        const data = thumbs.get(p)
        const active = p === currentPage
        return (
          <button
            key={p}
            ref={active ? activeRef : undefined}
            className={`relative shrink-0 overflow-hidden rounded border transition-all duration-150 ${
              active
                ? 'border-accent shadow-[var(--shadow-1)] ring-1 ring-accent'
                : 'border-border hover:scale-[1.05] hover:border-accent hover:shadow-[var(--shadow-1)]'
            }`}
            style={{ width: THUMB_W, height: THUMB_W * 1.35 }}
            title={`第 ${p} / ${numPages} 页（点击跳转）`}
            aria-label={`跳转到第 ${p} 页`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onGoto(p)}
            onMouseEnter={() => prefetch(p)}
            onFocus={() => prefetch(p)}
          >
            {data ? (
              <img src={data} alt={`第 ${p} 页`} className="h-full w-full object-contain bg-white" loading="lazy" draggable={false} />
            ) : (
              <span className="flex h-full items-center justify-center text-[10px] text-text-faint">{p}</span>
            )}
            <span className={`absolute bottom-0 right-0 rounded-tl px-1 text-[9px] ${active ? 'bg-accent text-white' : 'bg-panel text-text-faint'}`}>
              {p}
            </span>
          </button>
        )
      })}
    </div>
  )
}
