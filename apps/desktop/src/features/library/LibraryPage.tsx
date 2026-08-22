// 文库主页：搜索/排序/视图切换 + 项目栏 + 论文卡片网格 + 上传（预判扫描版）
// + 卡片拖拽排序/跨组移动 + PDF 拖到分组（dnd/useLibraryDnd 装配）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { Paper, Project } from '../../api/types'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import ProjectRail from './ProjectRail'
import PaperCard, { type OcrProgress } from './PaperCard'
import EditPaperModal from './EditPaperModal'
import { detectScanned } from './detectScanned'
import { useLibraryDnd, type DndGroup } from './dnd/useLibraryDnd'
import type { GroupKey } from './dnd/types'

type ViewMode = 'all' | 'favorite' | 'recent' | 'project'

const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: 'recent', label: '最近打开' },
  { key: 'favorite', label: '收藏' },
  { key: 'all', label: '全部' },
  { key: 'project', label: '按项目' },
]

export default function LibraryPage() {
  const navigate = useNavigate()
  const [papers, setPapers] = useState<Paper[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [view, setView] = useState<ViewMode>('all')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'created' | 'title' | 'last_opened'>('created')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<Paper | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [deleting, setDeleting] = useState<Paper | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<Record<number, OcrProgress>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  // 首启动向导未完成 → 跳向导
  useEffect(() => {
    if (localStorage.getItem('pl_wizard_done') !== '1') navigate('/wizard', { replace: true })
  }, [navigate])

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300)
    return () => clearTimeout(t)
  }, [qInput])

  // 原始拉取：项目视图（含单项目）强制 sort=manual（P0-1：手动顺序不被系统排序覆盖）
  const fetchPapers = useCallback(async () => {
    try {
      const list = await api.papers({
        q: q || undefined,
        sort: view === 'recent' ? 'last_opened' : view === 'project' ? 'manual' : sort,
        favorite: view === 'favorite' ? true : undefined,
        project_id: selectedProjectId ?? undefined,
      })
      setPapers(list)
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载论文失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [q, sort, view, selectedProjectId])

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
  })
  // 受控刷新入口：持久化在途时抑制（P0-1），结束后补一次收敛
  const refreshPapers = dnd.refresh

  useEffect(() => {
    setLoading(true)
    refreshPapers()
  }, [q, sort, view, selectedProjectId, refreshPapers])
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

  const saveEdit = async (patch: { title: string; authors: string; year: number | null; venue: string; tags: string[]; note: string }) => {
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

  /** groupKey 传入时（project 视图）卡片启用拖拽；其他视图纯展示 */
  const cardList = (list: Paper[], groupKey?: GroupKey) =>
    list.map((p) => (
      <PaperCard
        key={p.id}
        paper={p}
        ocrProgress={ocrProgress[p.id] ?? null}
        onOpen={openPaper}
        onEdit={setEditing}
        onToggleFav={toggleFav}
        onDelete={setDeleting}
        onRetryOcr={retryOcr}
        dragProps={groupKey !== undefined ? dnd.cardDragProps(p.id, groupKey) : undefined}
        isDragging={dnd.draggingId === p.id}
        insertSide={dnd.insertMark?.id === p.id ? dnd.insertMark.side : null}
      />
    ))

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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
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

        <div className="flex rounded-lg bg-bg-soft p-0.5 text-[12.5px]">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              className={`rounded-md px-2.5 py-1 transition-all ${view === t.key ? 'bg-panel text-accent shadow-[var(--shadow-1)] font-medium' : 'text-text-faint hover:text-text-soft'}`}
              onClick={() => {
                setView(t.key)
                if (t.key === 'recent') setSort('last_opened')
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <select
          className="input w-auto! py-1 text-[12.5px]"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          disabled={view === 'project'}
          title={view === 'project' ? '项目视图固定为手动排序' : '排序'}
        >
          <option value="created">按上传时间</option>
          <option value="title">按标题</option>
          <option value="last_opened">按最近打开</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          {selectedProjectId && (
            <span className="badge badge-accent">
              {projects.find((p) => p.id === selectedProjectId)?.name}
              <button className="ml-1" onClick={() => setSelectedProjectId(null)}>
                ✕
              </button>
            </span>
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
          onSelect={setSelectedProjectId}
          onChanged={refreshProjects}
          onPaperDrop={dnd.railPaperDrop}
          onFileDrop={dnd.railFileDrop}
        />

        <div className="min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="spinner spinner-lg" />
            </div>
          ) : papers.length === 0 && view !== 'project' ? (
            <EmptyState hasQuery={!!q || selectedProjectId != null || view === 'favorite'} onUpload={() => fileInput.current?.click()} />
          ) : view === 'project' && selectedProjectId == null ? (
            // 项目多组视图：分组恒渲染（含空项目 + 未分组，D2），分组 = drop target
            <div className="flex flex-col gap-5">
              {grouped.map((g) => {
                const gp = dnd.groupDropProps(g.key)
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
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">{cardList(g.items, g.key)}</div>
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
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                      {cardList(singleGroupItems, selectedProjectId)}
                    </div>
                  )}
                </section>
              )
            })()
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">{cardList(papers)}</div>
          )}
        </div>
      </div>

      <EditPaperModal paper={editing} busy={editBusy} onClose={() => setEditing(null)} onSave={saveEdit} />

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
