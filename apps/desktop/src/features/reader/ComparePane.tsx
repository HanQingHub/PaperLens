// 双论文对照窗格：自包含迷你阅读器（连续滚动 + 缩放 + 划词翻译 + 链接可点）。
// 刻意不共享全局渲染设施（renderScheduler/位图 LRU/pageTextCache/docCache）——
// 它们按 pageIndex 键控无窗格隔离，复用会跨文档互污；文档实例自建自毁（所有权独立）。
// 范围外（v1）：批注/高亮、生词高亮与悬停卡、OCR 叠加、页内搜索、回链。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import { api, pdfFileUrl } from '../../api/client'
import type { Paper } from '../../api/types'
import { useCompareStore } from '../../stores/compareStore'
import { useReader } from '../../stores/readerStore'
import {
  clientRectsInPage,
  clientRectsToPdf,
  cssPointToPdf,
  mergeClientRects,
  pdfRectToCss,
} from '../../shared/coords'
import { getPageLinks, pointInPdfRects, resolveDest, type PageLink } from './linkLayer'
import { openExternal } from '../../shared/openExternal'
import { extractSentenceContext } from './sentence'
import { IconFit, IconMinus, IconPlus, IconX } from '../../components/shared/Icon'
import { toast } from '../shared/Toast'

const MAX_CANVAS_DIM = 4096
const MAX_DPR = 2
const PAGE_GAP = 16
const FIRST_PARSE_PAGES = 8

// 对照窗格私有文本缓存（与主窗格 pageTextCache 隔离，键为 pageIndex）
const compareTextCache = new Map<number, string>()

async function ensureCompareText(pdf: PDFDocumentProxy, pageIndex: number): Promise<string> {
  const hit = compareTextCache.get(pageIndex)
  if (hit !== undefined) return hit
  const page = await pdf.getPage(pageIndex + 1)
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  compareTextCache.set(pageIndex, text)
  return text
}

interface PageSize {
  w: number
  h: number
}

function pageTopOf(pageIndex: number, pageSizes: PageSize[], scale: number) {
  let top = 0
  for (let i = 0; i < pageIndex; i++) top += pageSizes[i].h * scale + PAGE_GAP
  return top
}

