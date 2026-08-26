// 文库主页：搜索/排序/视图切换 + 项目栏 + 论文卡片网格 + 上传（预判扫描版）
// + 卡片拖拽排序/跨组移动 + PDF 拖到分组（dnd/useLibraryDnd 装配）
// 浏览态（视图/项目/搜索/排序/展开/滚动）存 stores/libraryUi，跨路由往返保持
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { Paper, Project } from '../../api/types'
import { useAuth } from '../../stores/auth'
import { useLibraryUi } from '../../stores/libraryUi'
import type { LibraryView } from './sort'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import ProjectRail from './ProjectRail'
import PaperCard, { type OcrProgress } from './PaperCard'
import EditPaperModal from './EditPaperModal'
import { detectScanned } from './detectScanned'
import { useLibraryDnd, type DndGroup } from './dnd/useLibraryDnd'
import type { GroupKey } from './dnd/types'
import { resolveSort } from './sort'

const VIEW_TABS: { key: LibraryView; label: string }[] = [
  { key: 'all', label: '全部分类' },
  { key: 'project', label: '项目分类' },
  { key: 'recent', label: '最近打开' },
  { key: 'favorite', label: '收藏' },
]

export default function LibraryPage() {
  const navigate = useNavigate()
  const [papers, setPapers] = useState<Paper[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const view = useLibraryUi((s) => s.view)
  const selectedProjectId = useLibraryUi((s) => s.selectedProjectId)
  const qInput = useLibraryUi((s) => s.qInput)
  const sort = useLibraryUi((s) => s.sort)
  const expanded = useLibraryUi((s) => s.expanded)
  const setView = useLibraryUi((s) => s.setView)
  const setSelectedProjectId = useLibraryUi((s) => s.setSelectedProjectId)
  const setQInput = useLibraryUi((s) => s.setQInput)
  const setSort = useLibraryUi((s) => s.setSort)
  const toggleExpandedKey = useLibraryUi((s) => s.toggleExpanded)
  // q 种子化自 qInput：带搜索词返回文库时首次请求即过滤，避免"空结果→spinner→结果"双重加载
  const [q, setQ] = useState(() => useLibraryUi.getState().qInput.trim())
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<Paper | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [deleting, setDeleting] = useState<Paper | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<Record<number, OcrProgress>>({})
  const [queuePaused, setQueuePaused] = useState(false)
  const [cols, setCols] = useState(4)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const tagMenuRef = useRef<HTMLDivElement>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false)
  const [arxivOpen, setArxivOpen] = useState(false)
  const [arxivInput, setArxivInput] = useState('')
  const [arxivBusy, setArxivBusy] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  // FLIP：cols 变化导致网格重排时，卡片从旧位置平滑滑到新位置（消除挤压瞬移跳变）。
  // 仅作用于位移；visibleItems 切片（展开其余）不参与。动效关闭时直接跳过。
  const flipRectsRef = useRef<Map<Element, DOMRect> | null>(null)
  const captureFlip = useCallback(() => {
    if (document.documentElement.classList.contains('no-motion')) return
    if (!useAuth.getState().settings.animations) return
    const grids = contentRef.current?.querySelectorAll('.library-grid')
    if (!grids?.length) return
    const m = new Map<Element, DOMRect>()
    grids.forEach((g) => g.querySelectorAll('[data-card]').forEach((el) => m.set(el, el.getBoundingClientRect())))
    flipRectsRef.current = m
  }, [])
  // cols 变化渲染完成后：Last - First = 位移，反向 transform 过渡归零
  useLayoutEffect(() => {
    const first = flipRectsRef.current
    if (!first?.size) return
    flipRectsRef.current = null
    const grids = contentRef.current?.querySelectorAll('.library-grid')
    if (!grids?.length) return
    const moving: Element[] = []
    grids.forEach((g) =>
      g.querySelectorAll('[data-card]').forEach((el) => {
        const f = first.get(el)
        if (!f) return
        const l = el.getBoundingClientRect()
        const dx = f.left - l.left
        const dy = f.top - l.top
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          ;(el as HTMLElement).style.transition = 'none'
          ;(el as HTMLElement).style.transform = `translate(${dx}px, ${dy}px)`
          moving.push(el)
        }
      }),
    )
    if (!moving.length) return
    requestAnimationFrame(() => {
      moving.forEach((el) => {
        ;(el as HTMLElement).style.transition = 'transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)'
        ;(el as HTMLElement).style.transform = ''
      })
      window.setTimeout(() => {
        moving.forEach((el) => {
          ;(el as HTMLElement).style.transition = ''
          ;(el as HTMLElement).style.transform = ''
        })
      }, 300)
    })
  }, [cols])
  // 滚动位置：onScroll 只写 ref（零重渲染），卸载时一次性写回 store；
  // 恢复绑定 loading true→false 完成后的首帧，ref 标志保证只恢复一次
  const scrollPos = useRef(useLibraryUi.getState().scrollTop)
  const scrollRestored = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // 首启动向导未完成 → 跳向导
  useEffect(() => {
    if (localStorage.getItem('pl_wizard_done') !== '1') navigate('/wizard', { replace: true })
  }, [navigate])

  // view 的 localStorage 持久化在 store.setView 内完成
  // 列数自适应（内容区宽度 → cols，供分组折叠切片）
  // 防抖 260ms ≥ 侧栏 250ms 动画，确保动画完成后再重排，避免跳变
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    let raf = 0
    let debounceTimer: number | undefined
    let lastCols = cols
    const calc = (w: number) => Math.max(1, Math.floor((w + 12) / (230 + 12)))
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? el.clientWidth)
      const c = calc(w)
      if (c !== lastCols) {
        window.clearTimeout(debounceTimer)
        debounceTimer = window.setTimeout(() => {
          lastCols = c
          // 防抖到期 = 宽度已稳定：捕获旧列数下的卡片位置，供 cols 更新后 FLIP 回放
          captureFlip()
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => setCols(c))
        }, 260)
      }
    })
    ro.observe(el)
    const initW = Math.round(el.clientWidth)
    if (initW) {
      const c = calc(initW)
      if (c !== cols) setCols(c)
    }
    return () => {
      window.clearTimeout(debounceTimer)
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300)
    return () => clearTimeout(t)
  }, [qInput])

  // 离开页面时保存滚动位置（cleanup 里 React 已把 contentRef.current 置 null，从自维护 ref 取值）
  useEffect(
    () => () => {
      useLibraryUi.getState().setScrollTop(scrollPos.current)
    },
    [],
  )

  // 数据就绪后的首帧恢复一次滚动位置（loading=true 时内容塌缩，恢复必须在其结束后）
  useEffect(() => {
    if (loading || scrollRestored.current) return
    scrollRestored.current = true
    requestAnimationFrame(() => {
      const el = contentRef.current
      if (el && scrollPos.current > 0) el.scrollTop = scrollPos.current
    })
  }, [loading])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    scrollPos.current = e.currentTarget.scrollTop
  }, [])

  // 原始拉取：项目视图（含单项目）强制 sort=manual（P0-1：手动顺序不被系统排序覆盖）
  const fetchPapers = useCallback(async () => {
    try {
      const list = await api.papers({
        q: q || undefined,
        sort: resolveSort(view, sort),
        favorite: view === 'favorite' ? true : undefined,
        project_id: selectedProjectId ?? undefined,
        tag: tagFilter ?? undefined,
      })
      setPapers(list)
      // 修剪已不存在的选中项（删除/移动后残留 id 会让批量 PATCH 打到 404）
      setSelected((prev) => {
        const ids = new Set(list.map((p) => p.id))
        const next = new Set([...prev].filter((id) => ids.has(id)))
        return next.size === prev.size ? prev : next
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载论文失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [q, sort, view, selectedProjectId, tagFilter])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.projects())
    } catch {
      /* 静默 */
    }
  }, [])

  // 按项目分组（D2：恒渲染全部项目（含空项目）+ 恒定"未分组"区，空分组始终可投放）
  const grouped = useMemo<DndGroup[]>(() => {
    const byKey = new Map<GroupKey, Paper[]>()
    for (const p of papers) {
      const key: GroupKey = p.project_id ?? null
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(p)
    }
    const itemsOf = (key: GroupKey) =>
      (byKey.get(key) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    const groups: DndGroup[] = projects.map((project) => ({
      key: project.id,
      project,
      items: itemsOf(project.id),
    }))
    groups.push({ key: null, project: null, items: itemsOf(null) })
    return groups
  }, [papers, projects])

  // 单项目视图伪组（客户端按 project_id 过滤，乐观跨组移动后即时消失）
  const singleGroupItems = useMemo(
    () =>
      selectedProjectId == null
        ? []
        : papers
            .filter((p) => p.project_id === selectedProjectId)
            .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    [papers, selectedProjectId],
  )

  const dndGroups = useMemo<DndGroup[]>(() => {
    if (view !== 'project') return []
    if (selectedProjectId == null) return grouped
    return [
      {
        key: selectedProjectId,
        project: projects.find((p) => p.id === selectedProjectId) ?? null,
        items: singleGroupItems,
      },
    ]
  }, [view, selectedProjectId, grouped, projects, singleGroupItems])

  const dnd = useLibraryDnd({
    papers,
    groups: dndGroups,
    enabled: view === 'project' && q === '', // 搜索过滤态禁用重排，避免破坏全组手动顺序
    pageUploadProjectId: selectedProjectId,
    onPapersChange: setPapers,
    onUpload: (files, projectId) => handleFiles(files, projectId),
    onRefresh: fetchPapers,
    onCountsChange: (movedIds, toProject) => {
      // 乐观计数：跨组移动后本地增减 paper_count，免全量重拉闪烁
      setProjects((ps) =>
        ps.map((proj) => {
          let c = proj.paper_count ?? 0
          if (proj.id === toProject) c += movedIds.length
          else c -= movedIds.filter((id) => papers.some((p) => p.id === id && p.project_id === proj.id)).length
          return { ...proj, paper_count: Math.max(0, c) }
        }),
      )
    },
  })
  // 受控刷新入口：持久化在途时抑制（P0-1），结束后补一次收敛
  const refreshPapers = dnd.refresh

  useEffect(() => {
    setLoading(true)
    refreshPapers()
  }, [q, sort, view, selectedProjectId, tagFilter, refreshPapers])
  useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  // OCR 进行中轮询（列表 + 单篇进度）
  useEffect(() => {
    const active = papers.filter((p) => p.ocr_status === 'pending' || p.ocr_status === 'running')
    if (active.length === 0) return
    const t = setInterval(async () => {
      for (const p of active.filter((x) => x.ocr_status === 'running')) {
        try {
          const s = await api.ocrStatus(p.id)
          setOcrProgress((m) => ({ ...m, [p.id]: { pages_done: s.pages_done, pages_total: s.pages_total } }))
        } catch {
          /* 忽略单次失败 */
        }
      }
      refreshPapers()
    }, 2500)
    return () => clearInterval(t)
  }, [papers, refreshPapers])

  // ── 上传 ──
  const handleFiles = async (files: File[], projectId: number | null = selectedProjectId) => {
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length === 0) {
      toast('仅支持 PDF 文件', 'error')
      return
    }
    setUploading(true)
    try {
      for (const f of pdfs) {
        const scanned = await detectScanned(f).catch(() => false)
        const r = await api.uploadPaper(f, projectId, scanned)
        toast(`已上传：${r.paper.title}${scanned ? '（扫描版，已自动进入 OCR 队列）' : ''}`, 'ok')
      }
      refreshPapers()
      refreshProjects()
    } catch (e) {
      toast(e instanceof Error ? e.message : '上传失败', 'error')
    } finally {
      setUploading(false)
    }
  }

  const openPaper = (p: Paper) => navigate(`/reader/${p.id}`)

  const toggleFav = async (p: Paper) => {
    try {
      await api.updatePaper(p.id, { is_favorite: !p.is_favorite })
      setPapers((list) => list.map((x) => (x.id === p.id ? { ...x, is_favorite: !p.is_favorite } : x)))
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error')
    }
  }

  const saveEdit = async (patch: { title: string; authors: string; year: number | null; venue: string; doi: string; tags: string[]; note: string }) => {
    if (!editing) return
    setEditBusy(true)
    try {
      await api.updatePaper(editing.id, patch)
      setEditing(null)
      refreshPapers()
      toast('元数据已保存', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setEditBusy(false)
    }
  }

  const removePaper = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.deletePaper(deleting.id)
      setDeleting(null)
      refreshPapers()
      refreshProjects()
      toast('论文已删除', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const retryOcr = async (p: Paper) => {
    try {
      await api.retryOcr(p.id)
      toast('已重新入 OCR 队列', 'ok')
      refreshPapers()
    } catch (e) {
      toast(e instanceof Error ? e.message : '重试失败', 'error')
    }
  }

  const cancelOcr = async (p: Paper) => {
    try {
      await api.cancelOcr(p.id)
      toast('已取消排队', 'ok')
      refreshPapers()
    } catch (e) {
      toast(e instanceof Error ? e.message : '取消失败', 'error')
    }
  }

  useEffect(() => {
    const hasQueue = papers.some((p) => p.ocr_status === 'pending' || p.ocr_status === 'running')
    if (!hasQueue) return
    let cancelled = false
    const tick = async () => {
      try {
        const q = await api.ocrQueue()
        if (!cancelled) setQueuePaused(q.paused)
      } catch {
        /* 静默 */
      }
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [papers])

  /** 批量操作辅助 */
  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const bulkPatch = async (patch: Record<string, unknown>, okMsg: string) => {
    const ids = [...selected]
    let failed = 0
    for (const id of ids) {
      try {
        await api.updatePaper(id, patch)
      } catch {
        failed++
        break // 任一失败即停（已完成保留），refresh 收敛
      }
    }
    if (failed) toast('部分操作失败，已停止', 'error')
    else toast(okMsg, 'ok')
    setSelected(new Set())
    refreshPapers()
    refreshProjects()
  }
  const bulkDelete = async () => {
    setBulkDeleteBusy(true)
    let failed = 0
    for (const id of [...selected]) {
      try {
        await api.deletePaper(id)
      } catch {
        failed++
        break
      }
    }
    setBulkDeleteBusy(false)
    setBulkDeleting(false)
    if (failed) toast('部分删除失败，已停止', 'error')
    else toast(`已删除 ${selected.size} 篇论文`, 'ok')
    setSelected(new Set())
    refreshPapers()
    refreshProjects()
  }
  const importArxiv = async () => {
    if (arxivBusy) return // 防重入：busy 期间连按 Enter 不发第二次请求
    const id = arxivInput.trim()
    if (!id) return
    setArxivBusy(true)
    try {
      const p = await api.importArxiv(id)
      toast(`已导入：${p.title}`, 'ok')
      setArxivOpen(false)
      setArxivInput('')
      refreshPapers()
      refreshProjects()
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setArxivBusy(false)
    }
  }

  /** 全库标签聚合（独立端点，不受当前 q/tag 筛选影响——否则筛选后下拉互斥死锁） */
  const [allTags, setAllTags] = useState<{ name: string; count: number }[]>([])
  useEffect(() => {
    api.paperTags()
      .then(setAllTags)
      .catch(() => {})
  }, [papers])

  // 标签下拉 OutsideClick/Esc 关闭（ref 含触发按钮 + 面板，避免按钮点开后立即被 outside 误关）
  useEffect(() => {
    if (!tagMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!tagMenuRef.current?.contains(e.target as Node)) setTagMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTagMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [tagMenuOpen])

  /** groupKey 传入时（project 视图）卡片启用拖拽；其他视图纯展示 */
  const cardList = (list: Paper[], groupKey?: GroupKey) =>
    list.map((p, idx) => (
      <PaperCard
        key={p.id}
        paper={p}
        ocrProgress={ocrProgress[p.id] ?? null}
        onOpen={openPaper}
        onEdit={setEditing}
        onToggleFav={toggleFav}
        onDelete={setDeleting}
        onRetryOcr={retryOcr}
        onCancelOcr={cancelOcr}
        dragProps={groupKey !== undefined ? dnd.cardDragProps(p.id, groupKey) : undefined}
        isDragging={dnd.draggingId === p.id}
        insertSide={dnd.insertMark?.id === p.id ? dnd.insertMark.side : null}
        enterIndex={idx}
        selected={selected.has(p.id)}
        onToggleSelect={toggleSelect}
      />
    ))

  const visibleItems = (items: Paper[], key: GroupKey) => {
    if (q !== '' || selectedProjectId != null) return items
    if (expanded.has(key) || items.length <= cols) return items
    return items.slice(0, cols)
  }

  // 列数由 cols 锁定（非 auto-fill）：侧栏宽度过渡期间卡片仅横向压缩不换行，
  // 过渡结束后 setCols 才触发重排，配合 FLIP 平滑滑动（消除挤压瞬移跳变）
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }

  const pd = dnd.pageDropProps()

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={pd.onDragEnter}
      onDragOver={pd.onDragOver}
      onDragLeave={pd.onDragLeave}
      onDrop={pd.onDrop}
    >
      {/* 拖放遮罩（仅文件未命中分组/侧栏时弹出，见 useLibraryDnd.pageDropProps） */}
      {pd.isOver && (
        <div className="pl-drop pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-[var(--accent-soft)] backdrop-blur-[2px]">
          <div className="text-center">
            <div className="pl-drop-icon mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-[var(--shadow-2)]">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
              </svg>
            </div>
            <p className="text-sm font-medium text-accent">松手即上传到{selectedProjectId ? '当前项目' : '文库'}</p>
            <p className="mt-1 text-xs text-text-soft">扫描版 PDF 将自动进入 OCR 队列</p>
          </div>
        </div>
      )}

      {/* 顶区工具条 */}
      {/* 工具条（无边框：顶部区域不留横线，与侧栏竖线不再形成错位交角） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
        <div className="relative w-60">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            className="input pl-7!"
            placeholder="搜索标题 / 作者…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-bg-soft p-0.5 text-[12.5px]">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              className={`rounded-md px-2.5 py-1 transition-all ${view === t.key && (t.key !== 'project' || selectedProjectId == null) ? 'bg-panel text-accent shadow-[var(--shadow-1)] font-medium' : 'text-text-faint hover:text-text-soft'}`}
              onClick={() => {
                if (t.key === 'project') setSelectedProjectId(null)
                setView(t.key)
              }}
            >
              {t.label}
            </button>
          ))}
          <div className="h-4 w-px bg-border" />
          {view === 'project' ? (
            <span className="rounded-md bg-panel px-2.5 py-1 text-accent shadow-sm font-medium">手动排序</span>
          ) : (
            <select
              className="rounded-md bg-transparent px-2.5 py-1 text-xs outline-none"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              title="排序"
            >
              <option value="created">按上传时间</option>
              <option value="title">按标题</option>
              <option value="last_opened">按最近打开</option>
            </select>
          )}
          <div className="h-4 w-px bg-border" />
          <div className="relative" ref={tagMenuRef}>
            <button
              className={`rounded-md px-2.5 py-1 ${tagFilter ? 'bg-panel text-accent shadow-sm font-medium' : 'text-text-faint hover:text-text-soft'}`}
              onClick={() => setTagMenuOpen((v) => !v)}
              aria-expanded={tagMenuOpen}
            >
              {tagFilter ? `#${tagFilter}` : '标签'} ▾
            </button>
            {tagMenuOpen && (
              <div className="absolute right-0 z-20 mt-1 max-h-56 w-48 overflow-auto rounded-lg border bg-panel p-1 shadow">
                <button
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-bg-soft"
                  onClick={() => {
                    setTagFilter(null)
                    setTagMenuOpen(false)
                  }}
                >
                  全部标签
                </button>
                {allTags.map((t) => (
                  <button
                    key={t.name}
                    className="flex w-full justify-between rounded px-2 py-1 text-left text-xs hover:bg-bg-soft"
                    onClick={() => {
                      setTagFilter(t.name)
                      setTagMenuOpen(false)
                    }}
                  >
                    <span>#{t.name}</span>
                    <span className="text-text-faint">{t.count}</span>
                  </button>
                ))}
                {allTags.length === 0 && (
                  <span className="block px-2 py-1 text-xs text-text-faint">暂无标签</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {selectedProjectId && (
            <span className="badge badge-accent">
              {projects.find((p) => p.id === selectedProjectId)?.name}
              <button className="ml-1" onClick={() => { setSelectedProjectId(null); setView('all') }}>
                ✕
              </button>
            </span>
          )}
          {papers.some((p) => p.ocr_status === 'pending' || p.ocr_status === 'running') && (
            <button
              className="btn btn-ghost px-2 py-1 text-xs"
              onClick={async () => {
                try {
                  const r = await api.ocrQueuePause(!queuePaused)
                  setQueuePaused(r.paused)
                  toast(r.paused ? '队列已暂停' : '队列已恢复', 'ok')
                } catch {
                  toast('操作失败', 'error')
                }
              }}
            >
              {queuePaused ? '▶ 恢复队列' : '⏸ 暂停队列'}
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles([...e.target.files])
              e.target.value = ''
            }}
          />
          {arxivOpen ? (
            <div className="relative w-44">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] font-medium text-accent">arXiv</span>
              <input
                className="input h-7 pr-7 pl-11! text-[13px]"
                placeholder="2401.12345"
                value={arxivInput}
                autoFocus
                onChange={(e) => setArxivInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') importArxiv()
                  if (e.key === 'Escape') setArxivOpen(false)
                }}
                onBlur={() => {
                  if (!arxivBusy && !arxivInput) setArxivOpen(false)
                }}
              />
              {arxivBusy && (
                <span className="spinner absolute right-2 top-1/2 -translate-y-1/2" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
              )}
            </div>
          ) : (
            <button className="btn h-7 gap-1 px-2.5 text-xs" onClick={() => setArxivOpen(true)} disabled={uploading} title="通过 arXiv ID 联网导入">
              <span>＋</span> arXiv
            </button>
          )}
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? <span className="spinner" /> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" /></svg>}
            {uploading ? '上传中…' : '选择 PDF'}
          </button>
        </div>
      </div>

      {/* 主区：项目栏 + 内容 */}
      <div className="flex min-h-0 flex-1 gap-4 px-4 py-3">
        <ProjectRail
          projects={projects}
          activeProjectId={selectedProjectId}
          onSelect={(id) => {
            setSelectedProjectId(id)
            // 点项目进入分组/单项目视图（手动排序 + 拖拽）；取消选中回平铺
            setView(id == null ? 'all' : 'project')
          }}
          onChanged={refreshProjects}
          onPaperDrop={dnd.railPaperDrop}
          onFileDrop={dnd.railFileDrop}
        />

        <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="spinner spinner-lg" />
            </div>
          ) : papers.length === 0 && view !== 'project' ? (
            <EmptyState hasQuery={!!q || selectedProjectId != null || view === 'favorite'} onUpload={() => fileInput.current?.click()} />
          ) : view === 'project' && selectedProjectId == null ? (
            // 项目多组视图：分组恒渲染（含空项目 + 未分组，D2），分组 = drop target；默认仅展示一行
            <div className="flex flex-col gap-5">
              {grouped.map((g) => {
                const gp = dnd.groupDropProps(g.key)
                const vis = visibleItems(g.items, g.key)
                const collapsed = !expanded.has(g.key) && g.items.length > cols && q === ''
                return (
                  <section
                    key={g.key ?? '__none'}
                    data-group-drop
                    data-project-id={g.key ?? ''}
                    className={gp.isOver ? 'pl-group-over' : undefined}
                    onDragEnter={gp.onDragEnter}
                    onDragOver={gp.onDragOver}
                    onDragLeave={gp.onDragLeave}
                    onDrop={gp.onDrop}
                  >
                    <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-soft">
                      <span className="inline-block h-3 w-0.5 rounded bg-accent" />
                      {g.project?.name ?? '未分组'}
                      <span className="text-text-faint">{g.items.length} 篇</span>
                    </h2>
                    {g.items.length === 0 ? (
                      <p className="px-1 py-2 text-[11.5px] leading-5 text-text-faint">拖拽 PDF 或卡片到此分组</p>
                    ) : (
                      <>
                        <div className="library-grid grid gap-3" style={gridStyle}>{cardList(vis, g.key)}</div>
                        {g.items.length > cols && q === '' && (
                          <button className="mt-2 text-xs text-accent hover:underline" onClick={() => toggleExpandedKey(g.key)}>
                            {collapsed ? `展开其余 ${g.items.length - cols} 篇` : '收起'}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                )
              })}
            </div>
          ) : view === 'project' ? (
            // 单项目视图：整块网格为伪组 drop 容器（组内排序 + 文件拖入当前项目）
            (() => {
              const gp = dnd.groupDropProps(selectedProjectId)
              return (
                <section
                  data-group-drop
                  data-project-id={selectedProjectId ?? ''}
                  className={gp.isOver ? 'pl-group-over' : undefined}
                  onDragEnter={gp.onDragEnter}
                  onDragOver={gp.onDragOver}
                  onDragLeave={gp.onDragLeave}
                  onDrop={gp.onDrop}
                >
                  {singleGroupItems.length === 0 ? (
                    <p className="px-1 py-2 text-[11.5px] leading-5 text-text-faint">拖拽 PDF 或卡片到此分组</p>
                  ) : (
                    <div className="library-grid grid gap-3" style={gridStyle}>
                      {cardList(singleGroupItems, selectedProjectId)}
                    </div>
                  )}
                </section>
              )
            })()
          ) : (
            <div className="library-grid grid gap-3" style={gridStyle}>{cardList(papers)}</div>
          )}
        </div>
      </div>

      <EditPaperModal paper={editing} busy={editBusy} onClose={() => setEditing(null)} onSave={saveEdit} />

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="glass fade-in fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-strong px-4 py-2 shadow-[var(--shadow-2)]">
          <span className="text-xs font-medium text-accent">已选 {selected.size} 篇</span>
          <span className="h-4 w-px bg-border" />
          <select
            className="input w-auto! py-0.5 text-xs"
            value=""
            onChange={(e) => {
              // "none"=未分组（project_id:null）；其余为项目 id
              const pid = e.target.value === 'none' ? null : e.target.value ? Number(e.target.value) : undefined
              if (pid === undefined) return
              const label = pid === null ? '未分组' : projects.find((x) => x.id === pid)?.name ?? '未分组'
              void bulkPatch({ project_id: pid }, `已移动到「${label}」`)
            }}
          >
            <option value="">移动到项目…</option>
            <option value="none">未分组</option>
            {projects.map((proj) => (
              <option key={proj.id} value={proj.id}>{proj.name}</option>
            ))}
          </select>
          <button className="btn px-2 py-0.5 text-xs" onClick={() => bulkPatch({ is_favorite: true }, '已收藏')}>收藏</button>
          <button className="btn px-2 py-0.5 text-xs text-danger" onClick={() => setBulkDeleting(true)}>删除</button>
          <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => setSelected(new Set())}>取消</button>
        </div>
      )}

      <ConfirmModal
        open={bulkDeleting}
        title="批量删除论文"
        confirmText={`永久删除 ${selected.size} 篇`}
        danger
        busy={bulkDeleteBusy}
        onClose={() => setBulkDeleting(false)}
        onConfirm={bulkDelete}
      >
        <p className="text-[13px] leading-6">
          确定永久删除选中的 <b>{selected.size}</b> 篇论文及其全部批注、生词记录、缓存？<b>不可恢复</b>。
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={!!deleting}
        title="删除论文"
        confirmText="永久删除"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={removePaper}
      >
        <p className="text-[13px] leading-6">
          确定永久删除「{deleting?.title}」？以下数据将<b>一并删除且不可恢复</b>：
        </p>
        <ul className="mt-2 list-inside list-disc text-xs leading-6 text-text-soft">
          <li>批注与卡片笔记</li>
          <li>生词出现记录（生词本体保留）</li>
          <li>本文术语表、翻译缓存</li>
          <li>阅读进度与阅读会话</li>
          <li>摘录、OCR 解析结果</li>
        </ul>
      </ConfirmModal>
    </div>
  )
}

function EmptyState({ hasQuery, onUpload }: { hasQuery: boolean; onUpload: () => void }) {
  return (
    <div className="pl-empty fade-in flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="pl-empty-art">
        <svg width="120" height="96" viewBox="0 0 120 96" fill="none">
        <rect x="18" y="12" width="66" height="78" rx="6" fill="var(--panel-soft)" stroke="var(--border-strong)" />
        <path d="M28 26h34M28 36h46M28 46h40M28 56h46M28 66h26" stroke="var(--border-strong)" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="52" y="6" width="52" height="66" rx="6" fill="var(--panel)" stroke="var(--accent)" strokeWidth="1.6" transform="rotate(6 78 39)" />
        <path d="M64 22l10-1M63 32l24-2M62 42l20-2M61 52l14-1" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" transform="rotate(6 78 39)" />
        <circle cx="98" cy="78" r="14" fill="var(--accent)" opacity="0.15" />
        <path d="M98 71v14M91 78h14" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      </div>
      {hasQuery ? (
        <p className="text-sm text-text-faint">没有符合条件的论文，换个条件试试</p>
      ) : (
        <>
          <div>
            <p className="text-[15px] font-medium">文库还是空的</p>
            <p className="mt-1 text-xs leading-5 text-text-faint">
              拖拽 PDF 到页面任意位置，或点击下方按钮上传
              <br />
              支持多选 · 扫描版将自动 OCR
            </p>
          </div>
          <button className="btn btn-primary" onClick={onUpload}>
            选择 PDF 上传
          </button>
        </>
      )}
    </div>
  )
}
