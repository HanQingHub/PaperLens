import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { ApiError, api, fetchOcrBlocks, pdfFileUrl, saveBlobWithDialog, saveProgress } from '../api/client'
import { parseAnnotation, useReader } from '../stores/readerStore'
import { useReaderBus } from '../stores/readerBus'
import { useWords } from '../stores/words'
import { useUi } from '../stores/ui'
import {
  dropDoc,
  getView,
  hasReaderTab,
  stashDoc,
  takeDoc,
  takeMdFirstOpen,
  useReaderTabs,
} from '../stores/readerTabs'
import { useCompareStore } from '../stores/compareStore'
import { useRefLink } from '../stores/refLinkStore'
import { guardMdNav } from '../features/reader/mdDirty'
import { loadPaperCached } from '../features/reader/paperPrefetch'
import { clearIrregularCache } from '../features/reader/lemma'
import { clearPageBitmaps, clearRenderQueue } from '../features/reader/renderScheduler'
import { clientRectsInPage, clientRectsToPdf, mergeClientRects } from '../shared/coords'
import {
  PROGRESS_SAVE_THROTTLE_MS,
  RENDER_DEBOUNCE_MS,
  ZOOM_STEP_RATIO,
  mapOcrPollStatus,
} from '../features/reader/constants'
import { ensurePageText, extractSentenceContext, ocrPageText } from '../features/reader/readerUtils'
import { isSentenceSelection } from '../features/reader/translateView'
import PageView from '../features/reader/PageView'
import ComparePane from '../features/reader/ComparePane'
import InkToolbar from '../features/reader/InkToolbar'
import ThumbnailRail from '../features/reader/ThumbnailRail'
import MarkdownReader from '../features/reader/MarkdownReader'
import SelectionToolbar, { type SelectionActions } from '../features/reader/SelectionToolbar'
import TranslateCard, { type TranslateRequest } from '../features/reader/TranslateCard'
import Dropdown from '../features/shared/Dropdown'
import Modal from '../features/shared/Modal'
import { toast } from '../features/shared/Toast'
import {
  IconBook,
  IconFit,
  IconMenu,
  IconMinus,
  IconPencil,
  IconPlus,
  IconSearch,
  IconStar,
  IconX,
} from '../components/shared/Icon'
import { registerReaderFlush } from './stylePreference'
import '../lib/pdfjsSetup'
import './NextReaderPage.css'

const PAGE_GAP = 16
const FIRST_PARSE_PAGES = 8

interface PageSize {
  w: number
  h: number
}

interface OutlineNode {
  title: string
  dest: unknown
  items?: OutlineNode[]
}

function pageTopOf(pageIndex: number, pageSizes: PageSize[], scale: number) {
  let top = 0
  for (let i = 0; i < pageIndex; i++) top += pageSizes[i].h * scale + PAGE_GAP
  return top
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count++
    index += needle.length
  }
  return count
}

function destroyPdf(doc: PDFDocumentProxy) {
  try {
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch(() => {})
  } catch {
    // 已销毁的 worker 在世代切换时可能同步抛错，所有权清理仍需继续。
  }
}

type PdfTask = ReturnType<typeof getDocument>

function destroyTask(task: PdfTask | null) {
  if (!task) return
  try {
    void task.destroy().catch(() => {})
  } catch {
    // 同上：worker 竞态下 destroy 可能同步抛错。
  }
}

