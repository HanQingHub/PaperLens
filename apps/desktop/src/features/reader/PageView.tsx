// 单页视图：canvas 渲染 + pdfjs6 TextLayer + OCR 叠加层 + 批注层 + 连线交互
// 性能要点：
//  - renderScale（父级防抖提交）驱动高清重渲染；scale 仅驱动 CSS 尺寸，
//    缩放过程中浏览器直接拉伸已有位图（GPU 合成），停顿 ~180ms 后才重渲染。
//  - canvas 离屏双缓冲：先渲染到离屏 canvas 再一次 blit 上屏，避免清屏白闪。
//  - 渲染经 renderScheduler 排队（并发上限 + 距离优先级），滚动不被渲染抢占。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import { useReader } from '../../stores/readerStore'
import { useAuth } from '../../stores/auth'
import { useWords } from '../../stores/words'
import { applyHighlights, type HighlightOptions } from './highlight'
import { cssPointToPdf, linkPath, pdfPointToCss, rectCenter } from '../../shared/coords'
import { scheduleRender, stashPageBitmap, takePageBitmap } from './renderScheduler'
import { OcrOverlay } from './ocrOverlay'
import AnnotationOverlay from '../annotations/AnnotationOverlay'
import { DraftCard } from '../annotations/NoteCard'

/** canvas 单边像素上限：超出则降低输出倍率（防超大页/高缩放爆内存与慢渲染） */
const MAX_CANVAS_DIM = 4096
/** DPR 上限：高分屏不再无限制放大位图 */
const MAX_DPR = 2

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageIndex: number
  /** 渲染 canvas/textLayer（视口 ±2） */
  active: boolean
  /** 防抖后的高清渲染倍率（默认跟随 scale） */
  renderScale?: number
  /** 预渲染（渲染但不可见，防白闪） */
  prerender?: boolean
}

