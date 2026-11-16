import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type UIEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Paper, Project } from '../api/types'
import { useAuth } from '../stores/auth'
import { useLibraryUi } from '../stores/libraryUi'
import { paperToTabInput, useReaderTabs } from '../stores/readerTabs'
import { useCompareStore } from '../stores/compareStore'
import { getMdDirty, guardMdNav } from '../features/reader/mdDirty'
import { resolveSort, type LibraryView, type SortKey } from '../features/library/sort'
import { detectScanned } from '../features/library/detectScanned'
import { useLibraryDnd, type DndGroup } from '../features/library/dnd/useLibraryDnd'
import { dragKind } from '../features/library/dnd/guard'
import type { GroupKey } from '../features/library/dnd/types'
import { ConfirmModal } from '../features/shared/Modal'
import { toast } from '../features/shared/Toast'
import EditPaperModal from '../features/library/EditPaperModal'
import NextPaperCard, { type OcrProgress } from './NextPaperCard'
import NextProjectRail from './NextProjectRail'
import './NextLibraryPage.css'

// 网格列数换算与 .pnx-grid 的 column-gap 必须一致，否则列数与实际排版会错位。
const CARD_MIN_WIDTH = 196
const CARD_COL_GAP = 14

const VIEW_TABS: { key: LibraryView; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'project', label: '项目' },
  { key: 'recent', label: '最近' },
  { key: 'opened', label: '打开过' },
  { key: 'favorite', label: '收藏' },
]

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'created', label: '按上传时间' },
  { key: 'title', label: '按标题' },
  { key: 'last_opened', label: '按最近打开' },
]

const DOCUMENT_EXTENSIONS = /\.(pdf|md|markdown)$/i
const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i

type IconName = 'search' | 'upload' | 'plus' | 'file' | 'pause' | 'play' | 'close' | 'book' | 'trash'

const ICON_PATHS: Record<IconName, ReactNode> = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 14v5h14v-5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  file: <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  pause: <><path d="M9 5v14M15 5v14" /></>,
  play: <path d="m8 5 11 7-11 7z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  book: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22z" /><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5a3.5 3.5 0 0 1 3.5 3z" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>,
}

function PnxIcon({ name }: { name: IconName }) {
  return <svg className="pnx-icon" viewBox="0 0 24 24" aria-hidden="true">{ICON_PATHS[name]}</svg>
}

interface UploadProgress {
  done: number
  total: number
  current: string
  phase: 'checking' | 'uploading'
}

interface EditPatch {
  title: string
  authors: string
  year: number | null
  venue: string
  doi: string
  tags: string[]
  note: string
}