export default function NextReaderPage() {
  const params = useParams()
  const pid = Number(params.paperId)
  const validPid = Number.isInteger(pid) && pid > 0
  const navigate = useNavigate()

  const scrollRef = useRef<HTMLDivElement>(null)
  const mdHostRef = useRef<HTMLDivElement>(null)
  const mainAreaRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef<number | null>(null)
  const mdRatioRef = useRef<number | null>(null)
  const actionsRef = useRef<SelectionActions | null>(null)
  const reqSeq = useRef(1)
  const rafScroll = useRef(0)
  const lastSave = useRef(0)
  const restoreRef = useRef<{ page: number; ratio: number } | null>(null)
  const loadGenRef = useRef(0)
  const fetchAnnoSeq = useRef(0)

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
  const annotationsCount = useReader((s) => s.annotations.filter((a) => a.type !== 'ink').length)
  const inkActive = useReader((s) => s.ink.active)
  const refFlash = useRefLink((s) => s.flash)
  const annotationsVersion = useReaderBus((s) => s.annotationsVersion)

  const openPanel = useUi((s) => s.openPanel)
  const wordsLoaded = useWords((s) => s.loaded)
  const loadWords = useWords((s) => s.load)

  const allTabs = useReaderTabs((s) => s.tabs)
  const comparePaperId = useCompareStore((s) => s.paperId)
  const compareRatio = useCompareStore((s) => s.ratio)
  const setCompareRatio = useCompareStore((s) => s.setRatio)
  const setComparePaper = useCompareStore((s) => s.setPaper)
  const compareOpen = comparePaperId != null

  const [translateReq, setTranslateReq] = useState<TranslateRequest | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportColor, setExportColor] = useState('')
  const [exportType, setExportType] = useState('')
  const [outlineMissing, setOutlineMissing] = useState(false)
  const [restoreTick, setRestoreTick] = useState(0)
  const [ocrBump, setOcrBump] = useState(0)
  const [loadGen, setLoadGen] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [missing, setMissing] = useState(false)
  const [renderScale, setRenderScale] = useState(scale)
  const [auditedPid, setAuditedPid] = useState<number | null>(null)

  const currentTab = allTabs.find((tab) => tab.kind === 'reader' && tab.paperId === pid)
  const tabInvalid = validPid && auditedPid === pid && !currentTab
  const otherReaderTabs = useMemo(
    () => allTabs.filter(
      (tab) => tab.kind === 'reader'
        && tab.paperId != null
        && tab.paperId !== pid
        && tab.paperId !== comparePaperId
        && tab.fileType !== 'markdown',
    ),
    [allTabs, pid, comparePaperId],
  )

  // 页签对账由外壳 effect 异步补齐；延迟一帧审计，避免直达链接误报“页签失效”。
  useEffect(() => {
    setAuditedPid(null)
    const raf = requestAnimationFrame(() => setAuditedPid(validPid ? pid : null))
    return () => cancelAnimationFrame(raf)
  }, [pid, validPid, allTabs])

  // scale 立即改变布局；renderScale 停顿 180ms 后才驱动 PageView 高清重绘。
  useEffect(() => {
    if (scale === renderScale) return
    const timer = window.setTimeout(() => setRenderScale(scale), RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [scale, renderScale])

  // 连续模式缩放以视口中心为锚，保持同一页的页内位置。
  const prevScale = useRef(scale)
  useLayoutEffect(() => {
    const old = prevScale.current
    prevScale.current = scale
    if (old === scale) return
    const el = scrollRef.current
    const state = useReader.getState()
    if (!el || state.mode !== 'continuous' || !state.pageSizes.length) return
    const mid = el.scrollTop + el.clientHeight / 2
    let acc = 0
    let pageIndex = state.numPages - 1
    let ratio = 1
    for (let i = 0; i < state.numPages; i++) {
      const height = state.pageSizes[i].h * old
      if (mid < acc + height) {
        pageIndex = i
        ratio = Math.max(0, Math.min(1, (mid - acc) / height))
        break
      }
      acc += height + PAGE_GAP
    }
    const newMid = pageTopOf(pageIndex, state.pageSizes, scale)
      + ratio * state.pageSizes[pageIndex].h * scale
    el.scrollTop = newMid - el.clientHeight / 2
  }, [scale])

  const flushReaderProgress = useCallback(async () => {
    if (!validPid) return
    const state = useReader.getState()
    if (state.paper?.id !== pid) return

    if (state.paper.file_type === 'markdown') {
      // 滚动比来自 MarkdownReader 容器冒泡事件（mdRatioRef），不查询内部 DOM。
      const ratio = mdRatioRef.current
      if (ratio == null) return
      await saveProgress(pid, 1, Math.max(0, Math.min(1, ratio))).catch(() => {})
      return
    }

    if (state.mode === 'single') {
      await saveProgress(pid, state.currentPage, 0).catch(() => {})
      return
    }
    const page = state.pageSizes[state.currentPage - 1]
    if (!page) return
    const scrollTop = scrollRef.current?.scrollTop ?? scrollTopRef.current
    if (scrollTop == null) return
    const top = pageTopOf(state.currentPage - 1, state.pageSizes, state.scale)
    const ratio = Math.max(0, Math.min(1, (scrollTop - top) / Math.max(1, page.h * state.scale)))
    await saveProgress(pid, state.currentPage, ratio).catch(() => {})
  }, [pid, validPid])

  // 界面切换前由阅读器自己提供准确进度（位置快照），不依赖外部 DOM 猜测；
  // 注册 async 回调，卸载时传 null 解除。
  useEffect(() => {
    registerReaderFlush(flushReaderProgress)
    return () => registerReaderFlush(null)
  }, [flushReaderProgress])

  // 文档加载：世代 + Abort + worker 竞态重试；文档显示中与缓存互斥持有。
  useEffect(() => {
    if (!validPid || tabInvalid) return
    const gen = ++loadGenRef.current
    setLoadGen(gen)
    setMissing(false)
    setTranslateReq(null)
    setExportOpen(false)
    setExportBusy(false)
    setExportColor('')
    setExportType('')
    setOutlineMissing(false)
    restoreRef.current = null
    scrollTopRef.current = null
    mdRatioRef.current = null
    lastSave.current = 0
    useReader.getState().reset()
    clearIrregularCache()
    clearPageBitmaps()
    clearRenderQueue()
    useRefLink.getState().close()

    let cancelled = false
    let stashable = false
    let task: PdfTask | null = null
    let liveDoc: PDFDocumentProxy | null = null
    const abort = new AbortController()
    const isCurrent = () => !cancelled && loadGenRef.current === gen && !abort.signal.aborted
    const isAbort = (error: unknown) => /aborted|destroyed/i.test(String((error as Error)?.message ?? error ?? ''))
    const isWorkerRace = (error: unknown) => {
      const text = `${String((error as Error)?.message ?? error ?? '')} ${String((error as Error)?.stack ?? '')} ${String((error as { detail?: unknown })?.detail ?? '')}`
      return /sendWithPromise|messageHandler|Worker was destroyed/i.test(text)
    }

    const rebuildRemainingSizes = async (doc: PDFDocumentProxy, start: number) => {
      const batchSize = 16
      for (let offset = start; offset < doc.numPages; offset += batchSize) {
        if (!isCurrent()) return
        const end = Math.min(offset + batchSize, doc.numPages)
        const batch = await Promise.all(
          Array.from({ length: end - offset }, (_, i) => doc.getPage(offset + i + 1)),
        )
        if (!isCurrent()) return
        const sizes = batch.map((page) => {
          const viewport = page.getViewport({ scale: 1 })
          return { w: viewport.width, h: viewport.height }
        })
        useReader.getState().appendPageSizes(offset, sizes)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    const restoreProgress = async (pageCount: number, open: boolean) => {
      const progress = await api.readingProgress(pid).catch(() => null)
      if (!isCurrent()) return
      const page = Math.max(1, Math.min(progress?.page_no ?? 1, pageCount))
      const ratio = Math.max(0, Math.min(1, progress?.scroll_y ?? 0))
      await saveProgress(pid, page, ratio, open).catch(() => {})
      if (!isCurrent()) return
      restoreRef.current = { page, ratio }
      setRestoreTick((tick) => tick + 1)
    }

    const loadOnce = async () => {
      const nextPaper = await loadPaperCached(pid)
      if (!isCurrent()) return

      if (nextPaper.file_type === 'markdown') {
        useReader.getState().setDoc(
          nextPaper,
          null as unknown as PDFDocumentProxy,
          [{ w: 860, h: 1200 }],
          1,
        )
        useReaderTabs.getState().rename(pid, { title: nextPaper.title, fileType: 'markdown' })
        const progress = await api.readingProgress(pid).catch(() => null)
        if (!isCurrent()) return
        const ratio = Math.max(0, Math.min(1, progress?.scroll_y ?? 0))
        restoreRef.current = { page: 1, ratio }
        setRestoreTick((tick) => tick + 1)
        if (takeMdFirstOpen(pid)) await saveProgress(pid, 1, ratio, true).catch(() => {})
        return
      }

      const cached = takeDoc(pid)
      if (cached) {
        liveDoc = cached
        const firstCount = Math.min(FIRST_PARSE_PAGES, cached.numPages)
        const firstPages = await Promise.all(
          Array.from({ length: firstCount }, (_, i) => cached.getPage(i + 1)),
        )
        if (!isCurrent()) return
        const parsed = firstPages.map((page) => {
          const viewport = page.getViewport({ scale: 1 })
          return { w: viewport.width, h: viewport.height }
        })
        const first = parsed[0] ?? { w: 612, h: 792 }
        const sizes = Array.from({ length: cached.numPages }, (_, i) => parsed[i] ?? first)
        useReader.getState().setDoc(nextPaper, cached, sizes, cached.numPages)
        stashable = true
        useReaderTabs.getState().rename(pid, { title: nextPaper.title, fileType: 'pdf' })
        const view = getView(pid)
        if (view.scale) useReader.getState().setScale(view.scale)
        setRenderScale(useReader.getState().scale)
        await rebuildRemainingSizes(cached, firstCount)
        if (!isCurrent()) return
        await restoreProgress(cached.numPages, false)
        return
      }

      const token = await api.fileToken(pid)
      if (!isCurrent()) return
      // 一次 token 放进现有 file URL，交给 pdf.js 自己的加载器处理；
      // 组件层不直接发起 fetch/XHR，也不改 HTTP 路径与查询契约。
      task = getDocument({
        url: pdfFileUrl(pid, token.token),
        cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
        cMapPacked: true,
      })
      const doc = await task.promise
      if (!isCurrent()) {
        destroyTask(task)
        return
      }
      liveDoc = doc
      const firstCount = Math.min(FIRST_PARSE_PAGES, doc.numPages)
      const firstPages = await Promise.all(
        Array.from({ length: firstCount }, (_, i) => doc.getPage(i + 1)),
      )
      if (!isCurrent()) return
      const parsed = firstPages.map((page) => {
        const viewport = page.getViewport({ scale: 1 })
        return { w: viewport.width, h: viewport.height }
      })
      const first = parsed[0] ?? { w: 612, h: 792 }
      const sizes = Array.from({ length: doc.numPages }, (_, i) => parsed[i] ?? first)
      useReader.getState().setDoc(nextPaper, doc, sizes, doc.numPages)
      stashable = true
      useReaderTabs.getState().rename(pid, { title: nextPaper.title, fileType: 'pdf' })
      const view = getView(pid)
      if (view.scale) useReader.getState().setScale(view.scale)
      setRenderScale(useReader.getState().scale)
      await rebuildRemainingSizes(doc, firstCount)
      if (!isCurrent()) return
      await restoreProgress(doc.numPages, true)
    }

    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await loadOnce()
          break
        } catch (error) {
          if (!isCurrent()) return
          const race = isWorkerRace(error) || isAbort(error)
          console.error(`[NextReader] load failed (attempt ${attempt + 1}/2) pid=${pid}`, error)
          if (race && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 200))
            if (!isCurrent()) return
            if (liveDoc) destroyPdf(liveDoc)
            else destroyTask(task)
            task = null
            liveDoc = null
            stashable = false
            useReader.getState().reset()
            continue
          }
          const absent = error instanceof ApiError && error.status === 404
          setMissing(absent)
          useReader.getState().setLoadError(
            absent ? '这篇论文不存在或已被删除。' : error instanceof Error ? error.message : '文档加载失败',
          )
          break
        }
      }
    })()

    return () => {
      cancelled = true
      abort.abort()
      if (liveDoc) {
        if (stashable && hasReaderTab(pid)) stashDoc(pid, liveDoc)
        else {
          dropDoc(pid)
          destroyPdf(liveDoc)
        }
      } else {
        destroyTask(task)
      }
      const state = useReader.getState()
      useReaderTabs.getState().touchView(pid, { scale: state.scale })
      void flushReaderProgress()
      useReader.getState().reset()
    }
  }, [pid, validPid, tabInvalid, reloadKey, flushReaderProgress])

  const scrollToPosition = useCallback((pageNo: number, ratio: number) => {
    const state = useReader.getState()
    const page = Math.max(1, Math.min(pageNo, state.numPages || pageNo))
    if (state.mode === 'single') {
      state.setCurrentPage(page)
      return
    }
    const el = scrollRef.current
    if (!el || !state.pageSizes.length) return
    const top = pageTopOf(page - 1, state.pageSizes, state.scale)
    const height = (state.pageSizes[page - 1]?.h ?? 0) * state.scale
    el.scrollTop = top + ratio * height
  }, [])

  const enterSearchPage = useCallback(
    (index: number) => scrollToPosition(index + 1, 0),
    [scrollToPosition],
  )

  // 单页 → 连续：新滚动容器挂载前 currentPage 可能已翻到较后页，布局期先落位避免闪回第 1 页。
  const prevModeRef = useRef(mode)
  useLayoutEffect(() => {
    if (prevModeRef.current === mode) return
    prevModeRef.current = mode
    if (mode !== 'continuous' || loading) return
    scrollToPosition(useReader.getState().currentPage, 0)
  }, [mode, loading, scrollToPosition])

  useEffect(() => {
    if (loading || !numPages || !restoreRef.current) return
    const { page, ratio } = restoreRef.current
    restoreRef.current = null
    const raf = requestAnimationFrame(() => scrollToPosition(page, ratio))
    return () => cancelAnimationFrame(raf)
  }, [loading, numPages, restoreTick, scrollToPosition])

  useEffect(() => {
    if (!validPid) return
    const seq = ++fetchAnnoSeq.current
    const controller = new AbortController()
    api.annotations(pid, { signal: controller.signal })
      .then((list) => {
        if (seq !== fetchAnnoSeq.current || controller.signal.aborted) return
        useReader.getState().setAnnotations(list.map(parseAnnotation))
      })
      .catch((error: unknown) => {
        if ((error as Error)?.name === 'AbortError') return
      })
    return () => controller.abort()
  }, [pid, validPid, annotationsVersion])

  useEffect(() => {
    setOutlineMissing(false)
    if (!pdf) return
    let cancelled = false
    try {
      pdf.getOutline()
        .then((outline) => { if (!cancelled) setOutlineMissing(!outline || outline.length === 0) })
        .catch(() => { if (!cancelled) setOutlineMissing(true) })
    } catch {
      setOutlineMissing(true)
    }
    return () => { cancelled = true }
  }, [pdf])

  useEffect(() => {
    if (!wordsLoaded) loadWords().catch(() => {})
  }, [wordsLoaded, loadWords])

  // OCR：done 拉 blocks；pending/running 每秒轮询；失败与取消都停止空转。
  useEffect(() => {
    if (!validPid) return
    let stopped = false
    let timer = 0
    const loadBlocks = async () => {
      try {
        const pages = await fetchOcrBlocks(pid)
        const blocks = new Map<number, (typeof pages)[number]['blocks']>()
        for (const page of pages) blocks.set(page.page - 1, page.blocks)
        if (!stopped) useReader.getState().setOcr('done', blocks)
      } catch {
        if (!stopped) {
          useReader.getState().setOcr('failed')
          toast('OCR 结果加载失败', 'error')
        }
      }
    }
    const tick = async () => {
      try {
        const status = await api.ocrStatus(pid)
        if (stopped) return
        const state = useReader.getState()
        const decision = mapOcrPollStatus(status.status)
        if (decision.ui === 'done') {
          await loadBlocks()
          return
        }
        if (decision.ui === 'failed') {
          state.setOcr('failed')
          state.setOcrProgress(null, status.error)
          return
        }
        if (state.ocrStatus !== decision.ui) state.setOcr(decision.ui)
        if (!decision.keepPolling) return
        const previous = state.ocrProgress
        if (!previous || previous.done !== status.pages_done || previous.total !== status.pages_total) {
          state.setOcrProgress({ done: status.pages_done, total: status.pages_total })
        }
        timer = window.setTimeout(tick, 1000)
      } catch {
        if (!stopped) timer = window.setTimeout(tick, 3000)
      }
    }
    const initial = useReader.getState().paper
    const localStatus = useReader.getState().ocrStatus
    if (initial?.id === pid) {
      if (initial.ocr_status === 'done') void loadBlocks()
      else if (initial.ocr_status === 'pending' || initial.ocr_status === 'running') {
        useReader.getState().setOcr(initial.ocr_status)
        void tick()
      } else if (initial.ocr_status === 'failed') {
        // 上次服务端 OCR 已失败：直接呈现失败态，提供“重试（跳过已完成页）”。
        useReader.getState().setOcr('failed')
      } else if (localStatus === 'pending' || localStatus === 'running') {
        // 本页刚发起 OCR/重试：paper 元数据仍是旧值（failed/none），
        // startOcr 已把本地状态置 pending，这里直接开始轮询，避免按钮卡在“解析中”。
        void tick()
      }
    }
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [pid, validPid, paper?.ocr_status, ocrBump])

  const goto = useCallback((pageNo: number, annotationId?: number) => {
    scrollToPosition(pageNo, 0)
    if (annotationId != null) useReader.getState().setLocateAnnotation(annotationId)
  }, [scrollToPosition])

  useEffect(() => {
    useReaderBus.setState({ paperId: validPid ? pid : null })
    useReaderBus.getState().registerGoto(goto)
    return () => {
      useReaderBus.getState().registerGoto(null)
      useReaderBus.setState({ paperId: null })
    }
  }, [pid, validPid, goto])

  useEffect(() => {
    useRefLink.getState().registerNav(scrollToPosition)
    return () => useRefLink.getState().registerNav(null)
  }, [scrollToPosition])

  // 阅读会话不足 3 秒不上报；失焦期间暂停累计。
  useEffect(() => {
    if (!validPid) return
    const session = {
      start: new Date().toISOString(),
      seconds: 0,
      lastTick: Date.now(),
      focused: document.hasFocus(),
    }
    const flush = () => {
      if (session.focused) {
        session.seconds += (Date.now() - session.lastTick) / 1000
        session.lastTick = Date.now()
      }
    }
    const onFocus = () => {
      session.lastTick = Date.now()
      session.focused = true
    }
    const onBlur = () => {
      flush()
      session.focused = false
    }
    const interval = window.setInterval(flush, 5000)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      flush()
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      if (Math.round(session.seconds) >= 3) {
        api.readingSession(pid, session.start, new Date().toISOString()).catch(() => {})
      }
    }
  }, [pid, validPid])

  const zoomBy = useCallback((factor: number) => {
    const state = useReader.getState()
    state.setScale(state.scale * factor)
  }, [])

  const fitWidth = useCallback(() => {
    const el = scrollRef.current
    const state = useReader.getState()
    if (!el || !state.pageSizes.length) return
    const width = state.pageSizes[state.currentPage - 1]?.w ?? 612
    state.setScale(Math.max(0.3, (el.clientWidth - 80) / width), true)
  }, [])

  const onDividerDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    let raf = 0
    let pendingX: number | null = null
    const apply = () => {
      raf = 0
      if (pendingX == null || !mainAreaRef.current) return
      const bounds = mainAreaRef.current.getBoundingClientRect()
      setCompareRatio((pendingX - bounds.left) / bounds.width)
      pendingX = null
    }
    const move = (moveEvent: MouseEvent) => {
      pendingX = moveEvent.clientX
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const up = () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [setCompareRatio])

  const zoomAccum = useRef(1)
  const zoomRaf = useRef(0)
  const pinchRef = useRef<{ dist: number } | null>(null)
  const pinchAccum = useRef(1)
  const pinchRaf = useRef(0)
  // 提为稳定标量：缩放/捏合监听的依赖只关心「是否 Markdown」
  const markdownDocDependency = isMdForDeps(paper, pid)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomAccum.current *= Math.pow(
        event.deltaY < 0 ? ZOOM_STEP_RATIO : 1 / ZOOM_STEP_RATIO,
        Math.min(120, Math.abs(event.deltaY)),
      )
      if (zoomRaf.current) return
      zoomRaf.current = requestAnimationFrame(() => {
        zoomRaf.current = 0
        const factor = zoomAccum.current
        zoomAccum.current = 1
        const state = useReader.getState()
        state.setScale(state.scale * factor)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (zoomRaf.current) cancelAnimationFrame(zoomRaf.current)
      zoomRaf.current = 0
      zoomAccum.current = 1
    }
  }, [loading, markdownDocDependency, tabInvalid])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    )
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        pinchRef.current = { dist: distance(event.touches) }
        pinchAccum.current = 1
      }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) return
      event.preventDefault()
      const next = distance(event.touches)
      if (pinchRef.current.dist > 0) pinchAccum.current *= next / pinchRef.current.dist
      pinchRef.current.dist = next
      if (pinchRaf.current) return
      pinchRaf.current = requestAnimationFrame(() => {
        pinchRaf.current = 0
        const factor = pinchAccum.current
        pinchAccum.current = 1
        const state = useReader.getState()
        state.setScale(state.scale * factor)
      })
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinchRef.current = null
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      if (pinchRaf.current) cancelAnimationFrame(pinchRaf.current)
      pinchRaf.current = 0
      pinchRef.current = null
    }
  }, [loading, markdownDocDependency, tabInvalid])

  const gotoPage = useCallback((pageNo: number, save = true) => {
    const state = useReader.getState()
    const page = Math.max(1, Math.min(pageNo, state.numPages || 1))
    state.setCurrentPage(page)
    state.setSelection(null)
    scrollToPosition(page, 0)
    if (save) saveProgress(pid, page, 0).catch(() => {})
  }, [pid, scrollToPosition])

  const onMouseUp = useCallback(() => {
    const state = useReader.getState()
    if (state.linking || state.ink.active) return
    window.setTimeout(async () => {
      const guard = useReader.getState()
      if (guard.suppressSelection) {
        guard.setSuppressSelection(false)
        return
      }
      const nativeSelection = window.getSelection()
      const current = useReader.getState()
      if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.toString().trim()) {
        if (current.selection) current.setSelection(null)
        return
      }
      const text = nativeSelection.toString().replace(/\s+/g, ' ').trim()
      const node = nativeSelection.anchorNode
      const element = node instanceof Element ? node : node?.parentElement
      const pageEl = element?.closest('.page-wrapper') as HTMLElement | null
      if (!pageEl) return
      const pageIndex = Number(pageEl.dataset.pageIndex)
      const size = current.pageSizes[pageIndex]
      if (!size) return
      const geom = { baseW: size.w, baseH: size.h, scale: current.scale }
      const range = nativeSelection.getRangeAt(0)
      const visibleRects = clientRectsInPage(range.getClientRects(), pageEl.getBoundingClientRect())
      const mergedRects = mergeClientRects(visibleRects, 1, geom.scale)
      const rects = clientRectsToPdf(mergedRects, pageEl, geom)
      const first = mergedRects[0]
      if (!first || !rects.length) return
      const blocks = current.ocrBlocks.get(pageIndex)
      const fullText = blocks
        ? ocrPageText(blocks)
        : current.pdf
          ? await ensurePageText(current.pdf, pageIndex)
          : ''
      const context = extractSentenceContext(fullText, text)
      const below = first.top > 64
      useReader.getState().setSelection({
        text,
        pageIndex,
        rects,
        sentence: context.sentence,
        prev: context.prev,
        next: context.next,
        paperId: pid,
        toolbarX: first.left + first.width / 2,
        toolbarY: below ? first.bottom + 10 : Math.max(52, first.top - 46),
        toolbarBelow: below,
      })
    }, 0)
  }, [pid])

  const onTranslate = useCallback((translateMode: 'word' | 'dict' | 'sentence') => {
    const selected = useReader.getState().selection
    if (!selected) return
    const words = selected.text.trim().split(/\s+/).filter(Boolean)
    const sentenceMode = translateMode === 'sentence'
      || (translateMode === 'word' && isSentenceSelection(selected.text))
    const source = (selected.sentence || selected.text).trim()
    setTranslateReq({
      id: reqSeq.current++,
      paperId: selected.paperId,
      word: translateMode === 'dict'
        ? words[0] ?? ''
        : sentenceMode
          ? source.slice(0, 40)
          : selected.text.trim(),
      sentence: source,
      prev: selected.prev,
      next: selected.next,
      mode: translateMode === 'dict' ? 'dict' : sentenceMode ? 'sentence' : 'word',
      x: selected.toolbarX,
      y: selected.toolbarY + 42,
      below: true,
    })
  }, [])

  // 快捷键与 Esc 分层关闭；绘制模式由 InkToolbar 先处理自己的图形面板。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inInput = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      )
      const state = useReader.getState()
      if (event.key === 'Escape') {
        if (state.ink.active) return
        if (state.linking) {
          state.setLinking(null)
          return
        }
        if (useRefLink.getState().entryNo != null) {
          useRefLink.getState().goOrigin()
          return
        }
        if (translateReq) {
          setTranslateReq(null)
          return
        }
        if (exportOpen) {
          setExportOpen(false)
          return
        }
        if (state.searchOpen) {
          state.toggleSearch(false)
          state.setSearchTerm('')
          state.setSearchFocusPage(null)
          return
        }
        if (state.outlineOpen) {
          state.toggleOutline(false)
          return
        }
        if (state.selection) {
          state.setSelection(null)
          window.getSelection()?.removeAllRanges()
        }
        return
      }
      if (event.isComposing) return
      if (event.ctrlKey || event.metaKey) {
        if (inInput) return
        if (event.key === '=' || event.key === '+') {
          event.preventDefault()
          zoomBy(1.2)
        } else if (event.key === '-') {
          event.preventDefault()
          zoomBy(1 / 1.2)
        } else if (event.key === '0') {
          event.preventDefault()
          fitWidth()
        } else if (event.key.toLowerCase() === 'f') {
          event.preventDefault()
          state.toggleSearch(true)
        }
        return
      }
      if (inInput || event.altKey) return
      const hasSelection = !!state.selection
      switch (event.key.toLowerCase()) {
        case 't':
          if (hasSelection) onTranslate('word')
          break
        case 'b':
          if (hasSelection) actionsRef.current?.startLinking()
          break
        case 'w':
          if (hasSelection) actionsRef.current?.addWord()
          break
        case 'h':
          if (hasSelection) actionsRef.current?.highlight()
          break
        case 'arrowleft':
        case 'pageup':
          if (state.mode === 'single') {
            event.preventDefault()
            gotoPage(state.currentPage - 1)
          }
          break
        case 'arrowright':
        case 'pagedown':
          if (state.mode === 'single') {
            event.preventDefault()
            gotoPage(state.currentPage + 1)
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBy, fitWidth, onTranslate, gotoPage, translateReq, exportOpen])

  const onScroll = useCallback(() => {
    if (rafScroll.current) return
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0
      const el = scrollRef.current
      const state = useReader.getState()
      if (!el || state.mode !== 'continuous' || !state.pageSizes.length) return
      const viewTop = el.scrollTop
      scrollTopRef.current = viewTop
      const viewBottom = viewTop + el.clientHeight
      const mid = viewTop + el.clientHeight / 2
      let acc = 0
      let firstVisible = -1
      let lastVisible = -1
      let current = 0
      let best = Infinity
      for (let i = 0; i < state.numPages; i++) {
        const height = state.pageSizes[i].h * state.scale
        const start = acc
        const end = acc + height
        if (end >= viewTop && start <= viewBottom) {
          if (firstVisible < 0) firstVisible = i
          lastVisible = i
        }
        const distance = Math.abs((start + end) / 2 - mid)
        if (distance < best) {
          best = distance
          current = i
        }
        acc = end + PAGE_GAP
      }
      if (firstVisible < 0) return
      const range: [number, number] = [
        Math.max(0, firstVisible - 2),
        Math.min(state.numPages - 1, lastVisible + 2),
      ]
      if (range[0] !== state.renderRange[0] || range[1] !== state.renderRange[1]) {
        state.setRenderRange(range)
      }
      if (current + 1 !== state.currentPage) state.setCurrentPage(current + 1)
      const now = Date.now()
      if (now - lastSave.current > PROGRESS_SAVE_THROTTLE_MS) {
        lastSave.current = now
        const top = pageTopOf(current, state.pageSizes, state.scale)
        const height = state.pageSizes[current].h * state.scale
        const ratio = Math.max(0, Math.min(1, (viewTop - top) / Math.max(1, height)))
        saveProgress(pid, current + 1, ratio).catch(() => {})
      }
    })
  }, [pid])

  useEffect(() => () => {
    if (rafScroll.current) cancelAnimationFrame(rafScroll.current)
  }, [])

  const startOcr = async (retry: boolean) => {
    try {
      if (retry) await api.retryOcr(pid)
      else await api.startOcr(pid)
      useReader.getState().setOcr('pending')
      setOcrBump((bump) => bump + 1)
    } catch {
      toast('OCR 任务提交失败', 'error')
    }
  }

  const cancelOcr = async () => {
    try {
      await api.cancelOcr(pid)
      useReader.getState().setOcr('none')
      useReader.getState().setOcrProgress(null, null)
      toast('已取消 OCR', 'ok')
    } catch {
      toast('取消失败', 'error')
    }
  }

  const exportAnnotations = async (format: 'pdf' | 'md') => {
    if (exportBusy) return
    setExportBusy(true)
    try {
      const filter = { color: exportColor || undefined, type: exportType || undefined }
      const blob = format === 'pdf'
        ? await api.exportAnnotationsPdf(pid, filter)
        : await api.exportAnnotationsMd(pid, filter)
      const suffix = format === 'pdf' ? '_批注版.pdf' : '_批注.md'
      const saved = await saveBlobWithDialog(blob, `${paper?.title?.slice(0, 40) || 'paper'}${suffix}`)
      if (!saved) return
      toast(format === 'pdf' ? '已导出批注写回副本' : '已导出批注 Markdown', 'ok')
      setExportOpen(false)
    } catch {
      toast('导出失败', 'error')
    } finally {
      setExportBusy(false)
    }
  }

  const goLibrary = useCallback(() => {
    const run = () => navigate('/')
    if (!guardMdNav(run, pid)) run()
  }, [navigate, pid])

  const goWords = () => {
    const run = () => {
      useUi.getState().closePanel()
      useUi.getState().openReview('library')
      navigate('/review')
    }
    if (!guardMdNav(run, pid)) run()
  }

  const isStale = paper != null && paper.id !== pid
  const isMd = !isStale && paper?.file_type === 'markdown'
  const canShowDocument = validPid && !tabInvalid && !missing && !loadError && !loading && !isStale
  const pagesIdx = useMemo(() => Array.from({ length: numPages }, (_, i) => i), [numPages])
  const title = isStale ? '正在切换文档…' : paper?.title ?? currentTab?.title ?? 'PaperLens 阅读器'

  return (
    <div className={`pnx-root pnx-reader${linking ? ' pnx-reader-linking' : ''}`}>
      <header className="pnx-reader-header">
        <div className="pnx-reader-masthead">
          <button className="pnx-back-button" onClick={goLibrary} title="返回文库">
            <span className="pnx-back-arrow" aria-hidden>←</span>
            <span>文库</span>
          </button>
          <div className="pnx-document-heading">
            <div className="pnx-document-title-row">
              <span className="pnx-document-type">{isMd ? 'MD' : 'PDF'}</span>
              <h1 title={title}>{title}</h1>
              {!isStale && paper?.is_favorite && (
                <span className="pnx-favorite-mark" title="已收藏"><IconStar size={13} /></span>
              )}
            </div>
            <p>{isMd ? 'Markdown 研究笔记' : paper?.authors || paper?.venue || '专注阅读，保留每一处思考'}</p>
          </div>
          <div className="pnx-document-actions">
            <ToolButton title="批注与摘录面板" onClick={() => openPanel('annotations')} disabled={!paper || isStale}>
              <IconBook size={15} /><span className="pnx-tool-label">批注</span>
              {annotationsCount > 0 && <span className="pnx-tool-badge">{annotationsCount}</span>}
            </ToolButton>
            <ToolButton title="生词库" onClick={goWords} disabled={!validPid || tabInvalid}>
              <span className="pnx-letter-icon" aria-hidden>W</span><span className="pnx-tool-label">生词库</span>
            </ToolButton>
            <ToolButton title="本文术语表" onClick={() => openPanel('glossary')} disabled={!paper || isStale}>
              <IconMenu size={15} /><span className="pnx-tool-label">术语表</span>
            </ToolButton>
          </div>
        </div>

        <div className="pnx-reader-tools">
          {!isMd ? (
            <>
              <div className="pnx-tool-group pnx-page-tools">
                <PageIndicator numPages={numPages} onCommit={gotoPage} disabled={!canShowDocument} />
              </div>
              <span className="pnx-tool-separator" aria-hidden />
              <div className="pnx-tool-group pnx-zoom-tools">
                <ToolButton title="缩小 (Ctrl+-)" ariaLabel="缩小" onClick={() => zoomBy(1 / 1.2)} disabled={!pdf}><IconMinus size={14} /></ToolButton>
                <span className="pnx-zoom-value">{Math.round(scale * 100)}%</span>
                <ToolButton title="放大 (Ctrl+=)" ariaLabel="放大" onClick={() => zoomBy(1.2)} disabled={!pdf}><IconPlus size={14} /></ToolButton>
                <ToolButton title="适应宽度 (Ctrl+0)" ariaLabel="适应宽度" onClick={fitWidth} disabled={!pdf}><IconFit size={14} /></ToolButton>
              </div>
              <span className="pnx-tool-separator" aria-hidden />
              <div className="pnx-mode-switch" aria-label="阅读模式">
                <button className={mode === 'single' ? 'pnx-is-active' : ''} aria-pressed={mode === 'single'} disabled={!pdf} onClick={() => useReader.getState().setMode('single')}>单页</button>
                <button className={mode === 'continuous' ? 'pnx-is-active' : ''} aria-pressed={mode === 'continuous'} disabled={!pdf} onClick={() => useReader.getState().setMode('continuous')}>连续</button>
              </div>
              <div className="pnx-tool-group pnx-view-tools">
                <ToolButton title="目录大纲" active={outlineOpen} onClick={() => useReader.getState().toggleOutline()} disabled={!pdf}><IconMenu size={15} /><span className="pnx-tool-label">大纲</span></ToolButton>
                <ToolButton title="页内搜索 (Ctrl+F)" active={searchOpen} onClick={() => useReader.getState().toggleSearch()} disabled={!pdf}><IconSearch size={15} /><span className="pnx-tool-label">搜索</span></ToolButton>
                <ToolButton
                  title={inkActive ? '退出绘制 (Esc)' : '画笔与图形'}
                  active={inkActive}
                  disabled={!pdf}
                  onClick={() => {
                    const next = !useReader.getState().ink.active
                    useReader.getState().setInk({ active: next })
                    if (next) useReader.getState().setSelection(null)
                  }}
                ><IconPencil size={15} /><span className="pnx-tool-label">画笔</span></ToolButton>
              </div>
              <div className="pnx-tool-group pnx-export-tools">
                {compareOpen ? (
                  <ToolButton title="退出对照模式" active onClick={() => setComparePaper(null)} disabled={!canShowDocument}><span className="pnx-split-icon" aria-hidden>Ⅱ</span><span className="pnx-tool-label">退出对照</span></ToolButton>
                ) : (
                  <Dropdown
                    key={`compare-${pid}`}
                    label={<><span className="pnx-split-icon" aria-hidden>Ⅱ</span><span className="pnx-tool-label">对照</span></>}
                    title="从其他已打开的 PDF 页签选择对照论文"
                    className="pnx-dropdown pnx-compare-dropdown"
                    triggerClass="pnx-tool-button"
                    panelClass="pnx-dropdown-panel pnx-compare-options"
                    items={otherReaderTabs.map((tab) => ({ key: String(tab.paperId), label: tab.title || '未命名论文' }))}
                    emptyText="暂无其他 PDF 页签，请先在文库打开"
                    onSelect={(key) => {
                      api.paper(Number(key)).then(setComparePaper).catch(() => toast('打开对照失败', 'error'))
                    }}
                  />
                )}
                <ToolButton title="导出筛选后的批注" onClick={() => setExportOpen(true)} disabled={!canShowDocument}><span className="pnx-export-icon" aria-hidden>⇩</span><span className="pnx-tool-label">导出</span></ToolButton>
              </div>
            </>
          ) : (
            <div className="pnx-md-tools">
              <span className="pnx-md-label">Markdown 工作区</span>
              <span className="pnx-md-meta">{paper?.page_count ?? 0} 行</span>
              <span className="pnx-md-hint">预览 / 编辑 / 分栏与保存位于文档工具栏 · Ctrl+E 切换编辑</span>
            </div>
          )}
        </div>
      </header>

      <div ref={mainAreaRef} className="pnx-reader-main">
        {canShowDocument && !isMd && inkActive && <InkToolbar />}
        <section className="pnx-primary-pane" aria-label="主阅读区">
          {!validPid ? (
            <ReaderState title="阅读地址无效" detail="无法识别这篇论文的编号，请返回文库重新打开。" onBack={goLibrary} />
          ) : tabInvalid ? (
            <ReaderState title="页签已失效" detail="该论文页签已关闭或不再属于当前会话，请返回文库重新打开。" onBack={goLibrary} />
          ) : missing ? (
            <ReaderState title="论文不存在" detail="这篇论文不存在或已被删除。" onBack={goLibrary} />
          ) : loadError && !isStale ? (
            <ReaderState
              title="文档加载失败"
              detail={loadError}
              onBack={goLibrary}
              onRetry={() => {
                useReader.getState().setLoadError(null)
                setReloadKey((key) => key + 1)
              }}
            />
          ) : loading || isStale ? (
            <div className="pnx-reader-loading" role="status">
              <span className="pnx-spinner" aria-hidden />
              <strong>正在整理阅读空间</strong>
              <span>加载文档与恢复上次位置…</span>
            </div>
          ) : isMd ? (
            <div
              ref={mdHostRef}
              className="pnx-markdown-host"
              onScrollCapture={(event) => {
                const target = event.target as HTMLElement
                if (!target.querySelector(':scope > .markdown-body')) return
                mdRatioRef.current = Math.max(0, Math.min(1, target.scrollTop / Math.max(1, target.scrollHeight - target.clientHeight)))
              }}
            >
              <MarkdownReader paperId={pid} />
            </div>
          ) : (
            <div ref={scrollRef} className="pnx-pdf-scroll" onScroll={onScroll} onMouseUp={onMouseUp}>
              <div className="pnx-page-stack">
                {mode === 'continuous'
                  ? pagesIdx.map((index) => {
                    const size = pageSizes[index]
                    if (!size) return null
                    if (index < renderRange[0] || index > renderRange[1]) {
                      return (
                        <div
                          key={index}
                          className="pnx-page-placeholder"
                          style={{ width: size.w * scale, height: size.h * scale }}
                        >
                          <span>{index + 1}</span>
                        </div>
                      )
                    }
                    return (
                      <PageView
                        key={index}
                        pdf={pdf!}
                        pageIndex={index}
                        active
                        renderScale={renderScale}
                        generation={loadGen}
                        onGotoPage={scrollToPosition}
                        flashRects={refFlash?.pageIndex === index ? refFlash.rects : null}
                      />
                    )
                  })
                  : pdf && pageSizes[currentPage - 1] && (
                    <PageView
                      pdf={pdf}
                      pageIndex={currentPage - 1}
                      active
                      renderScale={renderScale}
                      generation={loadGen}
                      onGotoPage={scrollToPosition}
                      flashRects={refFlash?.pageIndex === currentPage - 1 ? refFlash.rects : null}
                    />
                  )}
              </div>
            </div>
          )}

          {canShowDocument && !isMd && outlineOpen && <OutlineDrawer onGoto={(page) => gotoPage(page, false)} />}
          {canShowDocument && !isMd && searchOpen && (
            <SearchBar onEnterPage={enterSearchPage} />
          )}
          {canShowDocument && !isMd && <RefBar />}
          {canShowDocument && !isMd && paper && (
            <OcrBanner
              paper={paper}
              status={ocrStatus}
              progress={ocrProgress}
              error={ocrError}
              onStart={() => startOcr(false)}
              onRetry={() => startOcr(true)}
              onCancel={cancelOcr}
            />
          )}
          {canShowDocument && !isMd && linking && !linking.cardDraft && (
            <div className="pnx-linking-hint">从锚点拖到页边落卡 · Esc 取消</div>
          )}
        </section>

        {canShowDocument && !isMd && !compareOpen && outlineMissing && pdf && numPages > 0 && (
          <div className="pnx-rail-host" aria-label="页面缩略图导航">
            <ThumbnailRail pdf={pdf} numPages={numPages} currentPage={currentPage} generation={loadGen} onGoto={(page) => gotoPage(page, false)} />
          </div>
        )}
        {canShowDocument && compareOpen && (
          <>
            <div
              className="pnx-compare-divider"
              role="separator"
              aria-label="调整对照窗格宽度"
              aria-orientation="vertical"
              title="拖拽调整宽度 · 双击复位"
              onMouseDown={onDividerDown}
              onDoubleClick={() => setCompareRatio(0.52)}
            />
            <ComparePane widthPercent={(1 - compareRatio) * 100} />
          </>
        )}
      </div>

      <Modal open={exportOpen} title="导出批注" width={420} onClose={() => !exportBusy && setExportOpen(false)}>
        <div className="pnx-export-form">
          <p>仅导出符合筛选条件的批注；留空表示全部。</p>
          <label className="pnx-export-field">
            <span>颜色</span>
            <select className="pnx-select" value={exportColor} onChange={(event) => setExportColor(event.target.value)}>
              <option value="">全部颜色</option>
              <option value="yellow">黄色</option>
              <option value="green">绿色</option>
              <option value="blue">蓝色</option>
              <option value="pink">粉色</option>
              <option value="purple">紫色</option>
            </select>
          </label>
          <label className="pnx-export-field">
            <span>类型</span>
            <select className="pnx-select" value={exportType} onChange={(event) => setExportType(event.target.value)}>
              <option value="">全部类型</option>
              <option value="word_note">连线笔记</option>
              <option value="sentence">句子高亮</option>
            </select>
          </label>
          <div className="pnx-export-actions">
            <button className="pnx-secondary-button" disabled={exportBusy} onClick={() => exportAnnotations('md')}>Markdown 列表</button>
            <button className="pnx-primary-button" disabled={exportBusy} onClick={() => exportAnnotations('pdf')}>{exportBusy ? '导出中…' : '写回 PDF 副本'}</button>
          </div>
        </div>
      </Modal>

      {canShowDocument && !isMd && toolbarVisible && selection && (
        <SelectionToolbar onTranslate={onTranslate} onToast={(message) => toast(message)} actionsRef={actionsRef} />
      )}
      {canShowDocument && !isMd && translateReq && (
        <TranslateCard paperId={translateReq.paperId} request={translateReq} onClose={() => setTranslateReq(null)} onToast={(message) => toast(message)} />
      )}
    </div>
  )
}

