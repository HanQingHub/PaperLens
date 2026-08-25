// 阅读器页面：文档加载 · 单页/连续滚动 · 划词翻译 · 连线批注 · OCR 叠加 ·
// 页内搜索 · 大纲 · 进度恢复 · 阅读会话计时。组件保持薄壳：页渲染在 PageView，选区动作在
// SelectionToolbar，翻译卡片在 TranslateCard，跨模块通信走 readerBus。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getDocument } from 'pdfjs-dist'
import { api, fetchOcrBlocks, pdfFileUrl, saveBlobWithDialog, saveProgress } from '../../api/client'
import { loadPaperCached } from './paperPrefetch'
import { parseAnnotation, useReader } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { useWords } from '../../stores/words'
import { useUi } from '../../stores/ui'
import { clientRectsInPage, clientRectsToPdf } from '../../shared/coords'
import { RENDER_DEBOUNCE_MS, PROGRESS_SAVE_THROTTLE_MS, ZOOM_STEP_RATIO, mapOcrPollStatus } from './constants'
import '../../lib/pdfjsSetup'
import PageView from './PageView'
import { clearPageBitmaps } from './renderScheduler'
import SelectionToolbar, { type SelectionActions } from './SelectionToolbar'
import TranslateCard, { type TranslateRequest } from './TranslateCard'
import { clearIrregularCache } from './lemma'
import {
  ensurePageText,
  extractSentenceContext,
  ocrPageText,
} from './readerUtils'
import { toast } from '../shared/Toast'

/** 页间垂直间距（与 page-wrapper 的 mb-4 一致） */
const PAGE_GAP = 16
/** 懒解析：打开时同步解析的页数（其余等比占位、后台分批回填） */
const FIRST_PARSE_PAGES = 8

// ── 小工具 ────────────────────────────────────────────────
function pageTopOf(pageIndex: number, pageSizes: { w: number; h: number }[], scale: number) {
  let top = 0
  for (let i = 0; i < pageIndex; i++) top += pageSizes[i].h * scale + PAGE_GAP
  return top
}

function countOccurrences(hay: string, needle: string) {
  if (!needle) return 0
  let n = 0
  let idx = 0
  while ((idx = hay.indexOf(needle, idx)) >= 0) {
    n++
    idx += needle.length
  }
  return n
}

interface OutlineNode {
  title: string
  dest: unknown
  items?: OutlineNode[]
}

// ── 顶栏图标（线性小图标，学术蓝描边）────────────────────
const I = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const icons = {
  back: 'M19 12H5 M12 19l-7-7 7-7',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M8 21H5a2 2 0 0 1-2-2v-3 M16 21h3a2 2 0 0 0 2-2v-3',
  outline: 'M4 6h16 M4 12h10 M4 18h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  book: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  export: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  single: 'M4 4h16v16H4z',
  scroll: 'M4 4h16v7H4z M4 14h16v6H4z',
  words: 'M6 4h8a4 4 0 0 1 4 4v12H10a4 4 0 0 1-4-4V4z M9 9h6 M12 6v9',
}

