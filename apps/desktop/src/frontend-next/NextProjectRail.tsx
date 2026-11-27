import { useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { api, ApiError } from '../api/client'
import type { Project } from '../api/types'
import { ConfirmModal } from '../features/shared/Modal'
import { toast } from '../features/shared/Toast'
import { dragKind } from '../features/library/dnd/guard'
import { PROJECT_DRAG_MIME } from '../features/library/dnd/types'
import { projectHue } from './terrain'

interface Props {
  projects: Project[]
  activeProjectId: number | null
  onSelect: (id: number | null) => void
  onChanged: () => void
  onPaperDrop?: (projectId: number) => void
  onFileDrop?: (projectId: number, files: File[]) => void
}

export default function NextProjectRail({
  projects,
  activeProjectId,
  onSelect,
  onChanged,
  onPaperDrop,
  onFileDrop,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const createBusy = useRef(false)
  const renameBusy = useRef(false)
  const reorderBusy = useRef(false)

  const createProject = async () => {
    const name = newName.trim()
    if (!name || createBusy.current) return
    createBusy.current = true
    try {
      await api.createProject(name)
      setNewName('')
      setCreating(false)
      onChanged()
      toast('项目已创建', 'ok')
    } catch (error) {
      toast(error instanceof Error ? error.message : '创建失败', 'error')
    } finally {
      createBusy.current = false
    }
  }

  const renameProject = async () => {
    if (renamingId == null || renameBusy.current) return
    const id = renamingId
    const name = renameValue.trim()
    if (!name) {
      setRenamingId(null)
      return
    }
    if (name === projects.find((project) => project.id === id)?.name) {
      setRenamingId(null)
      return
    }
    renameBusy.current = true
    try {
      await api.updateProject(id, { name })
      setRenamingId(null)
      onChanged()
      toast('项目已重命名', 'ok')
    } catch (error) {
      toast(error instanceof Error ? error.message : '重命名失败', 'error')
    } finally {
      renameBusy.current = false
    }
  }

  const removeProject = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.deleteProject(deleting.id)
      if (activeProjectId === deleting.id) onSelect(null)
      setDeleting(null)
      onChanged()
      toast('项目已删除', 'ok')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast('项目下仍有论文，请先移出或删除其中的论文', 'error')
      } else {
        toast(error instanceof Error ? error.message : '删除失败', 'error')
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  const clearProjectDrag = () => {
    dragIndexRef.current = null
    setDragIndex(null)
    setOverIndex(null)
  }

  const reorderProject = async (targetIndex: number) => {
    const sourceIndex = dragIndexRef.current
    clearProjectDrag()
    if (sourceIndex == null || sourceIndex === targetIndex || reorderBusy.current) return
    const next = [...projects]
    const [moved] = next.splice(sourceIndex, 1)
    if (!moved) return
    next.splice(targetIndex, 0, moved)
    const updates = next
      .map((project, order) => ({ project, order }))
      .filter(({ project, order }) => project.sort_order !== order)
    reorderBusy.current = true
    try {
      for (const { project, order } of updates) {
        await api.updateProject(project.id, { sort_order: order })
      }
      onChanged()
    } catch {
      onChanged()
      toast('排序保存失败', 'error')
    } finally {
      reorderBusy.current = false
    }
  }

  const handleItemDrop = (event: DragEvent, project: Project, index: number) => {
    event.preventDefault()
    event.stopPropagation()
    const types = Array.from(event.dataTransfer.types)
    const kind = dragKind(types)
    if (kind === 'paper') onPaperDrop?.(project.id)
    else if (kind === 'files') onFileDrop?.(project.id, [...event.dataTransfer.files])
    else if (types.includes(PROJECT_DRAG_MIME)) void reorderProject(index)
    else clearProjectDrag()
    setOverIndex(null)
  }

  return (
    <aside
      className="pnx-rail"
      aria-label="项目索引"
      data-group-drop
      onDragOver={(event) => {
        if (
          dragKind(event.dataTransfer.types) === 'files'
          && !(event.target as HTMLElement).closest('.pnx-rail-item')
        ) {
          event.stopPropagation()
        }
      }}
    >
      <div className="pnx-rail-heading">
        <div>
          <span className="pnx-eyebrow">COLLECTIONS</span>
          <h2>项目索引</h2>
        </div>
        <button
          type="button"
          className="pnx-icon-button pnx-rail-add"
          aria-label="新建项目"
          title="新建项目"
          onClick={() => {
            setNewName('')
            setCreating(true)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <p className="pnx-rail-intro">把相近的研究归入同一项目。</p>

      {creating && (
        <form
          className="pnx-project-form"
          onSubmit={(event) => {
            event.preventDefault()
            void createProject()
          }}
        >
          <label className="pnx-sr-only" htmlFor="pnx-new-project">新项目名称</label>
          <input
            id="pnx-new-project"
            className="pnx-input"
            autoFocus
            value={newName}
            maxLength={80}
            placeholder="项目名称，回车确认"
            onChange={(event) => setNewName(event.target.value)}
            onBlur={() => {
              if (newName.trim()) void createProject()
              else setCreating(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setCreating(false)
            }}
          />
        </form>
      )}

      <div className="pnx-rail-list" role="list" aria-label="项目列表">
        {projects.length === 0 && !creating && (
          <div className="pnx-rail-empty">
            <span className="pnx-rail-empty-mark" aria-hidden="true">＋</span>
            <p>还没有项目</p>
            <span>点击上方加号，建立第一个项目。</span>
          </div>
        )}
        {projects.map((project, index) => {
          const active = activeProjectId === project.id
          const renaming = renamingId === project.id
          return (
            <div
              key={project.id}
              role="listitem"
              className={`pnx-rail-item${active ? ' pnx-is-active' : ''}${overIndex === index ? ' pnx-is-over' : ''}${dragIndex === index ? ' pnx-is-dragging' : ''}`}
              draggable={!renaming}
              onDragStart={(event) => {
                dragIndexRef.current = index
                setDragIndex(index)
                event.dataTransfer.setData(PROJECT_DRAG_MIME, String(project.id))
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={clearProjectDrag}
              onDragOver={(event) => {
                const types = Array.from(event.dataTransfer.types)
                if (dragKind(types) !== null || types.includes(PROJECT_DRAG_MIME)) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setOverIndex(index)
                }
              }}
              onDragLeave={() => setOverIndex((current) => current === index ? null : current)}
              onDrop={(event) => handleItemDrop(event, project, index)}
            >
              {renaming ? (
                <form
                  className="pnx-project-form pnx-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void renameProject()
                  }}
                >
                    <label className="pnx-sr-only" htmlFor={`pnx-rename-${project.id}`}>重命名项目</label>
                    <input
                      id={`pnx-rename-${project.id}`}
                      className="pnx-input"
                      autoFocus
                      value={renameValue}
                      maxLength={80}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => void renameProject()}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenamingId(null)
                      }}
                    />
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="pnx-project-select"
                    aria-pressed={active}
                    title={`${project.name} · 点击过滤，双击重命名，拖拽排序`}
                    onClick={() => onSelect(active ? null : project.id)}
                    onDoubleClick={() => {
                      setRenamingId(project.id)
                      setRenameValue(project.name)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') {
                        event.preventDefault()
                        setRenamingId(project.id)
                        setRenameValue(project.name)
                      }
                    }}
                  >
                    <span className="pnx-project-glyph" aria-hidden="true" style={{ '--pnx-proj-hue': projectHue(project.id) } as CSSProperties}>
                      <svg viewBox="0 0 24 24"><path d="M4 7.5h6l2-2h8v13H4z" /></svg>
                    </span>
                    <span className="pnx-project-name">{project.name}</span>
                    <span className="pnx-project-count" aria-label={`${project.paper_count ?? 0} 篇论文`}>
                      {project.paper_count ?? 0}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pnx-icon-button pnx-project-delete"
                    aria-label={`删除项目 ${project.name}`}
                    title="删除项目"
                    onClick={(event) => {
                      event.stopPropagation()
                      setDeleting(project)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="pnx-rail-footnote">
        <span className="pnx-rail-footnote-line" aria-hidden="true" />
        拖拽论文或文件到项目即可归档
      </div>

      <ConfirmModal
        open={!!deleting}
        title="删除项目"
        confirmText="删除项目"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeProject()}
      >
        <div className="pnx-confirm-copy">
          <p>确定删除项目「{deleting?.name}」吗？</p>
          <p>项目下仍有论文时无法删除，此操作不会影响已有论文。</p>
        </div>
      </ConfirmModal>
    </aside>
  )
}
