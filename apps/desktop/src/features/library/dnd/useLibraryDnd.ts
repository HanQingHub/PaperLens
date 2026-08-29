// 文库拖拽聚合 hook：卡片排序/跨组移动 + 文件定向投放 + 页面级兜底
// 状态机（draggingId / overGroupKey / insertMark / dragDepth ref 防抖），
// 乐观更新 + 差异 PATCH（Promise.allSettled）+ 失败回滚（对齐 ProjectRail 范式）。
import { useCallback, useRef, useState, type DragEvent } from 'react'
import { api } from '../../../api/client'
import type { Paper, Project } from '../../../api/types'
import { toast } from '../../shared/Toast'
import { PAPER_DRAG_MIME, type CardDragProps, type GroupKey } from './types'
import { dragKind } from './guard'
import {
  moveAcrossGroups, reorderItems, sortOrderDiff,
  type PaperOrderPatch,
} from './reorder'

export interface DndGroup {
  key: GroupKey
  project: Project | null
  items: Paper[]
}

interface Options {
  papers: Paper[]
  /** 当前视图的分组（project 多组视图=全部项目+未分组；单项目视图=伪组；其他视图=[]） */
  groups: DndGroup[]
  /** 卡片拖拽启用（仅 project 视图且无搜索词，避免过滤态重排破坏全组顺序） */
  enabled: boolean
  /** 页面级兜底上传目标（当前选中项目或文库） */
  pageUploadProjectId: number | null
  onPapersChange: (next: Paper[]) => void
  onUpload: (files: File[], projectId: number | null) => void
  onRefresh: () => Promise<void> | void
  /** 跨组移动成功后的乐观计数回调（movedIds, 目标组）；组内重排不触发 */
  onCountsChange?: (movedIds: number[], toProject: GroupKey) => void
  /** 跨组移动成功后的权威项目计数重拉（读时聚合） */
  onProjectsRefresh?: () => Promise<void> | void
}