export default function ReaderPage() {
  const params = useParams()
  const pid = Number(params.paperId)
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── reader store ──
  const paper = useReader((s) => s.paper)
  const pdf = useReader((s) => s.pdf)
  const numPages = useReader((s) => s.numPages)
  const pageSizes = useReader((s) => s.pageSizes)
  const loading = useReader((s) => s.loading)
  const loadError = useReader((s) => s.loadError)
  const mode = useReader((s) => s.mode)
  const scale = useReader((s) => s.scale)
  const currentPage = useReader((s) => s.currentPage)
  const renderRange = useReader((s) => s.renderRange)
  const selection = useReader((s) => s.selection)
  const toolbarVisible = useReader((s) => s.toolbarVisible)
  const linking = useReader((s) => s.linking)
  const ocrStatus = useReader((s) => s.ocrStatus)
  const ocrProgress = useReader((s) => s.ocrProgress)
  const ocrError = useReader((s) => s.ocrError)
  const searchOpen = useReader((s) => s.searchOpen)
  const outlineOpen = useReader((s) => s.outlineOpen)
  const annotationsCount = useReader((s) => s.annotations.length)

  const openPanel = useUi((s) => s.openPanel)
  const wordsLoaded = useWords((s) => s.loaded)
  const loadWords = useWords((s) => s.load)

  const [translateReq, setTranslateReq] = useState<TranslateRequest | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const actionsRef = useRef<SelectionActions | null>(null)
  const reqSeq = useRef(1)
  const rafScroll = useRef(0)
  const lastSave = useRef(0)
  const restoreRef = useRef<{ page: number; ratio: number } | null>(null)
  const [ocrBump, setOcrBump] = useState(0)

  // ── 两阶段缩放：scale 立即驱动布局与 CSS 位图拉伸（即时、零重渲染），
  // renderScale 防抖 180ms 提交后才触发 canvas/textLayer 高清重渲染。
  // 解决 Ctrl+滚轮连续缩放时每帧全量重绘多页 canvas 导致的卡顿。
  const [renderScale, setRenderScale] = useState(scale)
  useEffect(() => {
    if (scale === renderScale) return
    const t = window.setTimeout(() => setRenderScale(scale), RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [scale, renderScale])

  // ── 缩放锚点保持：以视图中心为锚，缩放后恢复到同一页内位置，
  // 解决缩放时页面尺寸变化导致视口内容跳走的问题。
  const prevScale = useRef(scale)
  useLayoutEffect(() => {
    const old = prevScale.current
    prevScale.current = scale
    if (old === scale) return
    const el = scrollRef.current
    const st = useReader.getState()
    if (!el || st.mode !== 'continuous' || !st.pageSizes.length) return
    const mid = el.scrollTop + el.clientHeight / 2
    let acc = 0
    let pageIdx = st.numPages - 1
    let ratio = 1
    for (let i = 0; i < st.numPages; i++) {
      const h = st.pageSizes[i].h * old
      if (mid < acc + h) {
        pageIdx = i
        ratio = Math.max(0, Math.min(1, (mid - acc) / h))
        break
      }
      acc += h + PAGE_GAP
    }
    const newMid =
      pageTopOf(pageIdx, st.pageSizes, scale) + ratio * st.pageSizes[pageIdx].h * scale
    el.scrollTop = newMid - el.clientHeight / 2
  }, [scale])

  // ── 文档加载（file-token 一次性取回全文，避免长会话 token 过期）──
  useEffect(() => {
    if (!Number.isFinite(pid)) return
    useReader.getState().reset()
    clearIrregularCache() // 文档切换：清空不规则词形缓存（跨文档无复用价值）
    clearPageBitmaps() // 文档切换：清空位图缓存
    let cancelled = false
    let task: ReturnType<typeof getDocument> | null = null
    ;(async () => {
      try {
        const [p, tk] = await Promise.all([loadPaperCached(pid), api.fileToken(pid)])
        if (cancelled) return
        const res = await fetch(pdfFileUrl(pid, tk.token))
        if (!res.ok) throw new Error(`PDF 加载失败（HTTP ${res.status}）`)
        const data = new Uint8Array(await res.arrayBuffer())
        if (cancelled) return
        task = getDocument({
          data,
          cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
          cMapPacked: true,
        })
        const doc = await task.promise
        if (cancelled) return
        // 懒解析：只同步解析首屏页拿真实尺寸，其余按首页宽高比占位，
        // 后台分批回填（大 PDF 的全页 getPage 是打开耗时主项）。
        // 占位数组恒为 full-length，所有高度数学消费方无需感知。
        const firstCount = Math.min(FIRST_PARSE_PAGES, doc.numPages)
        const firstPages = await Promise.all(
          Array.from({ length: firstCount }, (_, i) => doc!.getPage(i + 1)),
        )
        if (cancelled) return
        const sizes = firstPages.map((pg) => {
          const vp = pg.getViewport({ scale: 1 })
          return { w: vp.width, h: vp.height }
        })
        const first = sizes[0] ?? { w: 612, h: 792 }
        // 等比占位：未解析页沿用首页尺寸（学术 PDF 尺寸一致；回填后前缀恒定）
        const fullSizes = Array.from({ length: doc.numPages }, (_, i) => sizes[i] ?? first)
        useReader.getState().setDoc(p, doc!, fullSizes, doc.numPages)

        // 后台分批回填真实尺寸：顺序解析保证已解析前缀高度恒定，
        // 当前视口之前的页不再变化 → 视口内容不位移
        const BATCH = 16
        for (let start = firstCount; start < doc!.numPages; start += BATCH) {
          if (cancelled) return
          const end = Math.min(start + BATCH, doc!.numPages)
          const batch = await Promise.all(
            Array.from({ length: end - start }, (_, i) => doc!.getPage(start + i + 1)),
          )
          if (cancelled) return
          const real = batch.map((pg) => {
            const vp = pg.getViewport({ scale: 1 })
            return { w: vp.width, h: vp.height }
          })
          useReader.getState().appendPageSizes(start, real)
          // 让出主线程，避免大批量解析挤掉渲染帧
          await new Promise((r) => setTimeout(r, 0))
        }

        // 打开计数 + 读取旧进度（PUT open=true 会写回当前值，不覆盖）
        const prog = await api.readingProgress(pid).catch(() => null)
        if (cancelled) return
        const rp = Math.max(1, Math.min(prog?.page_no ?? 1, doc!.numPages))
        const ratio = Math.max(0, Math.min(1, prog?.scroll_y ?? 0))
        await saveProgress(pid, rp, ratio, true).catch(() => {})
        restoreRef.current = { page: rp, ratio }
      } catch (e) {
        if (!cancelled) useReader.getState().setLoadError(e instanceof Error ? e.message : '加载失败')
      }
    })()
    return () => {
      cancelled = true
      task?.destroy()
    }
  }, [pid])

  // 恢复阅读位置（文档就绪后）
  const scrollToPosition = useCallback((pageNo: number, ratio: number) => {
    const st = useReader.getState()
    const p = Math.max(1, Math.min(pageNo, st.numPages || pageNo))
    if (st.mode === 'single') {
      st.setCurrentPage(p)
      return
    }
    const el = scrollRef.current
    if (!el || !st.pageSizes.length) return
    const top = pageTopOf(p - 1, st.pageSizes, st.scale)
    const h = (st.pageSizes[p - 1]?.h ?? 0) * st.scale
    el.scrollTop = top + ratio * h
  }, [])

  useEffect(() => {
    if (loading || !numPages || !restoreRef.current) return
    const { page, ratio } = restoreRef.current
    restoreRef.current = null
    const t = requestAnimationFrame(() => scrollToPosition(page, ratio))
    return () => cancelAnimationFrame(t)
  }, [loading, numPages, scrollToPosition])

  // ── 批注加载 ──
  useEffect(() => {
    if (!Number.isFinite(pid)) return
    api
      .annotations(pid)
      .then((list) => useReader.getState().setAnnotations(list.map(parseAnnotation)))
      .catch(() => {})
  }, [pid])

  // ── 生词库（高亮匹配用）──
  useEffect(() => {
    if (!wordsLoaded) loadWords().catch(() => {})
  }, [wordsLoaded, loadWords])

  // ── OCR：done 拉结果 / pending|running 轮询 ──
  useEffect(() => {
    if (!Number.isFinite(pid)) return
    let stop = false
    let timer = 0
    const st0 = useReader.getState()
    const loadBlocks = async () => {
      try {
        const pages = await fetchOcrBlocks(pid)
        const map = new Map<number, typeof pages[number]['blocks']>()
        for (const pg of pages) map.set(pg.page - 1, pg.blocks)
        if (!stop) useReader.getState().setOcr('done', map)
      } catch {
        // 结果拉取失败：标记 failed 供用户重试，不误报 done（否则扫描版静默显示无文本）
        if (!stop) {
          useReader.getState().setOcr('failed')
          toast('OCR 结果加载失败', 'error')
        }
      }
    }
    const tick = async () => {
      try {
        const st = await api.ocrStatus(pid)
        if (stop) return
        const r = useReader.getState()
        // done/failed/none（取消后）与未知状态一律停止轮询，避免空转死循环
        const dec = mapOcrPollStatus(st.status)
        if (dec.ui === 'done') {
          await loadBlocks()
          return
        }
        if (dec.ui === 'failed') {
          r.setOcr('failed')
          r.setOcrProgress(null, st.error)
          return
        }
        // 仅在值变化时写 store：轮询每秒一次，无变化不触发界面重渲染
        if (r.ocrStatus !== dec.ui) r.setOcr(dec.ui)
        if (!dec.keepPolling) return
        const prev = r.ocrProgress
        if (!prev || prev.done !== st.pages_done || prev.total !== st.pages_total) {
          r.setOcrProgress({ done: st.pages_done, total: st.pages_total })
        }
        timer = window.setTimeout(tick, 1000)
      } catch {
        if (!stop) timer = window.setTimeout(tick, 3000)
      }
    }
    const status = st0.paper?.ocr_status
    if (status === 'done') loadBlocks()
    else if (status === 'pending' || status === 'running') {
      st0.setOcr(status)
      tick()
    }
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [pid, paper?.ocr_status, ocrBump])

  // ── readerBus 注册（右面板 ↔ 阅读器）──
  const goto = useCallback(
    (pageNo: number, annotationId?: number) => {
      scrollToPosition(pageNo, 0)
      if (annotationId != null) useReader.getState().setLocateAnnotation(annotationId)
    },
    [scrollToPosition],
  )

  useEffect(() => {
    useReaderBus.setState({ paperId: pid })
    useReaderBus.getState().registerGoto(goto)
    return () => {
      useReaderBus.getState().registerGoto(null)
      useReaderBus.setState({ paperId: null })
    }
  }, [pid, goto])

  // ── 阅读会话计时（窗口失焦暂停）──
  useEffect(() => {
    if (!Number.isFinite(pid)) return
    const s = { start: new Date().toISOString(), seconds: 0, lastTick: Date.now(), focused: document.hasFocus() }
    const flush = () => {
      if (s.focused) {
        s.seconds += (Date.now() - s.lastTick) / 1000
        s.lastTick = Date.now()
      }
    }
    const onFocus = () => {
      s.lastTick = Date.now()
      s.focused = true
    }
    const onBlur = () => {
      flush()
      s.focused = false
    }
    const iv = window.setInterval(flush, 5000)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      flush()
      window.clearInterval(iv)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      const dur = Math.round(s.seconds)
      if (dur >= 3) api.readingSession(pid, s.start, new Date().toISOString()).catch(() => {})
    }
  }, [pid])

  // ── 缩放 ──
  const zoomBy = useCallback((f: number) => {
    const st = useReader.getState()
    st.setScale(st.scale * f)
  }, [])
  const fitWidth = useCallback(() => {
    const el = scrollRef.current
    const st = useReader.getState()
    if (!el || !st.pageSizes.length) return
    const w = st.pageSizes[st.currentPage - 1]?.w ?? 612
    st.setScale(Math.max(0.3, (el.clientWidth - 96) / w), true)
  }, [])

  // Ctrl+滚轮缩放（原生监听，passive=false 才能 preventDefault）
  // rAF 合帧：触控板 wheel 可达 60-120Hz，每帧只提交一次累计倍率，
  // 避免同一帧内多次 setScale 引发的连锁重渲染
  const zoomAccum = useRef(1)
  const zoomRaf = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      // 按滚动量缩放：触控板微滚动小步长，鼠标滚轮大步长
      zoomAccum.current *= Math.pow(e.deltaY < 0 ? ZOOM_STEP_RATIO : 1 / ZOOM_STEP_RATIO, Math.min(120, Math.abs(e.deltaY)))
      if (zoomRaf.current) return
      zoomRaf.current = requestAnimationFrame(() => {
        zoomRaf.current = 0
        const f = zoomAccum.current
        zoomAccum.current = 1
        const st = useReader.getState()
        st.setScale(st.scale * f)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (zoomRaf.current) cancelAnimationFrame(zoomRaf.current)
    }
  }, [loading])

  // ── 翻页（单页模式 / 页码跳转）──
  const gotoPage = useCallback(
    (pageNo: number, save = true) => {
      const st = useReader.getState()
      const p = Math.max(1, Math.min(pageNo, st.numPages || 1))
      st.setCurrentPage(p)
      st.setSelection(null)
      if (st.mode === 'single') scrollToPosition(p, 0)
      if (save) saveProgress(pid, p, 0).catch(() => {})
    },
    [pid, scrollToPosition],
  )

  // ── 划词选区（mouseup 统一入口）──
  const onMouseUp = useCallback(() => {
    const st = useReader.getState()
    if (st.linking) return
    window.setTimeout(async () => {
      const sel = window.getSelection()
      const cur = useReader.getState()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        if (cur.selection) cur.setSelection(null)
        return
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim()
      const node = sel.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      const pageEl = el?.closest('.page-wrapper') as HTMLElement | null
      if (!pageEl) return
      const pageIndex = Number(pageEl.dataset.pageIndex)
      const size = cur.pageSizes[pageIndex]
      if (!size) return
      const geom = { baseW: size.w, baseH: size.h, scale: cur.scale }
      const range = sel.getRangeAt(0)
      // 跨页选区：只换算基准页内的矩形，相邻页部分用本页原点换算必错位
      const visibleRects = clientRectsInPage(range.getClientRects(), pageEl.getBoundingClientRect())
      const rects = clientRectsToPdf(visibleRects, pageEl, geom)
      const first = visibleRects[0]
      if (!first || !rects.length) return
      const blocks = cur.ocrBlocks.get(pageIndex)
      const fullText = blocks ? ocrPageText(blocks) : cur.pdf ? await ensurePageText(cur.pdf, pageIndex) : ''
      const ctx = extractSentenceContext(fullText, text)
      const below = first.top > 64
      useReader.getState().setSelection({
        text,
        pageIndex,
        rects,
        sentence: ctx.sentence,
        prev: ctx.prev,
        next: ctx.next,
        toolbarX: first.left + first.width / 2,
        toolbarY: below ? first.bottom + 10 : Math.max(52, first.top - 46),
        toolbarBelow: below,
      })
    }, 0)
  }, [])

  // ── 翻译请求（工具条 / 快捷键 T 共用）──
  const onTranslate = useCallback((mode: 'word' | 'dict') => {
    const sel = useReader.getState().selection
    if (!sel) return
    const words = sel.text.trim().split(/\s+/)
    const isSentence = words.length > 6
    setTranslateReq({
      id: reqSeq.current++,
      word: mode === 'dict' || !isSentence ? (words[0] ?? '') : sel.text.slice(0, 80),
      sentence: sel.sentence || sel.text,
      prev: sel.prev,
      next: sel.next,
      mode,
      autoSentence: mode === 'word' && isSentence,
      x: sel.toolbarX,
      y: sel.toolbarY + 42,
      below: true,
    })
  }, [])

  // ── 快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const inInput = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const st = useReader.getState()
      if (e.key === 'Escape') {
        if (st.linking) {
          st.setLinking(null)
          return
        }
        setTranslateReq(null)
        setExportOpen(false)
        if (st.searchOpen) st.toggleSearch(false)
        if (st.outlineOpen) st.toggleOutline(false)
        if (st.selection) {
          st.setSelection(null)
          window.getSelection()?.removeAllRanges()
        }
        return
      }
      if (e.ctrlKey || e.metaKey) {
        if (inInput) return
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          zoomBy(1.2)
        } else if (e.key === '-') {
          e.preventDefault()
          zoomBy(1 / 1.2)
        } else if (e.key === '0') {
          e.preventDefault()
          fitWidth()
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault()
          st.toggleSearch(true)
        }
        return
      }
      if (inInput || e.altKey) return
      const hasSel = !!st.selection
      switch (e.key.toLowerCase()) {
        case 't':
          if (hasSel) onTranslate('word')
          break
        case 'b':
          if (hasSel) actionsRef.current?.startLinking()
          break
        case 'w':
          if (hasSel) actionsRef.current?.addWord()
          break
        case 'h':
          if (hasSel) actionsRef.current?.highlight()
          break
        case 'arrowleft':
        case 'pageup':
          if (st.mode === 'single') gotoPage(st.currentPage - 1)
          break
        case 'arrowright':
        case 'pagedown':
          if (st.mode === 'single') gotoPage(st.currentPage + 1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBy, fitWidth, onTranslate, gotoPage])

  // ── 滚动：可见页 / 懒渲染范围 / 进度节流保存 ──
  const onScroll = useCallback(() => {
    if (rafScroll.current) return
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0
      const el = scrollRef.current
      const st = useReader.getState()
      if (!el || st.mode !== 'continuous' || !st.pageSizes.length) return
      const viewTop = el.scrollTop
      const viewBot = viewTop + el.clientHeight
      const mid = viewTop + el.clientHeight / 2
      let acc = 0
      let firstVisible = -1
      let lastVisible = -1
      let current = 0
      let best = Infinity
      for (let i = 0; i < st.numPages; i++) {
        const h = st.pageSizes[i].h * st.scale
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
      const range: [number, number] = [
        Math.max(0, firstVisible - 2),
        Math.min(st.numPages - 1, lastVisible + 2),
      ]
      if (range[0] !== st.renderRange[0] || range[1] !== st.renderRange[1]) st.setRenderRange(range)
      if (current + 1 !== st.currentPage) st.setCurrentPage(current + 1)
      // 进度节流 2s
      const now = Date.now()
      if (now - lastSave.current > PROGRESS_SAVE_THROTTLE_MS) {
        lastSave.current = now
        const top = pageTopOf(current, st.pageSizes, st.scale)
        const h = st.pageSizes[current].h * st.scale
        const ratio = Math.max(0, Math.min(1, (viewTop - top) / Math.max(1, h)))
        saveProgress(pid, current + 1, ratio).catch(() => {})
      }
    })
  }, [pid])

  // ── 导出 ──
  const exportPdf = async () => {
    setExportOpen(false)
    try {
      const blob = await api.exportAnnotationsPdf(pid)
      const saved = await saveBlobWithDialog(blob, `${paper?.title?.slice(0, 40) || 'paper'}_批注版.pdf`)
      if (!saved) return
      toast('已导出批注写回副本', 'ok')
    } catch {
      toast('导出失败', 'error')
    }
  }
  const exportMd = async () => {
    setExportOpen(false)
    try {
      const blob = await api.exportAnnotationsMd(pid)
      const saved = await saveBlobWithDialog(blob, `${paper?.title?.slice(0, 40) || 'paper'}_批注.md`)
      if (!saved) return
      toast('已导出批注 Markdown', 'ok')
    } catch {
      toast('导出失败', 'error')
    }
  }

  // OCR 启动 / 重试
  const startOcr = async (retry = false) => {
    try {
      if (retry) await api.retryOcr(pid)
      else await api.startOcr(pid)
      useReader.getState().setOcr('pending')
      setOcrBump((b) => b + 1)
    } catch {
      toast('OCR 任务提交失败', 'error')
    }
  }

  const pagesIdx = useMemo(() => Array.from({ length: numPages }, (_, i) => i), [numPages])

  // ── 渲染：isStale 防止切换文档时闪现旧内容（useEffect reset 在首帧后才执行）──
  const isStale = paper != null && paper.id !== pid
  if (loadError && !isStale) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-soft">
        <p className="text-sm text-danger">{loadError}</p>
        <button className="btn" onClick={() => navigate('/')}>
          返回文库
        </button>
      </div>
    )
  }

  return (
    <div className={`relative flex h-full flex-col overflow-hidden bg-bg-soft ${linking ? 'reader-linking' : ''}`}>
      {/* ── 阅读器顶栏 ── */}
      <div className="glass z-20 flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <button className="rd-tbtn" title="返回文库" onClick={() => navigate('/')}>
          <I d={icons.back} />
        </button>
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium" title={isStale ? undefined : paper?.title}>
            {isStale ? '…' : (paper?.title ?? '…')}
          </span>
          {!isStale && paper?.is_favorite && <span className="text-[11px] text-accent">★</span>}
        </div>

        {/* 页码 */}
        <PageIndicator numPages={numPages} onCommit={gotoPage} />

        {/* 缩放 */}
        <span className="mx-1 h-4 w-px bg-border-strong" />
        <button className="rd-tbtn" title="缩小 (Ctrl+-)" onClick={() => zoomBy(1 / 1.2)}>
          <I d={icons.minus} />
        </button>
        <span className="w-10 text-center text-[11px] tabular-nums text-text-faint">{Math.round(scale * 100)}%</span>
        <button className="rd-tbtn" title="放大 (Ctrl+=)" onClick={() => zoomBy(1.2)}>
          <I d={icons.plus} />
        </button>
        <button className="rd-tbtn" title="适应宽度 (Ctrl+0)" onClick={fitWidth}>
          <I d={icons.fit} />
        </button>

        {/* 模式切换 */}
        <span className="mx-1 h-4 w-px bg-border-strong" />
        <div className="flex items-center rounded-md border border-border p-0.5">
          <button
            className={`rd-seg ${mode === 'single' ? 'rd-seg-on' : ''}`}
            title="单页模式（←/→ 翻页）"
            onClick={() => useReader.getState().setMode('single')}
          >
            <I d={icons.single} size={12} />
          </button>
          <button
            className={`rd-seg ${mode === 'continuous' ? 'rd-seg-on' : ''}`}
            title="连续滚动"
            onClick={() => useReader.getState().setMode('continuous')}
          >
            <I d={icons.scroll} size={12} />
          </button>
        </div>

        <span className="mx-1 h-4 w-px bg-border-strong" />
        <button
          className={`rd-tbtn ${outlineOpen ? 'rd-tbtn-on' : ''}`}
          title="目录大纲"
          onClick={() => useReader.getState().toggleOutline()}
        >
          <I d={icons.outline} />
        </button>
        <button
          className={`rd-tbtn ${searchOpen ? 'rd-tbtn-on' : ''}`}
          title="页内搜索 (Ctrl+F)"
          onClick={() => useReader.getState().toggleSearch()}
        >
          <I d={icons.search} />
        </button>
        <button className="rd-tbtn" title="批注与摘录面板" onClick={() => openPanel('annotations')}>
          <span className="relative">
            <I d={icons.note} />
            {annotationsCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-accent px-0.5 text-[8px] font-semibold text-white">
                {annotationsCount}
              </span>
            )}
          </span>
        </button>
        <button className="rd-tbtn" title="生词库" onClick={() => openPanel('words')}>
          <I d={icons.words} />
        </button>
        <button className="rd-tbtn" title="本文术语表" onClick={() => openPanel('glossary')}>
          <I d={icons.book} />
        </button>

        {/* 导出菜单 */}
        <div className="relative">
          <button className="rd-tbtn" title="导出批注" onClick={() => setExportOpen((v) => !v)}>
            <I d={icons.export} />
          </button>
          {exportOpen && (
            <div className="menu-pop">
              <button onClick={exportPdf}>写回 PDF 副本</button>
              <button onClick={exportMd}>Markdown 列表</button>
            </div>
          )}
        </div>
      </div>

      {/* ── 主区域 ── */}
      <div className="relative min-h-0 flex-1">
        {loading || isStale ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-text-faint">
            <div className="spinner spinner-lg" />
            <span className="text-xs">正在打开论文…</span>
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="h-full overflow-auto overscroll-none"
            onScroll={onScroll}
            onMouseUp={onMouseUp}
          >
            <div className="mx-auto w-max px-10 py-6">
              {mode === 'continuous'
                ? pagesIdx.map((i) => {
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
                          <span className="flex h-full items-center justify-center text-[11px] text-text-faint">
                            {i + 1}
                          </span>
                        </div>
                      )
                    }
                    return <PageView key={i} pdf={pdf!} pageIndex={i} active renderScale={renderScale} />
                  })
                : pdf &&
                  pageSizes[currentPage - 1] && (
                    <PageView pdf={pdf} pageIndex={currentPage - 1} active renderScale={renderScale} />
                  )}
            </div>
          </div>
        )}

        {/* 大纲抽屉 */}
        {outlineOpen && !loading && !isStale && <OutlineDrawer onGoto={(p) => gotoPage(p, false)} />}

        {/* 页内搜索 */}
        {searchOpen && !loading && !isStale && <SearchBar onEnterPage={(i) => scrollToPosition(i + 1, 0)} />}

        {/* OCR 状态条 */}
        {!loading && !isStale && paper && (
          <OcrBanner
            paper={paper}
            status={ocrStatus}
            progress={ocrProgress}
            error={ocrError}
            onStart={() => startOcr(false)}
            onRetry={() => startOcr(true)}
          />
        )}

        {/* 连线模式提示 */}
        {linking && !linking.cardDraft && (
          <div className="glass pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border-strong px-4 py-1.5 text-xs text-text-soft shadow-[var(--shadow-1)]">
            从锚点按住拖动到页边任意位置松开落卡 · Esc 取消
          </div>
        )}
      </div>

      {/* ── 浮动层 ── */}
      {toolbarVisible && selection && (
        <SelectionToolbar onTranslate={onTranslate} onToast={(m) => toast(m)} actionsRef={actionsRef} />
      )}
      <TranslateCard paperId={pid} request={translateReq} onClose={() => setTranslateReq(null)} onToast={(m) => toast(m)} />
    </div>
  )
}