// memo：父级（OCR 轮询/进度保存等）触发的重渲染不再波及页面子树
const PageView = memo(function PageView({ pdf, pageIndex, active, renderScale, prerender = false }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textDivRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  /** textLayer 换入计数：触发词高亮重扫（rendered 在贴缓存位图时已为 true） */
  const [layerVersion, setLayerVersion] = useState(0)
  const paintedRef = useRef(false)

  const scale = useReader((s) => s.scale)
  const numPages = useReader((s) => s.numPages)
  const hiScale = renderScale ?? scale
  const pageSize = useReader((s) => s.pageSizes[pageIndex])
  const ocrBlocks = useReader((s) => s.ocrBlocks.get(pageIndex))
  const highlightVersion = useReader((s) => s.highlightVersion)
  const linking = useReader((s) => s.linking)
  const updateLinking = useReader((s) => s.updateLinking)
  const locateAnnotationId = useReader((s) => s.locateAnnotationId)
  const annotations = useReader((s) => s.annotations)
  const [popoverId, setPopoverId] = useState<number | null>(null)

  // 高亮批注被删除后自动收起浮条
  useEffect(() => {
    if (popoverId != null && !annotations.some((a) => a.id === popoverId)) setPopoverId(null)
  }, [annotations, popoverId])

  const { settings } = useAuth()
  const stageMap = useWords((s) => s.stageMap)
  const searchTerm = useReader((s) => s.searchTerm)
  const searchFocusPage = useReader((s) => s.searchFocusPage)

  const geom = useMemo(
    () => ({ baseW: pageSize?.w ?? 612, baseH: pageSize?.h ?? 792, scale }),
    [pageSize?.w, pageSize?.h, scale],
  )
  // 舞台几何：所有页内层（canvas/文本/OCR/批注）以 hiScale 为坐标系布局，
  // 缩放未提交期间由 stage 容器的 CSS transform 整体拉伸——wheel 事件只改
  // 一个 transform，页内几百个 OCR span / 批注节点零重排、零重渲染。
  const stageGeom = useMemo(
    () => ({ baseW: geom.baseW, baseH: geom.baseH, scale: hiScale }),
    [geom.baseW, geom.baseH, hiScale],
  )
  const cssW = geom.baseW * scale
  const cssH = geom.baseH * scale
  const stageW = geom.baseW * hiScale
  const stageH = geom.baseH * hiScale
  const stretch = hiScale > 0 ? scale / hiScale : 1
  const visible = active && !prerender
  const ocrMode = !!ocrBlocks

  // ── canvas + textLayer 渲染（调度队列 + 离屏双缓冲 + 位图缓存）──
  useEffect(() => {
    if (!pdf || !active) return
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null
    let textLayer: TextLayer | null = null

    // 重挂载（回滚）时先贴 LRU 缓存位图：立即有画面，高清渲染在后台补齐
    const vis = canvasRef.current
    if (vis && !paintedRef.current) {
      const bmp = takePageBitmap(pageIndex)
      if (bmp) {
        vis.width = bmp.width
        vis.height = bmp.height
        vis.getContext('2d')?.drawImage(bmp, 0, 0)
        paintedRef.current = true
        setRendered(true)
      }
    }

    // 距当前页越近优先级越高
    const priority = Math.abs(pageIndex + 1 - useReader.getState().currentPage)
    const handle = scheduleRender(async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const viewport = page.getViewport({ scale: hiScale })
        const dpr = window.devicePixelRatio || 1
        const k = Math.min(dpr, MAX_DPR, MAX_CANVAS_DIM / viewport.width, MAX_CANVAS_DIM / viewport.height)
        // 离屏渲染，完成后一次 blit 上屏（可见 canvas 从不清屏等待 → 无白闪）
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
        paintedRef.current = true

        if (!ocrMode) {
          // 文本层在分离容器中构建完成后再整体换入，避免选区中途塌陷
          const tmp = document.createElement('div')
          tmp.className = 'textLayer'
          tmp.style.setProperty('--total-scale-factor', String(hiScale))
          textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: tmp,
            viewport,
          })
          await textLayer.render()
          if (cancelled) return
          if (textDivRef.current) {
            textDivRef.current.replaceChildren(...Array.from(tmp.childNodes))
          }
          setLayerVersion((v) => v + 1)
        }
        setRendered(true)
      } catch {
        /* 取消渲染静默（RenderingCancelledException 等） */
      }
    }, priority)

    return () => {
      cancelled = true
      handle.cancel()
      renderTask?.cancel()
      textLayer?.cancel()
      // 已绘制内容入 LRU，供回滚/重挂载即时显示
      const c = canvasRef.current
      if (c && paintedRef.current) stashPageBitmap(pageIndex, c)
    }
    // hiScale 为防抖提交值：缩放过程中本 effect 不会反复触发
  }, [pdf, pageIndex, hiScale, active, ocrMode])

  // ── 词高亮 / 搜索高亮（渲染完成或版本变化时，空闲时段执行避免阻塞首帧）──
  const applyHl = useCallback(() => {
    const container = pageRef.current
    if (!container) return
    const opts: HighlightOptions = {
      stageMap,
      enabled: settings.highlight_enabled,
      searchTerms: searchTerm ? new Set([searchTerm]) : undefined,
      currentTerm: searchFocusPage === pageIndex ? searchTerm : null,
    }
    applyHighlights(container, opts)
  }, [stageMap, settings.highlight_enabled, searchTerm, searchFocusPage, pageIndex])

  useEffect(() => {
    if (!rendered) return
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let idle = 0
    let timer = 0
    if (typeof w.requestIdleCallback === 'function') {
      idle = w.requestIdleCallback(() => applyHl(), { timeout: 400 })
    } else {
      timer = window.setTimeout(applyHl, 0)
    }
    return () => {
      if (idle) w.cancelIdleCallback?.(idle)
      if (timer) window.clearTimeout(timer)
    }
  }, [rendered, layerVersion, highlightVersion, applyHl, ocrBlocks])

  // ── 高亮命中判定（选区折叠时）：点击点 → PDF 坐标 → sentence rects 包含测试 ──
  const onStageClick = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return // 划词流程不触发
    if (!pageRef.current) return
    const box = pageRef.current.getBoundingClientRect()
    const p = cssPointToPdf(e.clientX - box.left, e.clientY - box.top, geom)
    const hit = annotations.find(
      (a) =>
        a.type === 'sentence' &&
        a.page_no === pageIndex + 1 &&
        a.rects.some((r) => p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3]),
    )
    setPopoverId(hit ? (hit.id === popoverId ? null : hit.id) : null)
  }

  // ── 连线拖拽（word_note）──
  const isLinkingPage = linking != null && linking.pageIndex === pageIndex
  const anchorCss = useMemo(() => {
    if (!linking || linking.pageIndex !== pageIndex || !linking.rects.length) return null
    const c = rectCenter(linking.rects[0])
    return pdfPointToCss(c.x, c.y, stageGeom)
  }, [linking, pageIndex, stageGeom])

  // OCR 叠加层：memo 组件，仅随 OCR 数据 / 高清倍率重渲染，缩放 wheel 不触发

  const onStageMouseDown = (e: React.MouseEvent) => {
    if (!isLinkingPage || !pageRef.current) return
    if (linking?.cardDraft) return // 已落卡片
    e.preventDefault()
    const box = pageRef.current.getBoundingClientRect()
    updateLinking({ drag: { x: e.clientX - box.left, y: e.clientY - box.top } })

    const onMove = (ev: MouseEvent) => {
      if (!pageRef.current) return
      const b = pageRef.current.getBoundingClientRect()
      updateLinking({ drag: { x: ev.clientX - b.left, y: ev.clientY - b.top } })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!pageRef.current) return
      const b = pageRef.current.getBoundingClientRect()
      // 卡片落点：鼠标位置，尺寸按 scale 无关的 PDF 空间存储（viewport px 固定观感）
      const w = 230
      const h = 150
      let vx = ev.clientX - b.left + 12
      let vy = ev.clientY - b.top - h / 2
      vx = Math.max(4, Math.min(vx, cssW - w - 4))
      vy = Math.max(4, Math.min(vy, cssH - h - 4))
      // viewport px → PDF 空间
      const p1 = cssPointToPdf(vx, vy, geom)
      const p2 = cssPointToPdf(vx + w, vy + h, geom)
      updateLinking({
        drag: null,
        cardDraft: {
          x: Math.min(p1.x, p2.x),
          y: Math.max(p1.y, p2.y),
          w: Math.abs(p2.x - p1.x),
          h: Math.abs(p2.y - p1.y),
        },
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={pageRef}
      data-page-index={pageIndex}
      data-page-no={pageIndex + 1}
      className="page-wrapper relative mx-auto mb-4 shrink-0"
      style={{ width: cssW, height: cssH, visibility: visible ? 'visible' : 'hidden' }}
      onMouseDown={onStageMouseDown}
      onClick={onStageClick}
    >
      {/* 白底纸张（未渲染时做骨架占位） */}
      <div
        className={`absolute inset-0 rounded-[2px] bg-panel shadow-[var(--shadow-1)] ${!rendered ? 'skeleton-shimmer' : ''}`}
      >
        {!rendered && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-faint">
            {pageIndex + 1} / {numPages}
          </div>
        )}
      </div>

      {/* 舞台：以高清倍率 hiScale 布局全部页内层；缩放未提交期间仅改 transform，
          canvas 位图 / 文本层 / OCR / 批注全部零重排（GPU 合成拉伸） */}
      <div
        className="absolute left-0 top-0"
        style={{
          width: stageW,
          height: stageH,
          transform: stretch !== 1 ? `scale(${stretch})` : undefined,
          transformOrigin: '0 0',
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ width: stageW, height: stageH }} />

        {/* pdfjs 文本层（文本型 PDF，按 hiScale 布局，随舞台拉伸） */}
        {!ocrMode && (
          <div
            ref={textDivRef}
            className="textLayer"
            style={{ ['--total-scale-factor' as string]: String(hiScale) }}
          />
        )}

        {/* OCR 叠加层（扫描版，逐行绝对定位） */}
        {ocrMode && rendered && (
          <div className="ocr-layer">
            <OcrOverlay blocks={ocrBlocks!} geom={stageGeom} />
          </div>
        )}

        {/* 批注层：句子高亮 + 信息操作条 + word_note 锚点/连线/卡片 */}
        {rendered && (
          <AnnotationOverlay
            pageIndex={pageIndex}
            geom={stageGeom}
            cssW={stageW}
            cssH={stageH}
            locateId={locateAnnotationId}
            popoverId={popoverId}
            onClosePopover={() => setPopoverId(null)}
          />
        )}

        {/* 连线拖拽预览（drag 为可视坐标，除以 stretch 换算到舞台坐标） */}
        {isLinkingPage && anchorCss && linking?.drag && !linking.cardDraft && (
          <svg className="anno-links">
            <path
              d={linkPath(anchorCss.x, anchorCss.y, linking.drag.x / stretch, linking.drag.y / stretch)}
              stroke="var(--accent)"
              strokeWidth={1.5}
              fill="none"
              strokeDasharray="4 3"
            />
          </svg>
        )}
        {isLinkingPage && linking?.cardDraft && (
          <DraftCard pageIndex={pageIndex} geom={stageGeom} anchorRects={linking.rects} card={linking.cardDraft} />
        )}
      </div>
    </div>
  )
})

export default PageView