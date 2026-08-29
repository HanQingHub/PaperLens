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
import { computeWordHighlights, type HighlightOptions, type WordBucket } from './highlight'
import {
  capBandHeight,
  extractLineBands,
  fitRunToInk,
  separateVertically,
  type InkMap,
  type LineBand,
} from '../../shared/highlightGeometry'
import SelectionOverlay from './SelectionOverlay'
import { lookupHit } from './lemma'
import { cssPointToPdf, clientRectsInPage, clientRectsToPdf, linkPath, mergeClientRects, pdfPointToCss, rectCenter } from '../../shared/coords'
import { scheduleRender, stashPageBitmap, takePageBitmap } from './renderScheduler'
import { OcrOverlay } from './ocrOverlay'
import { ensurePageText, extractSentenceContext, ocrPageText } from './readerUtils'
import WordHoverCard from '../words/WordHoverCard'
import AnnotationOverlay from '../annotations/AnnotationOverlay'
import { DraftCard } from '../annotations/NoteCard'

/** canvas 单边像素上限：超出则降低输出倍率（防超大页/高缩放爆内存与慢渲染） */
const MAX_CANVAS_DIM = 4096
/** DPR 上限：高分屏不再无限制放大位图 */
const MAX_DPR = 2
/** 墨迹图素上限：防御性内存上限（MAX_CANVAS_DIM=4096 下正常不可触发），
 * 超限等比降采样而非断供 */
const INK_MAX_PX = 25_000_000
/** 词边界反查（wordAtPoint 用，与 highlight.ts 的 WORD_RE 同口径） */
const WORD_RE_PAGE = /[A-Za-z][A-Za-z'-]*/g

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageIndex: number
  /** 渲染 canvas/textLayer（视口 ±2） */
  active: boolean
  /** 防抖后的高清渲染倍率（默认跟随 scale） */
  renderScale?: number
  /** 预渲染（渲染但不可见，防白闪） */
  prerender?: boolean
  /** 文档世代：切换文档时使旧 pdf 的渲染任务失效 */
  generation?: number
}