// ── 对照页（canvas + TextLayer + 链接命中）──────────────────
const ComparePage = memo(function ComparePage({
  pdf,
  pageIndex,
  scale,
  active,
  gen,
  pageSize,
  onGotoPage,
}: {
  pdf: PDFDocumentProxy
  pageIndex: number
  scale: number
  active: boolean
  gen: number
  pageSize: PageSize
  onGotoPage: (pageNo: number, ratio: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textDivRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  const [pageLinks, setPageLinks] = useState<PageLink[] | null>(null)
  const [hoverLink, setHoverLink] = useState<PageLink | null>(null)

  const geom = { baseW: pageSize.w, baseH: pageSize.h, scale }

  // 自绘渲染：直渲（无调度队列/位图缓存，对照窗格量级可控）
  useEffect(() => {
    if (!pdf || !active) return
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null
    let textLayer: TextLayer | null = null
    setRendered(false)
    ;(async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const dpr = window.devicePixelRatio || 1
        const k = Math.min(dpr, MAX_DPR, MAX_CANVAS_DIM / viewport.width, MAX_CANVAS_DIM / viewport.height)
        const off = document.createElement('canvas')
        off.width = Math.max(1, Math.floor(viewport.width * k))
        off.height = Math.max(1, Math.floor(viewport.height * k))
        renderTask = page.render({
          canvas: off,
          viewport,
          transform: k !== 1 ? [k, 0, 0, k, 0, 0] : undefined,
        }) as unknown as { cancel: () => void; promise: Promise<void> }
        await renderTask.promise
        if (cancelled || !canvasRef.current) return
        const c = canvasRef.current
        c.width = off.width
        c.height = off.height
        c.getContext('2d')?.drawImage(off, 0, 0)
        // 文本层：构建完成后再整体换入（与主窗格 PageView 同手法）
        const tmp = document.createElement('div')
        tmp.className = 'textLayer'
        tmp.style.setProperty('--total-scale-factor', String(scale))
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: tmp,
          viewport,
        })
        await textLayer.render()
        if (cancelled) return
        textDivRef.current?.replaceChildren(...Array.from(tmp.childNodes))
        setRendered(true)
      } catch {
        /* 取消/竞态静默 */
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [pdf, pageIndex, scale, active, gen])

  // 链接注释（文档级缓存复用 getPageLinks）
  useEffect(() => {
    if (!rendered) {
      setPageLinks(null)
      setHoverLink(null)
      return
    }
    let stop = false
    getPageLinks(pdf, pageIndex)
      .then((l) => !stop && setPageLinks(l))
      .catch(() => !stop && setPageLinks([]))
    return () => {
      stop = true
    }
  }, [pdf, pageIndex, rendered])

  const linkAtEvent = (e: { clientX: number; clientY: number }): PageLink | null => {
    const box = pageRef.current?.getBoundingClientRect()
    if (!box || !pageLinks?.length) return null
    const p = cssPointToPdf(e.clientX - box.left, e.clientY - box.top, geom)
    return pageLinks.find((l) => pointInPdfRects(p.x, p.y, l.rects)) ?? null
  }

  const cssW = pageSize.w * scale
  const cssH = pageSize.h * scale

  return (
    <div
      ref={pageRef}
      data-page-index={pageIndex}
      className="page-wrapper relative mx-auto mb-4 shrink-0"
      style={{ width: cssW, height: cssH, cursor: hoverLink ? 'pointer' : undefined }}
      onMouseMove={(e) => {
        const hit = linkAtEvent(e)
        if (hit !== hoverLink) setHoverLink(hit)
      }}
      onMouseOut={() => {
        if (hoverLink) setHoverLink(null)
      }}
      onClick={(e) => {
        if (!window.getSelection()?.isCollapsed) return
        const hit = linkAtEvent(e)
        if (!hit) return
        if (hit.kind === 'external') {
          openExternal(hit.url).catch(() => toast('外部链接打开失败', 'error'))
        } else {
          resolveDest(pdf, hit.dest).then((t) => {
            if (t) onGotoPage(t.pageNo, t.ratio)
          })
        }
      }}
    >
      <div className={`absolute inset-0 rounded-[2px] bg-panel shadow-[var(--shadow-1)] ${!rendered ? 'skeleton-shimmer' : ''}`}>
        {!rendered && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-faint">
            {pageIndex + 1}
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ width: cssW, height: cssH }} />
      <div
        ref={textDivRef}
        className="textLayer"
        style={{ ['--total-scale-factor' as string]: String(scale) }}
      />
      {hoverLink && (
        <svg className="link-hover-svg" width={cssW} height={cssH}>
          {hoverLink.rects.map((r, i) => {
            const { left, top, width, height } = pdfRectToCss(r, geom)
            return <rect key={i} x={left} y={top} width={width} height={height} />
          })}
        </svg>
      )}
    </div>
  )
})

// ── 对照窗格主体 ─────────────────────────────────────────────
export default function ComparePane({ widthPercent }: { widthPercent: number }) {
  const paperId = useCompareStore((s) => s.paperId)
  const paper = useCompareStore((s) => s.paper)
  const setPaper = useCompareStore((s) => s.setPaper)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageSizes, setPageSizes] = useState<PageSize[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scale, setScale] = useState(1.2)
  const [currentPage, setCurrentPage] = useState(1)
  const [renderRange, setRenderRange] = useState<[number, number]>([0, 4])
  /** 加载失败后的手动重试计数（驱动加载 effect 重跑） */
  const [retryTick, setRetryTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadGenRef = useRef(0)
  const docGen = loadGenRef.current

  // 加载（自建文档实例，不碰 docCache）
  useEffect(() => {
    const gen = ++loadGenRef.current
    setDoc(null)
    setNumPages(0)
    setPageSizes([])
    setError(null)
    setCurrentPage(1)
    setRenderRange([0, 4])
    // 私有文本缓存键仅 pageIndex：换文档必须清空，防跨对照会话的句译上下文互污
    compareTextCache.clear()
    if (paperId == null) {
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    let live: PDFDocumentProxy | null = null
    ;(async () => {
      try {
        const meta: Paper = paper && paper.id === paperId ? paper : await api.paper(paperId)
        if (cancelled || gen !== loadGenRef.current) return
        if ((meta as unknown as { file_type?: string }).file_type === 'markdown') {
          setError('Markdown 文件不支持对照阅读')
          setLoading(false)
          return
        }
        const tk = await api.fileToken(paperId)
        if (cancelled || gen !== loadGenRef.current) return
        const res = await fetch(pdfFileUrl(paperId, tk.token))
        if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`)
        const data = new Uint8Array(await res.arrayBuffer())
        if (cancelled || gen !== loadGenRef.current) return
        const task = getDocument({
          data,
          cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
          cMapPacked: true,
        })
        const d = await task.promise
        if (cancelled || gen !== loadGenRef.current) {
          void (d as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch(() => {})
          return
        }
        live = d
        const firstCount = Math.min(FIRST_PARSE_PAGES, d.numPages)
        const firstPages = await Promise.all(Array.from({ length: firstCount }, (_, i) => d.getPage(i + 1)))
        if (cancelled || gen !== loadGenRef.current) return
        const parsed: (PageSize | null)[] = firstPages.map((pg) => {
          const vp = pg.getViewport({ scale: 1 })
          return { w: vp.width, h: vp.height }
        })
        const first = parsed[0] ?? { w: 612, h: 792 }
        const full: PageSize[] = Array.from({ length: d.numPages }, (_, i) => parsed[i] ?? first)
        setPageSizes(full)
        setDoc(d)
        setNumPages(d.numPages)
        setLoading(false)
        // 后台补齐其余页尺寸（等比占位 → 真实值）
        const BATCH = 16
        for (let s = firstCount; s < d.numPages; s += BATCH) {
          if (cancelled || gen !== loadGenRef.current) return
          const end = Math.min(s + BATCH, d.numPages)
          const batch = await Promise.all(Array.from({ length: end - s }, (_, i) => d.getPage(s + i + 1)))
          if (cancelled || gen !== loadGenRef.current) return
          setPageSizes((cur) => {
            const next = cur.slice()
            for (let i = 0; i < batch.length; i++) {
              const vp = batch[i].getViewport({ scale: 1 })
              next[s + i] = { w: vp.width, h: vp.height }
            }
            return next
          })
        }
      } catch (e) {
        if (!cancelled && gen === loadGenRef.current) {
          setError(e instanceof Error ? e.message : '加载失败')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
      if (live) {
        try {
          void (live as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch(() => {})
        } catch {
          /* ignore */
        }
      }
    }
    // paper 仅作元数据兜底，避免引用变化重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, retryTick])

  // 滚动：可见页 / 懒渲染范围 / 当前页
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || !numPages || !pageSizes.length) return
    const viewTop = el.scrollTop
    const viewBot = viewTop + el.clientHeight
    const mid = viewTop + el.clientHeight / 2
    let acc = 0
    let firstVisible = -1
    let lastVisible = -1
    let current = 0
    let best = Infinity
    for (let i = 0; i < numPages; i++) {
      const h = pageSizes[i].h * scale
      const a = acc
      const b = acc + h
      if (b >= viewTop && a <= viewBot) {
        if (firstVisible < 0) firstVisible = i
        lastVisible = i
      }
      const d = Math.abs((a + b) / 2 - mid)
      if (d < best) {
        best = d
        current = i
      }
      acc = b + PAGE_GAP
    }
    if (firstVisible < 0) return
    setRenderRange((prev) => {
      const r: [number, number] = [Math.max(0, firstVisible - 1), Math.min(numPages - 1, lastVisible + 1)]
      return r[0] === prev[0] && r[1] === prev[1] ? prev : r
    })
    setCurrentPage((prev) => (prev === current + 1 ? prev : current + 1))
  }, [numPages, scale, pageSizes])

  const gotoRatio = useCallback(
    (pageNo: number, ratio: number) => {
      const el = scrollRef.current
      if (!el || !pageSizes.length) return
      const p = Math.max(1, Math.min(pageNo, numPages || pageNo))
      const top = pageTopOf(p - 1, pageSizes, scale)
      const h = (pageSizes[p - 1]?.h ?? 0) * scale
      el.scrollTop = top + ratio * h
    },
    [numPages, scale, pageSizes],
  )

  const zoomBy = (f: number) => setScale((s) => Math.min(6, Math.max(0.3, Math.round(s * f * 100) / 100)))
  const fitWidth = () => {
    const el = scrollRef.current
    if (!el || !pageSizes.length) return
    const w = pageSizes[Math.max(0, currentPage - 1)]?.w ?? 612
    setScale(Math.max(0.3, Math.round(((el.clientWidth - 48) / w) * 100) / 100))
  }

  // Ctrl+滚轮缩放（容器随 loading/error 分支重挂，依赖变化后重绑）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setScale((s) => Math.min(6, Math.max(0.3, Math.round(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [loading, error, paperId])

  // 划词 → 共享 selection（paperId = 对照论文；fixed 工具条跨窗格定位）
  const onMouseUp = useCallback(() => {
    window.setTimeout(async () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return
      const text = sel.toString().replace(/\s+/g, ' ').trim()
      const node = sel.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      const pageEl = el?.closest('.page-wrapper') as HTMLElement | null
      if (!pageEl || !paperId) return
      const pageIndex = Number(pageEl.dataset.pageIndex)
      const size = pageSizes[pageIndex]
      if (!size || !doc) return
      const geom = { baseW: size.w, baseH: size.h, scale }
      const range = sel.getRangeAt(0)
      const visibleRects = clientRectsInPage(range.getClientRects(), pageEl.getBoundingClientRect())
      const merged = mergeClientRects(visibleRects, 1.0, scale)
      const rects = clientRectsToPdf(merged, pageEl, geom)
      const first = merged[0]
      if (!first || !rects.length) return
      const fullText = await ensureCompareText(doc, pageIndex)
      const ctx = extractSentenceContext(fullText, text)
      useReader.getState().setSelection({
        text,
        pageIndex,
        rects,
        sentence: ctx.sentence,
        prev: ctx.prev,
        next: ctx.next,
        paperId,
        toolbarX: first.left + first.width / 2,
        toolbarY: first.bottom + 10,
        toolbarBelow: true,
      })
    }, 0)
  }, [paperId, doc, scale, pageSizes])

  const pagesIdx = Array.from({ length: numPages }, (_, i) => i)

  return (
    <div className="compare-pane" style={{ width: `${widthPercent}%` }}>
      {/* 迷你工具行 */}
      <div className="compare-toolbar">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={paper?.title}>
          {paper?.title ?? '…'}
        </span>
        {paper?.is_scanned && (
          <span className="shrink-0 text-[10px] text-text-faint" title="扫描版对照不支持划词">
            扫描版
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-text-faint">
          {currentPage}/{numPages || '…'}
        </span>
        <button className="rd-tbtn shrink-0" title="缩小" onClick={() => zoomBy(1 / 1.2)}>
          <IconMinus size={12} />
        </button>
        <span className="w-9 shrink-0 text-center text-[10px] tabular-nums text-text-faint">{Math.round(scale * 100)}%</span>
        <button className="rd-tbtn shrink-0" title="放大" onClick={() => zoomBy(1.2)}>
          <IconPlus size={12} />
        </button>
        <button className="rd-tbtn shrink-0" title="适应宽度" onClick={fitWidth}>
          <IconFit size={12} />
        </button>
        <button className="rd-tbtn shrink-0" title="退出对照" onClick={() => setPaper(null)}>
          <IconX size={11} />
        </button>
      </div>

      {/* 内容 */}
      {paperId == null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-text-faint">未选择对照论文</div>
      ) : loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-faint">
          <div className="spinner spinner-lg" />
          <span className="text-xs">正在打开对照论文…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className="px-4 text-center text-xs text-danger">{error}</p>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary px-2.5 py-0.5 text-[11px]" onClick={() => setRetryTick((t) => t + 1)}>
              重试
            </button>
            <button className="btn px-2.5 py-0.5 text-[11px]" onClick={() => setPaper(null)}>
              退出对照
            </button>
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="compare-scroll" onScroll={onScroll} onMouseUp={onMouseUp}>
          <div className="mx-auto w-max px-5 py-4">
            {pagesIdx.map((i) => {
              const size = pageSizes[i]
              if (!size) return null
              const inRange = i >= renderRange[0] && i <= renderRange[1]
              if (!inRange) {
                return (
                  <div
                    key={i}
                    className="page-placeholder mx-auto mb-4 rounded-[2px] border border-border bg-panel"
                    style={{ width: size.w * scale, height: size.h * scale }}
                  >
                    <span className="flex h-full items-center justify-center text-[11px] text-text-faint">{i + 1}</span>
                  </div>
                )
              }
              return doc ? (
                <ComparePage key={i} pdf={doc} pageIndex={i} scale={scale} active gen={docGen} pageSize={size} onGotoPage={gotoRatio} />
              ) : null
            })}
          </div>
        </div>
      )}
    </div>
  )
}