export function useLibraryDnd({
  papers, groups, enabled, pageUploadProjectId, onPapersChange, onUpload, onRefresh, onCountsChange, onProjectsRefresh,
}: Options) {
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [overGroupKey, setOverGroupKey] = useState<GroupKey | null>(null)
  const [insertMark, setInsertMark] = useState<{ id: number; side: 'before' | 'after' } | null>(null)
  const [pageDragOver, setPageDragOver] = useState(false)

  // 最新值 ref（事件 handler 内避免闭包过期）
  const papersRef = useRef(papers)
  papersRef.current = papers
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const pageUploadRef = useRef(pageUploadProjectId)
  pageUploadRef.current = pageUploadProjectId
  const onPapersChangeRef = useRef(onPapersChange)
  onPapersChangeRef.current = onPapersChange
  const onUploadRef = useRef(onUpload)
  onUploadRef.current = onUpload
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const onCountsChangeRef = useRef(onCountsChange)
  onCountsChangeRef.current = onCountsChange
  const onProjectsRefreshRef = useRef(onProjectsRefresh)
  onProjectsRefreshRef.current = onProjectsRefresh
  const pendingProjectsRefreshRef = useRef(false)

  // 拖拽状态机 ref（drop 时读取，绕过 React 批处理时序）
  const draggingIdRef = useRef<number | null>(null)
  const insertMarkRef = useRef<{ id: number; side: 'before' | 'after' } | null>(null)
  const pageDepthRef = useRef(0)
  const groupDepthRef = useRef(new Map<GroupKey, number>())
  // 持久化进行中：抑制 refresh（防 OCR 轮询覆盖乐观顺序）+ 抑制新一轮拖起
  const persistingRef = useRef(false)
  const skippedRefreshRef = useRef(false)

  const clearDragState = useCallback(() => {
    draggingIdRef.current = null
    setDraggingId(null)
    setOverGroupKey(null)
    insertMarkRef.current = null
    setInsertMark(null)
    groupDepthRef.current.clear()
  }, [])

  /** 统一受控刷新入口：持久化期间抑制（记为 skipped，结束后补一次收敛） */
  const refresh = useCallback(() => {
    if (persistingRef.current) {
      skippedRefreshRef.current = true
      return
    }
    return onRefreshRef.current()
  }, [])

  const isPersisting = useCallback(() => persistingRef.current, [])

  /** 差异 PATCH：乐观更新已生效，失败回滚为重新拉取权威数据 */
  const persist = useCallback((patches: PaperOrderPatch[]) => {
    if (patches.length === 0) return
    persistingRef.current = true
    Promise.allSettled(
      patches.map((p) => api.updatePaper(p.id, { sort_order: p.sort_order, project_id: p.project_id })),
    ).then((results) => {
      persistingRef.current = false
      const failed = results.some((r) => r.status === 'rejected')
      const skipped = skippedRefreshRef.current
      const needProjectsRefresh = pendingProjectsRefreshRef.current
      skippedRefreshRef.current = false
      pendingProjectsRefreshRef.current = false
      if (failed) {
        toast('排序保存失败', 'error')
        onRefreshRef.current()
        if (needProjectsRefresh) onProjectsRefreshRef.current?.()
      } else if (skipped) {
        onRefreshRef.current()
        if (needProjectsRefresh) onProjectsRefreshRef.current?.()
      } else if (needProjectsRefresh) {
        onProjectsRefreshRef.current?.()
      }
    })
  }, [])

  /** 移动论文到 toGroup 的 insertIndex（组内排序 / 跨组移动统一入口） */
  const movePaper = useCallback(async (paperId: number, toGroup: GroupKey, insertIndex: number) => {
    const groupsNow = groupsRef.current
    const src = groupsNow.find((g) => g.items.some((p) => p.id === paperId))
    let tgt = groupsNow.find((g) => g.key === toGroup)
    if (tgt == null && toGroup != null) {
      // 目标组不在当前视图（单项目视图拖到侧栏其他项目）→ 拉取目标组以定位末尾
      try {
        const items = await api.papers({ project_id: toGroup, sort: 'manual' })
        tgt = { key: toGroup, project: null, items }
      } catch {
        toast('移动失败', 'error')
        return
      }
    }
    if (src == null || tgt == null) return
    const fromIdx = src.items.findIndex((p) => p.id === paperId)
    if (fromIdx === -1) return

    let patches: PaperOrderPatch[]
    let changes: Map<number, Paper>
    if (src.key === tgt.key) {
      // 组内排序：重排为连续 sort_order 后仅 PATCH 变化项
      const nextItems = reorderItems(src.items, fromIdx, insertIndex)
        .map((p, i) => ({ ...p, sort_order: i }))
      patches = sortOrderDiff(nextItems)
      changes = new Map(nextItems.map((p) => [p.id, p]))
    } else {
      // 跨组：源组移除、目标组插入，两组重排；被移卡片 project_id 指向目标组
      const moved = moveAcrossGroups(src.items, tgt.items, paperId, insertIndex)
      const nextTgt = moved.target.map((p) => (p.id === paperId ? { ...p, project_id: toGroup } : p))
      patches = [...sortOrderDiff(moved.source), ...sortOrderDiff(nextTgt, [paperId])]
      changes = new Map([...moved.source, ...nextTgt].map((p) => [p.id, p]))
    }
    if (patches.length === 0) return // 拖回原位：no-op
    // 乐观更新（即时重排），再异步持久化
    onPapersChangeRef.current(papersRef.current.map((p) => changes.get(p.id) ?? p))
    if (src.key !== tgt.key) {
      onCountsChangeRef.current?.([paperId], toGroup)
      pendingProjectsRefreshRef.current = true
    }
    persist(patches)
  }, [persist])

  /** 卡片拖拽 props（注入 PaperCard；groupKey 用于悬停高亮归属） */
  const cardDragProps = useCallback((id: number, groupKey: GroupKey): CardDragProps => ({
    draggable: enabled,
    onDragStart: (e) => {
      if (!enabledRef.current || persistingRef.current) {
        e.preventDefault() // 持久化互斥：在途批次未完成前抑制新一轮拖起
        return
      }
      e.dataTransfer.setData(PAPER_DRAG_MIME, String(id))
      e.dataTransfer.effectAllowed = 'move'
      draggingIdRef.current = id
      setDraggingId(id)
    },
    onDragEnd: () => clearDragState(), // 含 Esc 取消：dragend 必触发
    onDragOver: (e) => {
      if (dragKind(e.dataTransfer.types) !== 'paper') return
      e.preventDefault()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const side: 'before' | 'after' = e.clientX >= rect.left + rect.width / 2 ? 'after' : 'before'
      const mark = { id, side }
      insertMarkRef.current = mark
      setInsertMark(mark)
      setOverGroupKey(groupKey)
    },
  }), [clearDragState, enabled])

  /** 分组投放 props（project 视图的分组 section / 单项目伪组容器） */
  const groupDropProps = useCallback((key: GroupKey) => ({
    isOver: overGroupKey === key,
    onDragEnter: (e: DragEvent) => {
      const kind = dragKind(e.dataTransfer.types)
      if (kind === null) return
      if (kind === 'files') e.stopPropagation() // 阻断冒泡到根容器，防页面级遮罩弹出（§4.3.2）
      groupDepthRef.current.set(key, (groupDepthRef.current.get(key) ?? 0) + 1)
      setOverGroupKey(key)
    },
    onDragOver: (e: DragEvent) => {
      const kind = dragKind(e.dataTransfer.types)
      if (kind === null) return
      e.preventDefault()
      if (kind === 'paper') {
        setOverGroupKey(key)
        // 指针在组内空白（非卡片上）→ 清除插入指示，语义为追加到组尾
        if (!(e.target as HTMLElement).closest?.('.pl-paper-card')) {
          insertMarkRef.current = null
          setInsertMark(null)
        }
      }
    },
    onDragLeave: () => {
      const depth = (groupDepthRef.current.get(key) ?? 1) - 1
      groupDepthRef.current.set(key, Math.max(0, depth))
      if (depth <= 0) setOverGroupKey((cur) => (cur === key ? null : cur))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const kind = dragKind(e.dataTransfer.types)
      const items = groupsRef.current.find((g) => g.key === key)?.items ?? []
      // 插入索引：来自悬停卡片的指示线；无指示（组空白/空组）→ 追加组尾
      const mark = insertMarkRef.current
      const idx = mark ? items.findIndex((p) => p.id === mark.id) : -1
      const insertIndex = idx === -1 ? items.length : idx + (mark!.side === 'after' ? 1 : 0)
      groupDepthRef.current.set(key, 0)
      if (kind === 'files') {
        e.stopPropagation() // 防冒泡到页面级兜底造成双重上传
        clearDragState()
        onUploadRef.current([...e.dataTransfer.files], key)
        return
      }
      let paperId = draggingIdRef.current
      if (paperId == null) {
        const raw = e.dataTransfer.getData(PAPER_DRAG_MIME)
        const n = Number(raw)
        if (raw !== '' && Number.isFinite(n)) paperId = n
      }
      clearDragState()
      if (kind === 'paper' && paperId != null) void movePaper(paperId, key, insertIndex)
    },
  }), [movePaper, clearDragState, overGroupKey])

  /** 页面级兜底（现有整页 drop 行为 1:1 迁移；卡片拖到非分组区域 → no-op 清理） */
  const pageDropProps = useCallback(() => ({
    isOver: pageDragOver,
    onDragEnter: (e: DragEvent) => {
      if (dragKind(e.dataTransfer.types) !== 'files') return
      // 双层保险：目标在分组/侧栏区域内由其接管，不弹页面遮罩
      if ((e.target as HTMLElement).closest?.('[data-group-drop]')) return
      pageDepthRef.current++
      setPageDragOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (dragKind(e.dataTransfer.types) === 'files') e.preventDefault()
    },
    onDragLeave: () => {
      pageDepthRef.current = Math.max(0, pageDepthRef.current - 1)
      if (pageDepthRef.current === 0) setPageDragOver(false)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      pageDepthRef.current = 0
      setPageDragOver(false)
      if (dragKind(e.dataTransfer.types) === 'files') {
        if (e.dataTransfer.files.length) {
          onUploadRef.current([...e.dataTransfer.files], pageUploadRef.current)
        }
      } else {
        clearDragState()
      }
    },
  }), [pageDragOver, clearDragState])

  /** D1：卡片拖到侧栏项目条目 → 移动到该项目末尾 */
  const railPaperDrop = useCallback((projectId: number) => {
    const paperId = draggingIdRef.current
    clearDragState()
    if (paperId == null) return
    const tgt = groupsRef.current.find((g) => g.key === projectId)
    void movePaper(paperId, projectId, tgt ? tgt.items.length : Number.MAX_SAFE_INTEGER)
  }, [movePaper, clearDragState])

  /** D1：文件拖到侧栏项目条目 → 上传到该项目 */
  const railFileDrop = useCallback((projectId: number, files: File[]) => {
    clearDragState()
    onUploadRef.current(files, projectId)
  }, [clearDragState])

  return {
    draggingId,
    overGroupKey,
    insertMark,
    refresh,
    isPersisting,
    cardDragProps,
    groupDropProps,
    pageDropProps,
    railPaperDrop,
    railFileDrop,
  }
}
