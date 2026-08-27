// 缩略图导航条：无大纲 PDF 的页级跳转兜底。
// 可视窗口以 currentPage 为中心（renderRange 在单页模式下不更新，不可依赖）；
// 串行低优先渲染（一次一张）避免与主视图争抢 pdf.js worker；dataURL 缓存防重渲染。
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const RAIL_W = 64
const THUMB_W = 52
const WINDOW = 6 // 当前页上下各 6 页
const MAX_THUMB_DIM = 4096

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

  useEffect(() => {
    // 文档切换：清缓存并使旧循环失效
    cacheRef.current = new Map()
    setThumbs(new Map())
    seqRef.current++
  }, [pdf])

  useEffect(() => {
    const my = ++seqRef.current
    const genAtStart = generation
    const lo = Math.max(1, currentPage - WINDOW)
    const hi = Math.min(numPages, currentPage + WINDOW)
    const pending: number[] = []
    for (let p = lo; p <= hi; p++) {
      if (!cacheRef.current.has(p)) pending.push(p)
    }
    if (pending.length === 0) return
    ;(async () => {
      for (const pageNo of pending) {
        if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return
        try {
          const page = await pdf.getPage(pageNo)
          if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return
          const vp0 = page.getViewport({ scale: 1 })
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          const rawScale = (THUMB_W / vp0.width) * 2 * dpr
          const k = Math.min(rawScale, MAX_THUMB_DIM / vp0.width, MAX_THUMB_DIM / vp0.height)
          const viewport = page.getViewport({ scale: k })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          await (page.render({ canvas, viewport, intent: 'display' } as unknown as { canvas: HTMLCanvasElement; viewport: import('pdfjs-dist').PageViewport; intent: string }).promise)
          try { page.cleanup() } catch { /* ignore */ }
          if (seqRef.current !== my || (generation !== undefined && generation !== genAtStart)) return
          cacheRef.current.set(pageNo, canvas.toDataURL('image/webp', 0.75))
          setThumbs(new Map(cacheRef.current))
        } catch {
          // 加密页/已销毁 transport 等渲染失败：缓存空串显示页码占位
          cacheRef.current.set(pageNo, '')
          setThumbs(new Map(cacheRef.current))
        }
      }
    })()
  }, [pdf, currentPage, numPages, generation])

  const lo = Math.max(1, currentPage - WINDOW)
  const hi = Math.min(numPages, currentPage + WINDOW)
  const pages: number[] = []
  for (let p = lo; p <= hi; p++) pages.push(p)

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-l border-border bg-bg-soft px-2 py-2" style={{ width: RAIL_W }}>
      {pages.map((p) => {
        const data = thumbs.get(p)
        const active = p === currentPage
        return (
          <button
            key={p}
            className={`relative shrink-0 overflow-hidden rounded border transition-all ${
              active ? 'border-accent shadow-[var(--shadow-1)]' : 'border-border hover:border-border-strong'
            }`}
            style={{ width: THUMB_W, height: THUMB_W * 1.35 }}
            title={`第 ${p} 页`}
            onClick={() => onGoto(p)}
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