export default function NextLibraryPage() {
  const navigate = useNavigate()
  const [papers, setPapers] = useState<Paper[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const view = useLibraryUi((state) => state.view)
  const selectedProjectId = useLibraryUi((state) => state.selectedProjectId)
  const qInput = useLibraryUi((state) => state.qInput)
  const sort = useLibraryUi((state) => state.sort)
  const expanded = useLibraryUi((state) => state.expanded)
  const setView = useLibraryUi((state) => state.setView)
  const setSelectedProjectId = useLibraryUi((state) => state.setSelectedProjectId)
  const setQInput = useLibraryUi((state) => state.setQInput)
  const setSort = useLibraryUi((state) => state.setSort)
  const toggleExpandedKey = useLibraryUi((state) => state.toggleExpanded)
  const animations = useAuth((state) => state.settings.animations)

  const [q, setQ] = useState(() => useLibraryUi.getState().qInput.trim())
  const [loading, setLoading] = useState(true)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [editing, setEditing] = useState<Paper | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [deleting, setDeleting] = useState<Paper | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<Record<number, OcrProgress>>({})
  const [queuePaused, setQueuePaused] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)
  const [cols, setCols] = useState(5)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [allTags, setAllTags] = useState<{ name: string; count: number }[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [arxivOpen, setArxivOpen] = useState(false)
  const [arxivInput, setArxivInput] = useState('')
  const [arxivBusy, setArxivBusy] = useState(false)
  const [mdOpen, setMdOpen] = useState(false)
  const [mdTitle, setMdTitle] = useState('')
  const [mdBusy, setMdBusy] = useState(false)

  const contentRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const scrollPos = useRef(useLibraryUi.getState().scrollTop)
  const scrollRestored = useRef(false)
  const flipRectsRef = useRef<Map<Element, DOMRect> | null>(null)
  const uploadBusyRef = useRef(false)
  const paperRequestRef = useRef(0)
  const projectRequestRef = useRef(0)
  const uploading = uploadProgress !== null

  const captureFlip = useCallback(() => {
    if (!useAuth.getState().settings.animations) return
    if (document.documentElement.classList.contains('no-motion')) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const grids = contentRef.current?.querySelectorAll('.pnx-grid')
    if (!grids?.length) return
    const rects = new Map<Element, DOMRect>()
    grids.forEach((grid) => {
      grid.querySelectorAll('[data-card]').forEach((card) => rects.set(card, card.getBoundingClientRect()))
    })
    flipRectsRef.current = rects
  }, [])

  useLayoutEffect(() => {
    const first = flipRectsRef.current
    if (!first?.size) return
    flipRectsRef.current = null
    const moving: HTMLElement[] = []
    contentRef.current?.querySelectorAll('.pnx-grid [data-card]').forEach((node) => {
      const card = node as HTMLElement
      const previous = first.get(card)
      if (!previous) return
      const last = card.getBoundingClientRect()
      const dx = previous.left - last.left
      const dy = previous.top - last.top
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return
      card.style.transition = 'none'
      card.style.transform = `translate(${dx}px, ${dy}px)`
      moving.push(card)
    })
    if (!moving.length) return
    let cleanupTimer: number | undefined
    const frame = requestAnimationFrame(() => {
      moving.forEach((card) => {
        card.style.transition = 'transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1)'
        card.style.transform = ''
      })
      cleanupTimer = window.setTimeout(() => {
        moving.forEach((card) => {
          card.style.transition = ''
          card.style.transform = ''
        })
      }, 300)
    })
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(cleanupTimer)
      moving.forEach((card) => {
        card.style.transition = ''
        card.style.transform = ''
      })
    }
  }, [cols])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    let frame = 0
    let debounceTimer: number | undefined
    let lastCols = cols
    // 卡片最小宽 196px、列间距 14px（与 .pnx-grid 的 column-gap 一致）。
    // 上限 6 列：再窄标题就会碎行，1920 宽屏也保持 5~6 列的手感。
    const calculate = (width: number) => Math.min(6, Math.max(2, Math.floor((width + CARD_COL_GAP) / (CARD_MIN_WIDTH + CARD_COL_GAP))))
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? element.clientWidth)
      const nextCols = calculate(width)
      window.clearTimeout(debounceTimer)
      if (nextCols === lastCols) return
      debounceTimer = window.setTimeout(() => {
        lastCols = nextCols
        captureFlip()
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => setCols(nextCols))
      }, 280)
    })
    observer.observe(element)
    const initialWidth = Math.round(element.clientWidth)
    if (initialWidth) {
      const initialCols = calculate(initialWidth)
      if (initialCols !== cols) {
        lastCols = initialCols
        setCols(initialCols)
      }
    }
    return () => {
      window.clearTimeout(debounceTimer)
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // 列数观察器只挂载一次；内部 lastCols 跟踪最新提交值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureFlip])

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [qInput])

  useEffect(() => () => {
    useLibraryUi.getState().setScrollTop(scrollPos.current)
  }, [])

  useEffect(() => {
    if (loading || scrollRestored.current) return
    scrollRestored.current = true
    const frame = requestAnimationFrame(() => {
      const element = contentRef.current
      if (element && scrollPos.current > 0) element.scrollTop = scrollPos.current
    })
    return () => cancelAnimationFrame(frame)
  }, [loading])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    scrollPos.current = event.currentTarget.scrollTop
  }, [])

  // 卡片自己的 onDragOver 已写入插入位；分组容器的同名处理会因根节点无旧类名而误清空，
  // 这里在网格层截停卡片上的冒泡，既保留插入指示，也不改写 useLibraryDnd 的投放逻辑。
  const keepCardInsertMark = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragKind(event.dataTransfer.types) !== 'paper') return
    if ((event.target as HTMLElement).closest?.('[data-card]')) event.stopPropagation()
  }, [])

  useEffect(() => {
    if (localStorage.getItem('pl_wizard_done') !== '1') navigate('/wizard', { replace: true })
  }, [navigate])

  const fetchPapers = useCallback(async () => {
    const requestId = ++paperRequestRef.current
    try {
      const list = await api.papers({
        q: q || undefined,
        sort: resolveSort(view, sort),
        favorite: view === 'favorite' ? true : undefined,
        opened: view === 'opened' ? true : undefined,
        project_id: selectedProjectId ?? undefined,
        tag: tagFilter ?? undefined,
      })
      if (requestId !== paperRequestRef.current) return
      setPapers(list)
      setSelected((previous) => {
        const ids = new Set(list.map((paper) => paper.id))
        const next = new Set([...previous].filter((id) => ids.has(id)))
        return next.size === previous.size ? previous : next
      })
    } catch (error) {
      if (requestId === paperRequestRef.current) {
        toast(error instanceof Error ? error.message : '加载论文失败', 'error')
      }
    } finally {
      if (requestId === paperRequestRef.current) setLoading(false)
    }
  }, [q, sort, view, selectedProjectId, tagFilter])

  const refreshProjects = useCallback(async () => {
    const requestId = ++projectRequestRef.current
    try {
      const list = await api.projects()
      if (requestId === projectRequestRef.current) setProjects(list)
    } catch {
      // 项目栏保留上次可用数据，论文列表仍可继续使用。
    }
  }, [])

  const grouped = useMemo<DndGroup[]>(() => {
    const byKey = new Map<GroupKey, Paper[]>()
    for (const paper of papers) {
      const key: GroupKey = paper.project_id ?? null
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(paper)
    }
    const itemsOf = (key: GroupKey) => (byKey.get(key) ?? [])
      .slice()
      .sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.sort_order - b.sort_order || a.id - b.id)
    const groups: DndGroup[] = projects.map((project) => ({
      key: project.id,
      project,
      items: itemsOf(project.id),
    }))
    groups.push({ key: null, project: null, items: itemsOf(null) })
    return groups
  }, [papers, projects])

  const singleGroupItems = useMemo(() => selectedProjectId == null
    ? []
    : papers
      .filter((paper) => paper.project_id === selectedProjectId)
      .sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.sort_order - b.sort_order || a.id - b.id),
  [papers, selectedProjectId])

  const dndGroups = useMemo<DndGroup[]>(() => {
    if (view !== 'project') return []
    if (selectedProjectId == null) return grouped
    return [{
      key: selectedProjectId,
      project: projects.find((project) => project.id === selectedProjectId) ?? null,
      items: singleGroupItems,
    }]
  }, [view, selectedProjectId, grouped, projects, singleGroupItems])

  const dnd = useLibraryDnd({
    papers,
    groups: dndGroups,
    enabled: view === 'project' && q === '',
    pageUploadProjectId: selectedProjectId,
    onPapersChange: setPapers,
    onUpload: (files, projectId) => void handleFiles(files, projectId),
    onRefresh: fetchPapers,
    onCountsChange: (movedIds, toProject) => {
      setProjects((current) => current.map((project) => {
        let count = project.paper_count ?? 0
        if (project.id === toProject) count += movedIds.length
        else count -= movedIds.filter((id) => papers.some((paper) => paper.id === id && paper.project_id === project.id)).length
        return { ...project, paper_count: Math.max(0, count) }
      }))
    },
    onProjectsRefresh: refreshProjects,
  })
  const refreshPapers = dnd.refresh

  useEffect(() => {
    setLoading(true)
    void refreshPapers()
  }, [q, sort, view, selectedProjectId, tagFilter, refreshPapers])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    let cancelled = false
    api.paperTags()
      .then((tags) => {
        if (!cancelled) setAllTags(tags)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [papers])

  const hasOcrQueue = papers.some((paper) => paper.ocr_status === 'pending' || paper.ocr_status === 'running')

  useEffect(() => {
    const active = papers.filter((paper) => paper.ocr_status === 'pending' || paper.ocr_status === 'running')
    if (!active.length) return
    let cancelled = false
    let ticking = false
    const tick = async () => {
      if (ticking) return
      ticking = true
      try {
        for (const paper of active.filter((item) => item.ocr_status === 'running')) {
          try {
            const status = await api.ocrStatus(paper.id)
            if (!cancelled) {
              setOcrProgress((current) => ({
                ...current,
                [paper.id]: { pages_done: status.pages_done, pages_total: status.pages_total },
              }))
            }
          } catch {
            // 单次状态失败不打断后续轮询。
          }
        }
        if (!cancelled) await refreshPapers()
      } finally {
        ticking = false
      }
    }
    const timer = window.setInterval(() => void tick(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [papers, refreshPapers])

  useEffect(() => {
    if (!hasOcrQueue) return
    let cancelled = false
    let ticking = false
    const tick = async () => {
      if (ticking) return
      ticking = true
      try {
        const queue = await api.ocrQueue()
        if (!cancelled) setQueuePaused(queue.paused)
      } catch {
        // 队列状态暂时不可用时保留当前显示。
      } finally {
        ticking = false
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [hasOcrQueue])

  const handleFiles = async (files: File[], projectId: number | null = selectedProjectId) => {
    if (uploadBusyRef.current) {
      toast('正在上传，请等待当前批次完成', 'error')
      return
    }
    const documents = files.filter((file) => DOCUMENT_EXTENSIONS.test(file.name))
    if (!documents.length) {
      toast('仅支持 PDF / Markdown 文件', 'error')
      return
    }
    if (documents.length < files.length) {
      toast(`已忽略 ${files.length - documents.length} 个不支持的文件`, 'error')
    }
    uploadBusyRef.current = true
    setUploadProgress({ done: 0, total: documents.length, current: documents[0].name, phase: 'checking' })
    try {
      for (let index = 0; index < documents.length; index++) {
        const file = documents[index]
        const isMarkdown = MARKDOWN_EXTENSIONS.test(file.name)
        setUploadProgress({ done: index, total: documents.length, current: file.name, phase: 'checking' })
        const scanned = isMarkdown ? false : await detectScanned(file).catch(() => false)
        setUploadProgress({ done: index, total: documents.length, current: file.name, phase: 'uploading' })
        const result = await api.uploadPaper(file, projectId, scanned)
        if (isMarkdown) toast(`已上传：${result.paper.title}（Markdown）`, 'ok')
        else toast(`已上传：${result.paper.title}${scanned ? '（扫描版，已自动进入 OCR 队列）' : ''}`, 'ok')
        setUploadProgress({ done: index + 1, total: documents.length, current: file.name, phase: 'uploading' })
      }
      await refreshPapers()
      await refreshProjects()
    } catch (error) {
      toast(error instanceof Error ? error.message : '上传失败', 'error')
    } finally {
      uploadBusyRef.current = false
      setUploadProgress(null)
    }
  }

  const openPaper = (paper: Paper) => {
    const opened = useReaderTabs.getState().openReaderTab(paperToTabInput(paper))
    if (!opened) {
      toast('页签已达上限，请先关闭部分页签', 'error')
      return
    }
    navigate(`/reader/${paper.id}`)
  }

  const toggleFavorite = async (paper: Paper) => {
    try {
      await api.updatePaper(paper.id, { is_favorite: !paper.is_favorite })
      setPapers((current) => current.map((item) => item.id === paper.id ? { ...item, is_favorite: !paper.is_favorite } : item))
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error')
    }
  }

  const saveEdit = async (patch: EditPatch) => {
    if (!editing || editBusy) return
    setEditBusy(true)
    try {
      await api.updatePaper(editing.id, patch)
      setEditing(null)
      await refreshPapers()
      toast('元数据已保存', 'ok')
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setEditBusy(false)
    }
  }

  const closePaperArtifacts = (id: number) => {
    useReaderTabs.getState().closeReaderTab(id)
    const compare = useCompareStore.getState()
    if (compare.paperId === id) compare.setPaper(null)
  }

  const doRemove = async (id: number) => {
    if (deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.deletePaper(id)
      closePaperArtifacts(id)
      setDeleting(null)
      await refreshPapers()
      await refreshProjects()
      toast('论文已删除', 'ok')
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const removePaper = async () => {
    if (!deleting) return
    if (getMdDirty() === deleting.id) {
      const id = deleting.id
      if (guardMdNav(() => void doRemove(id))) return
    }
    await doRemove(deleting.id)
  }

  const retryOcr = async (paper: Paper) => {
    try {
      await api.retryOcr(paper.id)
      toast('已重新入 OCR 队列', 'ok')
      await refreshPapers()
    } catch (error) {
      toast(error instanceof Error ? error.message : '重试失败', 'error')
    }
  }

  const cancelOcr = async (paper: Paper) => {
    try {
      await api.cancelOcr(paper.id)
      toast('已取消排队', 'ok')
      await refreshPapers()
    } catch (error) {
      toast(error instanceof Error ? error.message : '取消失败', 'error')
    }
  }

  const toggleQueue = async () => {
    if (queueBusy) return
    setQueueBusy(true)
    try {
      const result = await api.ocrQueuePause(!queuePaused)
      setQueuePaused(result.paused)
      toast(result.paused ? 'OCR 队列已暂停' : 'OCR 队列已恢复', 'ok')
    } catch {
      toast('队列操作失败', 'error')
    } finally {
      setQueueBusy(false)
    }
  }

  const toggleSelect = (id: number) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulkPatch = async (patch: Record<string, unknown>, successMessage: string) => {
    if (bulkBusy || !selected.size) return
    setBulkBusy(true)
    const ids = [...selected]
    let failed = false
    try {
      for (const id of ids) {
        try {
          await api.updatePaper(id, patch)
        } catch {
          failed = true
          break
        }
      }
      toast(failed ? '部分操作失败，已停止' : successMessage, failed ? 'error' : 'ok')
      setSelected(new Set())
      await refreshPapers()
      await refreshProjects()
    } finally {
      setBulkBusy(false)
    }
  }

  const doBulkDelete = async () => {
    if (bulkBusy || !selected.size) return
    setBulkBusy(true)
    const ids = [...selected]
    let failed = false
    try {
      for (const id of ids) {
        try {
          await api.deletePaper(id)
          closePaperArtifacts(id)
        } catch {
          failed = true
          break
        }
      }
      setBulkDeleting(false)
      toast(failed ? '部分删除失败，已停止' : `已删除 ${ids.length} 篇论文`, failed ? 'error' : 'ok')
      setSelected(new Set())
      await refreshPapers()
      await refreshProjects()
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkDelete = async () => {
    const dirty = getMdDirty()
    if (dirty != null && selected.has(dirty)) {
      if (guardMdNav(() => void doBulkDelete())) return
    }
    await doBulkDelete()
  }

  const importArxiv = async () => {
    const id = arxivInput.trim()
    if (!id || arxivBusy) return
    setArxivBusy(true)
    try {
      const paper = await api.importArxiv(id)
      toast(`已导入：${paper.title}`, 'ok')
      setArxivOpen(false)
      setArxivInput('')
      await refreshPapers()
      await refreshProjects()
    } catch (error) {
      toast(error instanceof Error ? error.message : '导入失败', 'error')
    } finally {
      setArxivBusy(false)
    }
  }

  const createMarkdown = async () => {
    const title = mdTitle.trim()
    if (!title || mdBusy) return
    setMdBusy(true)
    try {
      const paper = await api.createMarkdown(title, selectedProjectId ?? undefined)
      toast(`已创建：${paper.title}（Markdown）`, 'ok')
      setMdOpen(false)
      setMdTitle('')
      await refreshPapers()
      await refreshProjects()
    } catch (error) {
      toast(error instanceof Error ? error.message : '创建失败', 'error')
    } finally {
      setMdBusy(false)
    }
  }

  const cardList = (list: Paper[], groupKey?: GroupKey) => list.map((paper, index) => (
    <NextPaperCard
      key={paper.id}
      paper={paper}
      ocrProgress={ocrProgress[paper.id] ?? null}
      onOpen={openPaper}
      onEdit={setEditing}
      onToggleFav={toggleFavorite}
      onDelete={setDeleting}
      onRetryOcr={retryOcr}
      onCancelOcr={cancelOcr}
      dragProps={groupKey !== undefined ? dnd.cardDragProps(paper.id, groupKey) : undefined}
      isDragging={dnd.draggingId === paper.id}
      insertSide={dnd.insertMark?.id === paper.id ? dnd.insertMark.side : null}
      enterIndex={index}
      selected={selected.has(paper.id)}
      onToggleSelect={toggleSelect}
      showOpenedAt={view === 'opened'}
    />
  ))

  const visibleItems = (items: Paper[], key: GroupKey) => {
    if (q !== '' || selectedProjectId != null || expanded.has(key) || items.length <= cols) return items
    return items.slice(0, cols)
  }

  const gridStyle: CSSProperties = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
  const pageDrop = dnd.pageDropProps()
  const activeProject = projects.find((project) => project.id === selectedProjectId)
  const currentTitle = activeProject?.name ?? VIEW_TABS.find((tab) => tab.key === view)?.label ?? '全部'
  const hasFilters = !!q || selectedProjectId != null || !!tagFilter || view === 'favorite' || view === 'opened'
  const uploadPercent = uploadProgress
    ? Math.round((uploadProgress.done / uploadProgress.total) * 100)
    : 0

  return (
    <div
      className={`pnx-root pnx-library-page${animations ? '' : ' pnx-motion-off'}`}
      data-motion={animations ? 'on' : 'off'}
      onDragEnter={pageDrop.onDragEnter}
      onDragOver={pageDrop.onDragOver}
      onDragLeave={pageDrop.onDragLeave}
      onDrop={pageDrop.onDrop}
    >
      {pageDrop.isOver && (
        <div className="pnx-drop-overlay" role="status">
          <div className="pnx-drop-card">
            <span className="pnx-drop-icon"><PnxIcon name="upload" /></span>
            <strong>松手，把文献放上书架</strong>
            <span>上传到{activeProject ? `「${activeProject.name}」` : '文库'} · 扫描版 PDF 将自动 OCR</span>
          </div>
        </div>
      )}

      <header className="pnx-header">
        <div className="pnx-title-block">
          <span className="pnx-eyebrow">PaperLens 书房</span>
          <h1>我的文库</h1>
          <p>让每一篇论文，都有可归之处。</p>
        </div>
        <div className="pnx-library-stat" aria-label={`当前列表 ${papers.length} 篇文献`}>
          <span className="pnx-library-stat-icon"><PnxIcon name="book" /></span>
          <div><strong>{papers.length}</strong><span>当前文献</span></div>
        </div>
      </header>

      <section className="pnx-controls" aria-label="文库筛选与操作">
        <div className="pnx-toolbar">
          <label className="pnx-search">
            <span className="pnx-sr-only">搜索论文标题或作者</span>
            <PnxIcon name="search" />
            <input
              value={qInput}
              placeholder="搜索标题 / 作者…"
              onChange={(event) => setQInput(event.target.value)}
            />
            {qInput && (
              <button type="button" className="pnx-search-clear" aria-label="清空搜索" onClick={() => setQInput('')}>
                <PnxIcon name="close" />
              </button>
            )}
          </label>

          <nav className="pnx-view-tabs" aria-label="文库视图">
            {VIEW_TABS.map((tab) => {
              const active = view === tab.key && (tab.key !== 'project' || selectedProjectId == null)
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`pnx-view-tab${active ? ' pnx-is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => {
                    if (tab.key === 'project') setSelectedProjectId(null)
                    setView(tab.key)
                  }}
                >
                  {tab.label}
                </button>
              )
            })}
          </nav>

          <div className="pnx-filter-group">
            {view === 'project' ? (
              <span className="pnx-manual-badge" title="项目视图使用手动顺序">手动排序</span>
            ) : (
              <label className="pnx-select-wrap">
                <span className="pnx-sr-only">论文排序方式</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </select>
              </label>
            )}
            <label className={`pnx-select-wrap pnx-tag-select${tagFilter ? ' pnx-is-active' : ''}`}>
              <span className="pnx-sr-only">按标签过滤</span>
              <select value={tagFilter ?? ''} onChange={(event) => setTagFilter(event.target.value || null)}>
                <option value="">全部标签</option>
                {allTags.map((tag) => <option key={tag.name} value={tag.name}>#{tag.name}（{tag.count}）</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="pnx-action-row">
          <div className="pnx-context-badges">
            {activeProject && (
              <span className="pnx-context-badge">
                项目：{activeProject.name}
                <button
                  type="button"
                  aria-label="清除项目筛选"
                  onClick={() => {
                    setSelectedProjectId(null)
                    setView('all')
                  }}
                ><PnxIcon name="close" /></button>
              </span>
            )}
            {tagFilter && <span className="pnx-context-badge">标签：#{tagFilter}</span>}
          </div>

          <div className="pnx-actions">
            {hasOcrQueue && (
              <button type="button" className="pnx-button pnx-button-quiet" onClick={() => void toggleQueue()} disabled={queueBusy}>
                <PnxIcon name={queuePaused ? 'play' : 'pause'} />
                {queueBusy ? '处理中…' : queuePaused ? '恢复 OCR 队列' : '暂停 OCR 队列'}
              </button>
            )}
            <button
              type="button"
              className={`pnx-button${mdOpen ? ' pnx-is-active' : ''}`}
              disabled={uploading}
              onClick={() => {
                setMdOpen(true)
                setArxivOpen(false)
              }}
            ><PnxIcon name="file" />新建 Markdown</button>
            <button
              type="button"
              className={`pnx-button${arxivOpen ? ' pnx-is-active' : ''}`}
              disabled={uploading}
              onClick={() => {
                setArxivOpen(true)
                setMdOpen(false)
              }}
            ><PnxIcon name="plus" />导入 arXiv</button>
            <input
              ref={fileInput}
              className="pnx-file-input"
              type="file"
              accept="application/pdf,.pdf,.md,.markdown"
              multiple
              aria-label="选择 PDF 或 Markdown 文件"
              onChange={(event) => {
                if (event.target.files?.length) void handleFiles([...event.target.files])
                event.target.value = ''
              }}
            />
            <button type="button" className="pnx-button pnx-button-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <PnxIcon name="upload" />{uploading ? '正在上传…' : '添加文献'}
            </button>
          </div>
        </div>

        {(mdOpen || arxivOpen) && (
          <div className="pnx-create-panel">
            {mdOpen && (
              <form
                className="pnx-create-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createMarkdown()
                }}
              >
                <span className="pnx-create-label">新建 Markdown</span>
                <label className="pnx-sr-only" htmlFor="pnx-md-title">Markdown 标题</label>
                <input
                  id="pnx-md-title"
                  className="pnx-input"
                  autoFocus
                  value={mdTitle}
                  placeholder="输入文档标题，回车创建"
                  onChange={(event) => setMdTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !mdBusy) setMdOpen(false)
                  }}
                />
                <button type="submit" className="pnx-button pnx-button-primary" disabled={mdBusy || !mdTitle.trim()}>{mdBusy ? '创建中…' : '创建'}</button>
                <button type="button" className="pnx-icon-button" aria-label="关闭新建 Markdown" disabled={mdBusy} onClick={() => setMdOpen(false)}><PnxIcon name="close" /></button>
              </form>
            )}
            {arxivOpen && (
              <form
                className="pnx-create-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void importArxiv()
                }}
              >
                <span className="pnx-create-label">导入 arXiv</span>
                <label className="pnx-sr-only" htmlFor="pnx-arxiv-id">arXiv ID</label>
                <input
                  id="pnx-arxiv-id"
                  className="pnx-input"
                  autoFocus
                  value={arxivInput}
                  placeholder="例如 2401.12345"
                  onChange={(event) => setArxivInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !arxivBusy) setArxivOpen(false)
                  }}
                />
                <button type="submit" className="pnx-button pnx-button-primary" disabled={arxivBusy || !arxivInput.trim()}>{arxivBusy ? '导入中…' : '导入'}</button>
                <button type="button" className="pnx-icon-button" aria-label="关闭 arXiv 导入" disabled={arxivBusy} onClick={() => setArxivOpen(false)}><PnxIcon name="close" /></button>
              </form>
            )}
          </div>
        )}

        {uploadProgress && (
          <div className="pnx-upload-status" role="status" aria-live="polite">
            <div className="pnx-upload-copy">
              <strong>{uploadProgress.phase === 'checking' ? '正在检查扫描版' : '正在写入文库'}</strong>
              <span title={uploadProgress.current}>{uploadProgress.current}</span>
              <span>{uploadProgress.done + (uploadProgress.done < uploadProgress.total ? 1 : 0)} / {uploadProgress.total}</span>
            </div>
            <div className="pnx-progress-track" aria-hidden="true">
              <span style={{ width: `${Math.max(4, uploadPercent)}%` }} />
            </div>
          </div>
        )}
      </section>

      <div className="pnx-workspace">
        <NextProjectRail
          projects={projects}
          activeProjectId={selectedProjectId}
          onSelect={(id) => {
            setSelectedProjectId(id)
            setView(id == null ? 'all' : 'project')
          }}
          onChanged={() => void refreshProjects()}
          onPaperDrop={dnd.railPaperDrop}
          onFileDrop={dnd.railFileDrop}
        />

        <div ref={contentRef} className="pnx-content" onScroll={handleScroll} tabIndex={0} aria-label="论文书架，可滚动">
          <div className="pnx-content-heading">
            <div>
              <span className="pnx-eyebrow">文献书架</span>
              <h2>{currentTitle}</h2>
            </div>
            {!loading && <span>{papers.length} 篇</span>}
          </div>

          {loading ? (
            <div className="pnx-grid pnx-loading-grid" style={gridStyle} aria-label="正在加载文库" aria-busy="true">
              {Array.from({ length: cols }, (_, index) => <div className="pnx-skeleton-card" key={index} />)}
            </div>
          ) : papers.length === 0 && view !== 'project' ? (
            <EmptyState
              filtered={hasFilters}
              onUpload={() => fileInput.current?.click()}
              onClear={() => {
                setQInput('')
                setTagFilter(null)
                setSelectedProjectId(null)
                setView('all')
              }}
            />
          ) : view === 'project' && selectedProjectId == null ? (
            <div className="pnx-shelves">
              {grouped.map((group, index) => {
                const groupDrop = dnd.groupDropProps(group.key)
                const visible = visibleItems(group.items, group.key)
                const collapsed = !expanded.has(group.key) && group.items.length > cols && q === ''
                return (
                  <section
                    key={group.key ?? '__none'}
                    className={`pnx-shelf${groupDrop.isOver ? ' pnx-is-over' : ''}`}
                    data-group-drop
                    data-project-id={group.key ?? ''}
                    aria-labelledby={`pnx-group-${group.key ?? 'none'}`}
                    onDragEnter={groupDrop.onDragEnter}
                    onDragOver={groupDrop.onDragOver}
                    onDragLeave={groupDrop.onDragLeave}
                    onDrop={groupDrop.onDrop}
                  >
                    <div className="pnx-shelf-title-row">
                      <span className="pnx-shelf-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <h3 id={`pnx-group-${group.key ?? 'none'}`}>{group.project?.name ?? '未分组'}</h3>
                      <span className="pnx-shelf-count">{group.items.length} 篇</span>
                      <span className="pnx-shelf-title-rule" aria-hidden="true" />
                      {q === '' && <span className="pnx-shelf-hint">可拖拽整理</span>}
                    </div>
                    {group.items.length === 0 ? (
                      <div className="pnx-empty-shelf">这一层还空着，拖拽 PDF、Markdown 或论文卡片到这里。</div>
                    ) : (
                      <>
                        <div className="pnx-grid" style={gridStyle} onDragOver={keepCardInsertMark}>{cardList(visible, group.key)}</div>
                        {group.items.length > cols && q === '' && (
                          <button type="button" className="pnx-expand-button" onClick={() => toggleExpandedKey(group.key)}>
                            {collapsed ? `展开其余 ${group.items.length - cols} 篇` : '收起这一层'}
                          </button>
                        )}
                      </>
                    )}
                    <div className="pnx-shelf-base" aria-hidden="true" />
                  </section>
                )
              })}
            </div>
          ) : view === 'project' ? (
            (() => {
              const groupDrop = dnd.groupDropProps(selectedProjectId)
              return (
                <section
                  className={`pnx-shelf pnx-single-shelf${groupDrop.isOver ? ' pnx-is-over' : ''}`}
                  data-group-drop
                  data-project-id={selectedProjectId ?? ''}
                  aria-label={activeProject?.name ?? '当前项目'}
                  onDragEnter={groupDrop.onDragEnter}
                  onDragOver={groupDrop.onDragOver}
                  onDragLeave={groupDrop.onDragLeave}
                  onDrop={groupDrop.onDrop}
                >
                  {singleGroupItems.length === 0 ? (
                    <div className="pnx-empty-shelf pnx-empty-shelf-large">
                      <PnxIcon name="book" />
                      <strong>这层书架还空着</strong>
                      <span>拖拽文件到这里上传，或把其他论文卡片拖进来。</span>
                    </div>
                  ) : <div className="pnx-grid" style={gridStyle} onDragOver={keepCardInsertMark}>{cardList(singleGroupItems, selectedProjectId)}</div>}
                  <div className="pnx-shelf-base" aria-hidden="true" />
                </section>
              )
            })()
          ) : (
            <section className="pnx-shelf pnx-flat-shelf" aria-label={currentTitle}>
              <div className="pnx-grid" style={gridStyle} onDragOver={keepCardInsertMark}>{cardList(papers)}</div>
              <div className="pnx-shelf-base" aria-hidden="true" />
            </section>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="pnx-bulk-bar" role="region" aria-label="批量操作">
          <span className="pnx-bulk-count">已选 <strong>{selected.size}</strong> 篇</span>
          <span className="pnx-bulk-divider" aria-hidden="true" />
          <label className="pnx-sr-only" htmlFor="pnx-bulk-project">移动选中论文到项目</label>
          <select
            id="pnx-bulk-project"
            className="pnx-input pnx-bulk-select"
            value=""
            disabled={bulkBusy}
            onChange={(event) => {
              const projectId = event.target.value === 'none' ? null : event.target.value ? Number(event.target.value) : undefined
              if (projectId === undefined) return
              const label = projectId === null ? '未分组' : projects.find((project) => project.id === projectId)?.name ?? '未分组'
              void bulkPatch({ project_id: projectId }, `已移动到「${label}」`)
            }}
          >
            <option value="">移动到项目…</option>
            <option value="none">未分组</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button type="button" className="pnx-button" disabled={bulkBusy} onClick={() => void bulkPatch({ is_favorite: true }, '已收藏选中论文')}>收藏</button>
          <button type="button" className="pnx-button pnx-button-danger" disabled={bulkBusy} onClick={() => setBulkDeleting(true)}><PnxIcon name="trash" />删除</button>
          <button type="button" className="pnx-button pnx-button-quiet" disabled={bulkBusy} onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}

      <EditPaperModal paper={editing} busy={editBusy} onClose={() => setEditing(null)} onSave={(patch) => void saveEdit(patch)} />

      <ConfirmModal
        open={bulkDeleting}
        title="批量删除论文"
        confirmText={`永久删除 ${selected.size} 篇`}
        danger
        busy={bulkBusy}
        onClose={() => setBulkDeleting(false)}
        onConfirm={() => void bulkDelete()}
      >
        <div className="pnx-confirm-copy">
          <p>确定永久删除选中的 <strong>{selected.size}</strong> 篇论文吗？</p>
          <p>全部批注、生词记录、阅读进度与缓存将一并删除，且不可恢复。</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={!!deleting}
        title="删除论文"
        confirmText="永久删除"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removePaper()}
      >
        <div className="pnx-confirm-copy">
          <p>确定永久删除「{deleting?.title}」吗？</p>
          <p>批注与卡片笔记、生词出现记录、术语表、翻译缓存、阅读进度与 OCR 解析结果将一并删除，且不可恢复。</p>
        </div>
      </ConfirmModal>
    </div>
  )
}

function EmptyState({ filtered, onUpload, onClear }: { filtered: boolean; onUpload: () => void; onClear: () => void }) {
  return (
    <div className="pnx-empty-state">
      <svg className="pnx-empty-art" viewBox="0 0 240 150" fill="none" aria-hidden="true">
        <path d="M35 125h170" className="pnx-empty-shelf-line" />
        <path d="M45 125v12h155v-12" className="pnx-empty-shelf-line" />
        <g className="pnx-empty-book pnx-empty-book-one">
          <rect x="62" y="35" width="43" height="88" rx="4" />
          <path d="M72 49h23M72 58h17M72 102h23" />
        </g>
        <g className="pnx-empty-book pnx-empty-book-two">
          <rect x="110" y="24" width="48" height="99" rx="4" />
          <path d="M121 40h26M121 50h18M121 99h26" />
        </g>
        <g className="pnx-empty-book pnx-empty-book-three">
          <rect x="163" y="48" width="32" height="75" rx="4" />
          <path d="M171 60h16M171 68h12" />
        </g>
        <circle cx="199" cy="31" r="16" className="pnx-empty-plus-circle" />
        <path d="M199 23v16M191 31h16" className="pnx-empty-plus" />
      </svg>
      {filtered ? (
        <>
          <h2>这一层暂时没有匹配的文献</h2>
          <p>换个关键词或清除筛选，再看看其他书架。</p>
          <button type="button" className="pnx-button" onClick={onClear}>清除筛选</button>
        </>
      ) : (
        <>
          <h2>从第一篇文献开始</h2>
          <p>拖拽 PDF / Markdown 到页面任意位置，或选择文件上传。<br />支持多选、扫描版 OCR 与 Markdown 即时阅读。</p>
          <button type="button" className="pnx-button pnx-button-primary" onClick={onUpload}><PnxIcon name="upload" />选择文献上传</button>
        </>
      )}
    </div>
  )
}