// memo：父级（OCR 轮询/进度保存等）触发的重渲染不再波及页面子树
const PageView = memo(function PageView({ pdf, pageIndex, active, renderScale, prerender = false, generation }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textDivRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  /** 舞台容器（带 transform: scale(stretch)），供可视→舞台坐标换算与回退层挂载 */
  const stageRef = useRef<HTMLDivElement>(null)
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

    const cVisible = canvasRef.current
    return () => {
      cancelled = true
      handle.cancel()
      renderTask?.cancel()
      textLayer?.cancel()
      // 已绘制内容入 LRU，供回滚/重挂载即时显示
      if (cVisible && paintedRef.current) stashPageBitmap(pageIndex, cVisible)
    }
    // hiScale 为防抖提交值：缩放过程中本 effect 不会反复触发；generation 变化使旧 pdf 任务失效
  }, [pdf, pageIndex, hiScale, active, ocrMode, generation])

  // ── 词高亮 / 搜索高亮（渲染完成或版本变化时，空闲时段执行避免阻塞首帧）──
  // v5：computeWordHighlights 产出舞台坐标矩形分桶（零 Range/注册表持有，无清理函数），
  // 词带按 canvas 墨迹拟合，消除回退字体度量与 canvas 字形的基线/advance 错位
  const [wordHl, setWordHl] = useState<WordBucket[]>([])
  // 行盒 bands：SelectionOverlay / AnnotationOverlay 渲染前钳制基准（舞台坐标）
  const [lineBands, setLineBands] = useState<LineBand[]>([])
  const lastBandsRef = useRef('')

  // canvas 墨迹（按 layerVersion 缓存）：词带/行带墨迹标定的数据源。
  // OCR 页画布是扫描图（满页"墨迹"）→ 不构建，走 ocr-line 盒回退。
  // INK_MAX_PX 为防御性内存上限（MAX_CANVAS_DIM=4096 下正常不可触发），
  // 超限时等比降采样而非断供——墨迹缺失会回退行盒几何（垂直偏移观感）
  const inkRef = useRef<{ version: number; ink: InkMap | null; scale: number }>({ version: -1, ink: null, scale: 1 })
  const getInk = useCallback((): { ink: InkMap | null; scale: number } => {
    if (ocrMode) return { ink: null, scale: 1 }
    if (inkRef.current.version === layerVersion) {
      return { ink: inkRef.current.ink, scale: inkRef.current.scale }
    }
    const canvas = canvasRef.current
    let ink: InkMap | null = null
    let scale = 1
    if (canvas && canvas.width > 0) {
      const c2d = canvas.getContext('2d')
      if (c2d) {
        try {
          let w = canvas.width
          let h = canvas.height
          const total = w * h
          if (total > INK_MAX_PX) {
            const k = Math.sqrt(INK_MAX_PX / total)
            w = Math.max(1, Math.floor(w * k))
            h = Math.max(1, Math.floor(h * k))
          }
          let data: Uint8ClampedArray
          if (w === canvas.width && h === canvas.height) {
            data = c2d.getImageData(0, 0, w, h).data
          } else {
            const off = document.createElement('canvas')
            off.width = w
            off.height = h
            const octx = off.getContext('2d')
            if (!octx) throw new Error('2d context unavailable')
            octx.drawImage(canvas, 0, 0, w, h)
            data = octx.getImageData(0, 0, w, h).data
          }
          ink = { data, width: w, height: h }
          scale = w / (canvas.clientWidth || canvas.width)
        } catch {
          ink = null
        }
      }
    }
    inkRef.current = { version: layerVersion, ink, scale }
    return { ink, scale }
  }, [ocrMode, layerVersion])

  // canvas 墨迹（渲染期读取，按 layerVersion 缓存）：除词带拟合外，还下发给
  // 批注/选区层做矩形左右缘吸附（落库几何含文本层 advance 漂移）
  const { ink: pageInk, scale: pageInkScale } = rendered ? getInk() : { ink: null, scale: 1 }

  useEffect(() => {
    if (!rendered) { setWordHl([]); return }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let idle = 0
    let timer = 0
    const run = () => {
      const page = pageRef.current
      const stage = stageRef.current
      if (!page || !stage) return
      const sRect = stage.getBoundingClientRect()
      const layoutW = stage.offsetWidth || sRect.width
      const stretch = layoutW > 0 ? sRect.width / layoutW : 1
      const { ink, scale: inkScale } = getInk()
      const opts: HighlightOptions = {
        stageMap,
        enabled: settings.highlight_enabled,
        strength: settings.highlight_style,
        searchTerms: searchTerm ? new Set([searchTerm]) : undefined,
        currentTerm: searchFocusPage === pageIndex ? searchTerm : null,
      }
      setWordHl(computeWordHighlights(
        page,
        { stageLeft: sRect.left, stageTop: sRect.top, stageWidth: layoutW, stretch, lineBands, ink: ink ?? undefined, inkScale },
        opts,
      ))
    }
    if (typeof w.requestIdleCallback === 'function') {
      idle = w.requestIdleCallback(run, { timeout: 400 })
    } else {
      timer = window.setTimeout(run, 0)
    }
    return () => {
      if (idle) w.cancelIdleCallback?.(idle)
      if (timer) window.clearTimeout(timer)
    }
  }, [rendered, layerVersion, highlightVersion, stageMap, settings.highlight_enabled,
      settings.highlight_style, searchTerm, searchFocusPage, pageIndex, ocrBlocks, getInk, lineBands])

  // 行盒 bands 提取（textLayer 换入 / OCR 就绪 / 倍率变化后），并做墨迹垂直修正：
  // span 行盒按 PDF 字体 ascent 定位，canvas 字形降部/基线常露出带外（垂直偏移根因）
  // 等值短路：内容未变时保持旧引用，避免下游 memo 组件白渲染一次
  useEffect(() => {
    if (!rendered) {
      lastBandsRef.current = ''
      setLineBands([])
      return
    }
    const page = pageRef.current
    const stage = stageRef.current
    if (!page || !stage) return
    const sRect = stage.getBoundingClientRect()
    const layoutW = stage.offsetWidth || sRect.width
    const stretch = layoutW > 0 ? sRect.width / layoutW : 1
    const els = ocrMode
      ? [...page.querySelectorAll<HTMLElement>('.ocr-line')]
      : [...page.querySelectorAll<HTMLElement>('.textLayer span')]
        .filter((el) => !el.classList.contains('endOfContent'))
    let bands = extractLineBands(
      els,
      (vy) => (vy - sRect.top) / (stretch || 1),
      (vx) => (vx - sRect.left) / (stretch || 1),
    )
    const { ink, scale: inkScale } = getInk()
    if (ink) {
      bands = bands.map((b) => {
        const run = fitRunToInk(ink, { top: b.top, bottom: b.bottom }, b.left ?? 0, b.right ?? layoutW, b.bottom - b.top, inkScale)
        return run ? { ...b, top: run.top, bottom: run.bottom } : b
      })
    }
    // 墨迹带高≈行距：封顶到 0.84×行距并分离 —— 行间保留可见白隙；词/选区/批注
    // 三类高亮统一钳到此带（同高 + 不相交），深色叠涂与高度不一致几何上不可能。
    // separateVertically 带 width：水平前置条件真实生效（第二道防线）
    bands = capBandHeight(bands)
    bands = separateVertically(bands.map((b) => ({
      ...b,
      width: b.left != null && b.right != null ? b.right - b.left : undefined,
    })))
    const sig = bands.map((b) => `${b.top},${b.bottom}`).join(';')
    if (sig !== lastBandsRef.current) {
      lastBandsRef.current = sig
      setLineBands(bands)
    }
  }, [rendered, layerVersion, ocrMode, hiScale, getInk])

  // ── 生词悬停释义卡 + 高亮词点击查询（去 i 化：caret 探针 + 词边界反查）──
  const [hoverWord, setHoverWord] = useState<{ lemma: string; rect: DOMRect } | null>(null)
  const hoverTimer = useRef(0)
  const hideHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current)
    setHoverWord(null)
  }, [])

  interface WordHit { word: string; lemma: string; rect: DOMRect; range: Range }

  /** 点击/悬停坐标 → 词命中（caret 探针取词内偏移，再按词边界反查整词） */
  function wordAtPoint(x: number, y: number): WordHit | null {
    let range: Range | null = null
    if (typeof document.caretRangeFromPoint === 'function') {
      range = document.caretRangeFromPoint(x, y) as Range | null
    } else if (typeof (document as unknown as { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint === 'function') {
      const pos = (document as unknown as { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(x, y)
      if (pos && pos.offsetNode) {
        range = document.createRange()
        range.setStart(pos.offsetNode, pos.offset)
        range.collapse(true)
      }
    }
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null
    const tn = range.startContainer as Text
    const off = range.startOffset
    const text = tn.textContent ?? ''
    WORD_RE_PAGE.lastIndex = 0
    let m: RegExpExecArray | null
    let word = ''
    let s = -1
    let e = -1
    while ((m = WORD_RE_PAGE.exec(text)) !== null) {
      if (off >= m.index && off <= m.index + m[0].length) {
        word = m[0]
        s = m.index
        e = s + word.length
        break
      }
    }
    if (!word || s < 0) return null
    const hit = lookupHit(word, useWords.getState().stageMap)
    if (!hit) return null
    const r = new Range()
    r.setStart(tn, s)
    r.setEnd(tn, e)
    const rect = r.getBoundingClientRect() // 视觉后盒，已含 scaleX
    if (!rect || rect.width < 1 || rect.height < 1) return null
    // 跨页过滤：rect 中心必须落在本页盒内
    const pageBox = pageRef.current?.getBoundingClientRect()
    if (pageBox) {
      const cy = (rect.top + rect.bottom) / 2
      if (cy < pageBox.top || cy > pageBox.bottom) return null
    }
    return { word, lemma: hit.lemma, rect, range: r }
  }

  const onWordHover = useCallback(
    (e: React.MouseEvent) => {
      const hit = wordAtPoint(e.clientX, e.clientY)
      if (!hit) { hideHover(); return }
      window.clearTimeout(hoverTimer.current)
      const { lemma, rect } = hit
      hoverTimer.current = window.setTimeout(() => setHoverWord({ lemma, rect }), 300)
    },
    [hideHover],
  )
  // textLayer 换入/重扫后旧矩形失准，立即收卡（S5）
  useEffect(() => {
    hideHover()
  }, [layerVersion, highlightVersion, hideHover])

  const onWordClick = useCallback(
    async (e: React.MouseEvent): Promise<boolean> => {
      const hit = wordAtPoint(e.clientX, e.clientY)
      if (!hit || !pageRef.current) return false
      e.stopPropagation() // 不冒泡到 onStageClick 的句子浮条命中测试
      hideHover()
      // 竞态守卫（B5/N5）：写 readerStore 而非本地 ref——ReaderPage.onMouseUp
      // 的 setTimeout 回调（click 之后执行）读到后跳过并复位，
      // 否则其 below=first.top>64 会覆写这里写入的 toolbarBelow
      const store = useReader.getState()
      store.setSuppressSelection(true)
      // 兜底复位：覆盖 await 抛错等异常路径，防永久抑制
      window.setTimeout(() => { useReader.getState().setSuppressSelection(false) }, 500)

      // 先建真实 DOM 选区：SelectionToolbar 定位依赖真实选区存在
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(hit.range)
      const st = useReader.getState()
      const size = st.pageSizes[pageIndex]
      if (!size) { st.setSuppressSelection(false); return true }
      const baseGeom = { baseW: size.w, baseH: size.h, scale: st.scale }
      const visibleRects = clientRectsInPage(hit.range.getClientRects(), pageRef.current.getBoundingClientRect())
      const mergedRects = mergeClientRects(visibleRects, 1.0, baseGeom.scale)
      const rects = clientRectsToPdf(mergedRects, pageRef.current, baseGeom)
      const first = mergedRects[0]
      const text = hit.word.trim()
      if (!first || !rects.length || !text) { st.setSuppressSelection(false); return true }
      const fullText = ocrBlocks ? ocrPageText(ocrBlocks) : await ensurePageText(pdf, pageIndex)
      const ctx = extractSentenceContext(fullText, text)
      useReader.getState().setSelection({
        text,
        pageIndex,
        rects,
        sentence: ctx.sentence,
        prev: ctx.prev,
        next: ctx.next,
        toolbarX: first.left + first.width / 2,
        toolbarY: first.bottom + 10,
        toolbarBelow: true,
      })
      return true
    },
    [pdf, pageIndex, ocrBlocks, hideHover],
  )

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
      onMouseDown={(e) => {
        hideHover()
        onStageMouseDown(e)
      }}
      onMouseOver={onWordHover}
      onMouseOut={hideHover}
      onClick={(e) => {
        // 高亮生词词元 → 释义查询闭环；其余点击走句子批注浮条命中
        if (!onWordClick(e)) onStageClick(e)
      }}
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
        ref={stageRef}
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

        {/* 词带层：生词/搜索高亮，span 零污染，几何钳制到行盒（z-index 1 < textLayer 的 2） */}
        {wordHl.length > 0 && (
          <svg className="word-hl-svg" width={stageW} height={stageH}>
            {wordHl.map((b) => b.name === 'hl-stage-2'
              ? b.rects.map((r, i) => (
                  <line
                    key={`${b.name}-${i}`}
                    x1={r.left}
                    x2={r.left + r.width}
                    y1={r.top + r.height}
                    y2={r.top + r.height}
                    className="hl-stage-2"
                  />
                ))
              : b.rects.map((r, i) => (
                  <rect
                    key={`${b.name}-${i}`}
                    x={r.left}
                    y={r.top}
                    width={r.width}
                    height={r.height}
                    className={b.name}
                  />
                ))
            )}
          </svg>
        )}

        {/* 批注层：句子高亮 + 信息操作条 + word_note 锚点/连线/卡片 */}
        {rendered && (
          <AnnotationOverlay
            pageIndex={pageIndex}
            geom={stageGeom}
            cssW={stageW}
            cssH={stageH}
            lineBands={lineBands}
            ink={pageInk ?? undefined}
            inkScale={pageInkScale}
            locateId={locateAnnotationId}
            popoverId={popoverId}
            onClosePopover={() => setPopoverId(null)}
          />
        )}

        {/* 选区 Live 视觉兜底：::selection 透明后由本层渲染每行 1 块的蓝块 */}
        {rendered && (
          <SelectionOverlay
            pageIndex={pageIndex}
            geom={stageGeom}
            stageW={stageW}
            stageH={stageH}
            pageRef={pageRef}
            stageRef={stageRef}
            lineBands={lineBands}
            ink={pageInk ?? undefined}
            inkScale={pageInkScale}
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

      {/* 生词悬停释义卡（fixed 定位，挂页内但相对视口） */}
      {visible && hoverWord && <WordHoverCard lemma={hoverWord.lemma} anchorRect={hoverWord.rect} onClose={hideHover} />}
    </div>
  )
})

export default PageView