// 页面内左列项目栏：列表 + 新建（inline） + 双击重命名 + 删除确认 + 拖拽排序（PATCH sort_order）
import { useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Project } from '../../api/types'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'

interface Props {
  projects: Project[]
  activeProjectId: number | null
  onSelect: (id: number | null) => void
  onChanged: () => void // 增删改后刷新项目列表
}

export default function ProjectRail({ projects, activeProjectId, onSelect, onChanged }: Props) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const dragIndex = useRef<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await api.createProject(name)
      setNewName('')
      setCreating(false)
      onChanged()
      toast('项目已创建', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建失败', 'error')
    }
  }

  const rename = async () => {
    if (renamingId == null) return
    const name = renameVal.trim()
    if (!name) {
      setRenamingId(null)
      return
    }
    try {
      await api.updateProject(renamingId, { name })
      setRenamingId(null)
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : '重命名失败', 'error')
    }
  }

  const remove = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.deleteProject(deleting.id)
      if (activeProjectId === deleting.id) onSelect(null)
      setDeleting(null)
      onChanged()
      toast('项目已删除', 'ok')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast('项目下仍有论文，请先移出或删除其中的论文', 'error')
      } else {
        toast(e instanceof Error ? e.message : '删除失败', 'error')
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  const onDrop = async (index: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    setOverIndex(null)
    if (from == null || from === index) return
    const next = [...projects]
    const [moved] = next.splice(from, 1)
    next.splice(index, 0, moved)
    // 仅对 sort_order 变化的项发 PATCH
    const updates = next
      .map((p, i) => ({ p, order: i }))
      .filter(({ p, order }) => p.sort_order !== order)
    for (const { p, order } of updates) {
      try {
        await api.updateProject(p.id, { sort_order: order })
      } catch {
        onChanged()
        toast('排序保存失败', 'error')
        return
      }
    }
    onChanged()
  }

  return (
    <div className="flex w-48 shrink-0 flex-col gap-2 border-r border-border pr-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-text-soft">项目</span>
        <button
          className="btn btn-ghost px-1.5 py-0.5 text-xs"
          title="新建项目"
          onClick={() => {
            setCreating(true)
            setNewName('')
          }}
        >
          ＋
        </button>
      </div>

      {creating && (
        <input
          className="input"
          autoFocus
          value={newName}
          placeholder="项目名称，回车确认"
          onChange={(e) => setNewName(e.target.value)}
          onBlur={() => {
            if (newName.trim()) create()
            else setCreating(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
            if (e.key === 'Escape') setCreating(false)
          }}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {projects.length === 0 && !creating && (
          <p className="px-2 py-3 text-[11.5px] leading-5 text-text-faint">
            暂无项目。<br />点右上「＋」创建，用项目组织你的论文。
          </p>
        )}
        {projects.map((p, i) => {
          const active = activeProjectId === p.id
          return (
            <div
              key={p.id}
              draggable={renamingId !== p.id}
              onDragStart={() => {
                dragIndex.current = i
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setOverIndex(i)
              }}
              onDragLeave={() => setOverIndex((v) => (v === i ? null : v))}
              onDrop={(e) => {
                e.preventDefault()
                onDrop(i)
              }}
              className={`pl-rail-item group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[13px] ${
                active ? 'pl-rail-item--active bg-accent-soft font-medium text-accent' : 'text-text-soft hover:bg-panel-soft'
              } ${overIndex === i ? 'outline outline-1 outline-dashed outline-accent' : ''}`}
              onClick={() => onSelect(active ? null : p.id)}
              onDoubleClick={() => {
                setRenamingId(p.id)
                setRenameVal(p.name)
              }}
              title="点击过滤 · 双击重命名 · 拖拽排序"
            >
              {renamingId === p.id ? (
                <input
                  className="input py-0.5 text-[12.5px]"
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') rename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.paper_count != null && (
                    <span className="pl-rail-badge" title={`${p.paper_count} 篇论文`}>
                      {p.paper_count}
                    </span>
                  )}
                  <button
                    className="hidden shrink-0 rounded px-1 text-xs text-text-faint hover:text-danger group-hover:block"
                    title="删除项目"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleting(p)
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      <ConfirmModal
        open={!!deleting}
        title="删除项目"
        confirmText="删除"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
      >
        <p className="text-[13px] leading-6">
          确定删除项目「{deleting?.name}」？<br />
          <span className="text-xs text-text-faint">项目下仍有论文时无法删除。</span>
        </p>
      </ConfirmModal>
    </div>
  )
}