// ── 页码指示器（输入跳转）────────────────────────────────
function PageIndicator({ numPages, onCommit }: { numPages: number; onCommit: (p: number) => void }) {
  const currentPage = useReader((s) => s.currentPage)
  const [val, setVal] = useState(String(currentPage))
  useEffect(() => setVal(String(currentPage)), [currentPage])
  const commit = () => {
    const n = parseInt(val, 10)
    if (Number.isFinite(n)) onCommit(n)
    else setVal(String(currentPage))
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-text-faint">
      <input
        className="input h-6 w-11 px-1 text-center text-[11px] tabular-nums"
        value={val}
        onChange={(e) => setVal(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      / {numPages || '…'}
    </span>
  )
}

// ── 大纲抽屉 ──────────────────────────────────────────────
function OutlineDrawer({ onGoto }: { onGoto: (pageNo: number) => void }) {
  const pdf = useReader((s) => s.pdf)
  const toggleOutline = useReader((s) => s.toggleOutline)
  const [tree, setTree] = useState<OutlineNode[] | null>(null)

  useEffect(() => {
    let stop = false
    pdf
      ?.getOutline()
      .then((o) => !stop && setTree((o as OutlineNode[] | null) ?? []))
      .catch(() => !stop && setTree([]))
    return () => {
      stop = true
    }
  }, [pdf])

  const go = async (dest: unknown) => {
    if (!pdf) return
    try {
      let d = dest
      if (typeof d === 'string') d = await pdf.getDestination(d)
      if (!Array.isArray(d) || !d.length) return
      const idx = await pdf.getPageIndex(d[0] as { num: number; gen: number })
      onGoto(idx + 1)
    } catch {
      /* 目标解析失败忽略 */
    }
  }

  const renderNodes = (nodes: OutlineNode[], depth: number) =>
    nodes.map((n, i) => (
      <div key={`${depth}-${i}`}>
        <button
          className="block w-full truncate rounded-md px-2 py-1 text-left text-[12px] text-text-soft transition-colors hover:bg-accent-soft hover:text-accent"
          style={{ paddingLeft: 8 + depth * 14 }}
          title={n.title}
          onClick={() => go(n.dest)}
        >
          {n.title || '（未命名）'}
        </button>
        {n.items?.length ? renderNodes(n.items, depth + 1) : null}
      </div>
    ))

  return (
    <aside className="slide-in absolute left-2 top-2 z-30 flex max-h-[calc(100%-16px)] w-64 flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-[var(--shadow-2)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium">目录大纲</span>
        <button className="px-1 text-xs text-text-faint hover:text-danger" onClick={() => toggleOutline(false)}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tree === null ? (
          <p className="p-3 text-center text-[11px] text-text-faint">加载中…</p>
        ) : tree.length === 0 ? (
          <p className="p-3 text-center text-[11px] text-text-faint">此 PDF 没有目录大纲</p>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>
    </aside>
  )
}

// ── 页内搜索（全文/OCR 文本，跨页计数 + Enter 跳转）──────
function SearchBar({ onEnterPage }: { onEnterPage: (pageIndex: number) => void }) {
  const pdf = useReader((s) => s.pdf)
  const numPages = useReader((s) => s.numPages)
  const searchTerm = useReader((s) => s.searchTerm)
  const setSearchTerm = useReader((s) => s.setSearchTerm)
  const setSearchFocusPage = useReader((s) => s.setSearchFocusPage)
  const toggleSearch = useReader((s) => s.toggleSearch)

  const [query, setQuery] = useState(searchTerm)
  const [matches, setMatches] = useState<{ page: number; count: number }[]>([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim().toLowerCase()
    setSearchTerm(q)
    if (!q || !pdf) {
      setMatches([])
      setSearchFocusPage(null)
      setBusy(false)
      return
    }
    const my = ++seq.current
    setBusy(true)
    const timer = window.setTimeout(async () => {
      const out: { page: number; count: number }[] = []
      for (let i = 0; i < numPages; i++) {
        if (seq.current !== my) return
        try {
          const st = useReader.getState()
          const blocks = st.ocrBlocks.get(i)
          const text = blocks ? ocrPageText(blocks) : await ensurePageText(pdf, i)
          const count = countOccurrences(text.toLowerCase(), q)
          if (count) out.push({ page: i, count })
        } catch {
          /* 单页失败跳过 */
        }
      }
      if (seq.current !== my) return
      setMatches(out)
      setBusy(false)
      setSearchFocusPage(out.length ? out[0].page : null)
      if (out.length) onEnterPage(out[0].page)
    }, 350)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pdf, numPages])

  const total = matches.reduce((s, m) => s + m.count, 0)

  const jump = (dir: 1 | -1) => {
    if (!matches.length) return
    const pages = matches.map((m) => m.page)
    const cur = useReader.getState().searchFocusPage
    let i = cur == null ? (dir > 0 ? -1 : 0) : pages.indexOf(cur)
    i += dir
    if (i >= pages.length) i = 0
    if (i < 0) i = pages.length - 1
    setSearchFocusPage(pages[i])
    onEnterPage(pages[i])
  }

  return (
    <div className="glass fade-in absolute right-3 top-2 z-30 flex items-center gap-1 rounded-lg border border-border-strong px-2 py-1.5 shadow-[var(--shadow-2)]">
      <input
        autoFocus
        className="input h-6 w-40 px-2 text-xs"
        placeholder="页内搜索…（Enter 下一个）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1)
        }}
      />
      <span className="min-w-14 text-center text-[10px] tabular-nums text-text-faint">
        {busy ? '搜索中…' : query.trim() ? `${total} 处 / ${matches.length} 页` : ''}
      </span>
      <button className="rd-tbtn" title="上一个 (Shift+Enter)" onClick={() => jump(-1)}>
        ↑
      </button>
      <button className="rd-tbtn" title="下一个 (Enter)" onClick={() => jump(1)}>
        ↓
      </button>
      <button
        className="rd-tbtn"
        title="关闭 (Esc)"
        onClick={() => {
          setQuery('')
          setSearchTerm('')
          setSearchFocusPage(null)
          toggleSearch(false)
        }}
      >
        ✕
      </button>
    </div>
  )
}

// ── OCR 状态条 ────────────────────────────────────────────
function OcrBanner({
  paper,
  status,
  progress,
  error,
  onStart,
  onRetry,
}: {
  paper: { is_scanned: boolean; id?: number }
  status: string
  progress: { done: number; total: number } | null
  error: string | null
  onStart: () => void
  onRetry: () => void
}) {
  if (status === 'done' || (!paper.is_scanned && status === 'none')) return null
  return (
    <div className="glass fade-in absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border-strong px-4 py-2 text-xs shadow-[var(--shadow-2)]">
      {(status === 'pending' || status === 'running') && (
        <>
          <span className="spinner" />
          <span className="text-text-soft">
            OCR 解析中{progress ? ` · ${progress.done}/${progress.total} 页` : '…'}
          </span>
          {status === 'pending' && (paper as { id?: number }).id && (
            <button
              className="btn px-2 py-0.5 text-[11px]"
              onClick={async () => {
                const id = (paper as { id?: number }).id
                if (!id) return
                try {
                  await api.cancelOcr(id)
                  // 服务端已回 none：同步本地状态并停轮询（tick 白名单亦兜底）
                  useReader.getState().setOcr('none')
                  toast('已取消排队', 'ok')
                } catch {
                  toast('取消失败', 'error')
                }
              }}
            >
              取消
            </button>
          )}
        </>
      )}
      {status === 'failed' && (
        <>
          <span className="text-danger">OCR 失败{error ? `：${error.slice(0, 40)}` : ''}</span>
          <button className="btn px-2.5 py-0.5 text-[11px]" onClick={onRetry}>
            重试（跳过已完成页）
          </button>
        </>
      )}
      {status === 'none' && paper.is_scanned && (
        <>
          <span className="text-text-soft">扫描版论文：OCR 后可选中文字并翻译</span>
          <button className="btn btn-primary px-2.5 py-0.5 text-[11px]" onClick={onStart}>
            开始 OCR
          </button>
        </>
      )}
    </div>
  )
}