function isMdForDeps(paper: { id: number; file_type: string } | null, pid: number) {
  return paper?.id === pid && paper.file_type === 'markdown'
}

function ToolButton({
  children,
  title,
  ariaLabel,
  active = false,
  disabled = false,
  onClick,
}: {
  children: ReactNode
  title: string
  ariaLabel?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`pnx-tool-button${active ? ' pnx-is-active' : ''}`}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function ReaderState({
  title,
  detail,
  onRetry,
  onBack,
}: {
  title: string
  detail: string
  onRetry?: () => void
  onBack: () => void
}) {
  return (
    <div className="pnx-reader-state" role="alert">
      <span className="pnx-state-mark" aria-hidden>PL</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div className="pnx-state-actions">
        {onRetry && <button className="pnx-primary-button" onClick={onRetry}>重新加载</button>}
        <button className="pnx-secondary-button" onClick={onBack}>返回文库</button>
      </div>
    </div>
  )
}

function PageIndicator({
  numPages,
  onCommit,
  disabled,
}: {
  numPages: number
  onCommit: (page: number) => void
  disabled: boolean
}) {
  const currentPage = useReader((state) => state.currentPage)
  const [value, setValue] = useState(String(currentPage))
  useEffect(() => setValue(String(currentPage)), [currentPage])
  const commit = () => {
    const page = Number.parseInt(value, 10)
    if (Number.isFinite(page)) onCommit(page)
    else setValue(String(currentPage))
  }
  return (
    <label className="pnx-page-indicator">
      <span>第</span>
      <input
        value={value}
        disabled={disabled}
        aria-label="页码"
        inputMode="numeric"
        onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
      <span>/ {numPages || '…'} 页</span>
    </label>
  )
}

function OutlineDrawer({ onGoto }: { onGoto: (pageNo: number) => void }) {
  const pdf = useReader((state) => state.pdf)
  const toggleOutline = useReader((state) => state.toggleOutline)
  const [tree, setTree] = useState<OutlineNode[] | null>(null)

  useEffect(() => {
    if (!pdf) {
      setTree([])
      return
    }
    let stopped = false
    try {
      pdf.getOutline()
        .then((outline) => { if (!stopped) setTree((outline as OutlineNode[] | null) ?? []) })
        .catch(() => { if (!stopped) setTree([]) })
    } catch {
      if (!stopped) setTree([])
    }
    return () => { stopped = true }
  }, [pdf])

  const go = async (dest: unknown) => {
    if (!pdf) return
    try {
      let target = dest
      if (typeof target === 'string') target = await pdf.getDestination(target)
      if (!Array.isArray(target) || !target.length) return
      const index = await pdf.getPageIndex(target[0] as { num: number; gen: number })
      onGoto(index + 1)
    } catch {
      // 无效目标保持当前页。
    }
  }

  const renderNodes = (nodes: OutlineNode[], depth: number): ReactNode => nodes.map((node, index) => (
    <div key={`${depth}-${index}`} className="pnx-outline-node">
      <button
        style={{ paddingLeft: 12 + depth * 16 }}
        title={node.title}
        onClick={() => { void go(node.dest) }}
      >
        {node.title || '（未命名）'}
      </button>
      {node.items?.length ? renderNodes(node.items, depth + 1) : null}
    </div>
  ))

  return (
    <aside className="pnx-outline-drawer" aria-label="目录大纲">
      <header className="pnx-floating-header">
        <div><span>目录大纲</span><small>{tree?.length ? `${tree.length} 个主章节` : 'PDF OUTLINE'}</small></div>
        <button title="关闭大纲" aria-label="关闭大纲" onClick={() => toggleOutline(false)}><IconX size={13} /></button>
      </header>
      <div className="pnx-outline-content">
        {tree === null ? (
          <p className="pnx-empty-note">正在读取目录…</p>
        ) : tree.length === 0 ? (
          <p className="pnx-empty-note">此 PDF 没有目录大纲，可使用右侧缩略图导航。</p>
        ) : renderNodes(tree, 0)}
      </div>
    </aside>
  )
}

function SearchBar({ onEnterPage }: { onEnterPage: (pageIndex: number) => void }) {
  const pdf = useReader((state) => state.pdf)
  const numPages = useReader((state) => state.numPages)
  const searchTerm = useReader((state) => state.searchTerm)
  const ocrStatus = useReader((state) => state.ocrStatus)
  const setSearchTerm = useReader((state) => state.setSearchTerm)
  const setSearchFocusPage = useReader((state) => state.setSearchFocusPage)
  const toggleSearch = useReader((state) => state.toggleSearch)
  const [query, setQuery] = useState(searchTerm)
  const [matches, setMatches] = useState<{ page: number; count: number }[]>([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const normalized = query.trim().toLowerCase()
    const my = ++seq.current
    setSearchTerm(normalized)
    if (!normalized || !pdf) {
      setMatches([])
      setSearchFocusPage(null)
      setBusy(false)
      return
    }
    setBusy(true)
    const timer = window.setTimeout(async () => {
      const found: { page: number; count: number }[] = []
      for (let index = 0; index < numPages; index++) {
        if (seq.current !== my) return
        try {
          const state = useReader.getState()
          const blocks = state.ocrBlocks.get(index)
          const text = blocks ? ocrPageText(blocks) : await ensurePageText(pdf, index)
          const count = countOccurrences(text.toLowerCase(), normalized)
          if (count) found.push({ page: index, count })
        } catch {
          // 单页文本失败不阻断其余页面搜索。
        }
      }
      if (seq.current !== my) return
      setMatches(found)
      setBusy(false)
      setSearchFocusPage(found.length ? found[0].page : null)
      if (found.length) onEnterPage(found[0].page)
    }, 350)
    return () => {
      window.clearTimeout(timer)
      // 单调递增即失效：清理阶段无需回读 ref 现值（相等判断只为避免重复自增）
      seq.current += 1
    }
  }, [query, pdf, numPages, ocrStatus, onEnterPage, setSearchTerm, setSearchFocusPage])

  const total = matches.reduce((sum, match) => sum + match.count, 0)
  const jump = (direction: 1 | -1) => {
    if (!matches.length) return
    const pages = matches.map((match) => match.page)
    const current = useReader.getState().searchFocusPage
    let index = current == null ? (direction > 0 ? -1 : 0) : pages.indexOf(current)
    index += direction
    if (index >= pages.length) index = 0
    if (index < 0) index = pages.length - 1
    setSearchFocusPage(pages[index])
    onEnterPage(pages[index])
  }
  const close = () => {
    setQuery('')
    setSearchTerm('')
    setSearchFocusPage(null)
    toggleSearch(false)
  }

  return (
    <div className="pnx-search-panel" role="search">
      <IconSearch size={15} />
      <input
        autoFocus
        value={query}
        placeholder="搜索本文…"
        aria-label="页内搜索"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            jump(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="pnx-search-count">{busy ? '搜索中…' : query.trim() ? `${total} 处 · ${matches.length} 页` : 'OCR 优先'}</span>
      <button title="上一个 (Shift+Enter)" aria-label="上一个搜索结果" onClick={() => jump(-1)}>↑</button>
      <button title="下一个 (Enter)" aria-label="下一个搜索结果" onClick={() => jump(1)}>↓</button>
      <button title="关闭 (Esc)" aria-label="关闭搜索" onClick={close}><IconX size={12} /></button>
    </div>
  )
}

function RefBar() {
  const direction = useRefLink((state) => state.direction)
  const entryNo = useRefLink((state) => state.entryNo)
  const hits = useRefLink((state) => state.hits)
  const hitIdx = useRefLink((state) => state.hitIdx)
  const scanning = useRefLink((state) => state.scanning)
  if (!entryNo || !direction) return null
  return (
    <div className="pnx-ref-bar">
      <span className="pnx-ref-title">{direction === 'backward' ? `文献 [${entryNo}] → 正文` : `已定位参考文献 [${entryNo}]`}</span>
      {scanning && <span className="pnx-mini-spinner" aria-label="正在扫描" />}
      {direction === 'backward' && hits.length > 0 && (
        <>
          <span className="pnx-ref-position">第 {hitIdx + 1}/{hits.length} 处 · p.{hits[hitIdx].page + 1}</span>
          <button title="上一处" aria-label="上一处引用" onClick={() => useRefLink.getState().nextHit(-1)}>↑</button>
          <button title="下一处" aria-label="下一处引用" onClick={() => useRefLink.getState().nextHit(1)}>↓</button>
        </>
      )}
      {direction === 'backward' && !scanning && hits.length === 0 && <span className="pnx-ref-empty">未找到引用</span>}
      <button className="pnx-ref-return" aria-label="返回回链前的位置" onClick={() => useRefLink.getState().goOrigin()}>返回原位</button>
      <button title="关闭 (Esc)" aria-label="关闭回链" onClick={() => useRefLink.getState().close()}><IconX size={12} /></button>
    </div>
  )
}

function OcrBanner({
  paper,
  status,
  progress,
  error,
  onStart,
  onRetry,
  onCancel,
}: {
  paper: { is_scanned: boolean }
  status: string
  progress: { done: number; total: number } | null
  error: string | null
  onStart: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  if (status === 'done' || (!paper.is_scanned && status === 'none')) return null
  return (
    <div className="pnx-ocr-banner" role="status">
      {(status === 'pending' || status === 'running') && (
        <>
          <span className="pnx-mini-spinner" aria-hidden />
          <span>OCR 解析中{progress ? ` · ${progress.done}/${progress.total} 页` : '…'}</span>
          <button onClick={onCancel}>取消</button>
        </>
      )}
      {status === 'failed' && (
        <>
          <span className="pnx-ocr-error">OCR 失败{error ? `：${error.slice(0, 40)}` : ''}</span>
          <button onClick={onRetry}>重试（跳过已完成页）</button>
        </>
      )}
      {status === 'none' && paper.is_scanned && (
        <>
          <span>扫描版论文 · OCR 后可选中文字并翻译</span>
          <button className="pnx-ocr-start" onClick={onStart}>开始 OCR</button>
        </>
      )}
    </div>
  )
}
