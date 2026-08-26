// 论文卡片：标题/作者/年份/标签/收藏/页数/OCR 状态/打开计数 + ⋯ 菜单
import { useEffect, useRef, useState, type CSSProperties, useCallback } from 'react'
import type { Paper } from '../../api/types'
import { prefetchPaper } from '../reader/paperPrefetch'
import type { CardDragProps } from './dnd/types'

// 按文件 hash 生成稳定色相（0-359），用于卡片封面渐变装饰
function hueOf(paper: Paper): number {
  let h = 0
  for (let i = 0; i < paper.file_hash.length; i++) h = (h * 31 + paper.file_hash.charCodeAt(i)) % 360
  return h
}

export interface OcrProgress {
  pages_done: number
  pages_total: number
}

interface Props {
  paper: Paper
  ocrProgress: OcrProgress | null
  onOpen: (p: Paper) => void
  onEdit: (p: Paper) => void
  onToggleFav: (p: Paper) => void
  onDelete: (p: Paper) => void
  onRetryOcr: (p: Paper) => void
  onCancelOcr?: (p: Paper) => void
  /** 拖拽注入（useLibraryDnd.cardDragProps）；未传 = 不可拖拽 */
  dragProps?: CardDragProps
  isDragging?: boolean
  /** 插入指示线：悬停卡片前/后缘 */
  insertSide?: 'before' | 'after' | null
  /** 入场 stagger 动画的延迟序号（列表内位置；仅首次挂载生效） */
  enterIndex?: number
  /** 批量选择态（父级 Ctrl+点击管理） */
  selected?: boolean
  onToggleSelect?: (id: number) => void
}

function OcrBadge({ paper, progress }: { paper: Paper; progress: OcrProgress | null }) {
  if (!paper.is_scanned && paper.ocr_status === 'none') return null
  if (paper.ocr_status === 'done') {
    return (
      <span className="badge" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
        ✓ OCR 已完成
      </span>
    )
  }
  if (paper.ocr_status === 'failed') {
    return (
      <span className="badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
        ✕ OCR 失败
      </span>
    )
  }
  if (paper.ocr_status === 'running') {
    return (
      <span className="badge badge-accent">
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
        {progress ? `OCR ${progress.pages_done}/${progress.pages_total} 页` : 'OCR 进行中'}
      </span>
    )
  }
  if (paper.ocr_status === 'pending') {
    return <span className="badge">扫描版 · OCR 排队中</span>
  }
  return <span className="badge">扫描版</span>
}

export default function PaperCard({
  paper, ocrProgress, onOpen, onEdit, onToggleFav, onDelete, onRetryOcr, onCancelOcr,
  dragProps, isDragging, insertSide, enterIndex, selected, onToggleSelect,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef(0)
  // 入场动画仅首次挂载播一次：freeze 首帧 enterIndex。后续 prop 变化不重播
  // CSS animation（类移除再添加会重播），也不与 FLIP 的 inline transform 冲突
  const [enterIdx] = useState(() => enterIndex)

  const schedulePrefetch = useCallback(() => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => prefetchPaper(paper.id), 200)
  }, [paper.id])
  const cancelPrefetch = useCallback(() => window.clearTimeout(hoverTimer.current), [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  return (
    <div
      data-card
      className={`panel group relative flex cursor-pointer flex-col gap-2 p-3.5 pl-paper-card ${enterIdx != null ? 'pl-card-enter' : ''} ${
        isDragging ? 'pl-card-dragging' : ''
      } ${insertSide ? `pl-dnd-indicator--${insertSide}` : ''}`}
      style={{
        '--pl-hue': String(hueOf(paper)),
        ...(enterIdx != null ? { animationDelay: `${Math.min(enterIdx, 24) * 30}ms` } : {}),
      } as CSSProperties}
      onClick={(e) => {
        if ((e.ctrlKey || e.metaKey) && onToggleSelect) {
          e.preventDefault()
          onToggleSelect(paper.id)
          return
        }
        if (selected) {
          // 已在批量选择态：普通点击也切换选中（避免误开文档）
          onToggleSelect?.(paper.id)
          return
        }
        onOpen(paper)
      }}
      onMouseEnter={schedulePrefetch}
      onMouseLeave={cancelPrefetch}
      {...dragProps}
    >
      <div className="pl-card-glow" aria-hidden />
      {selected && <div className="pointer-events-none absolute inset-0 rounded-[var(--radius-panel,10px)] border-2 border-accent bg-[var(--accent-soft)]/30" aria-hidden />}
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 flex-1 text-[13.5px] font-medium leading-5">{paper.title}</h3>
        <div className="flex shrink-0 items-center gap-0.5">
          {(paper.annotation_count ?? 0) > 0 && (
            <span className="pl-anno-badge" title={`${paper.annotation_count} 条批注`}>
              ✎{paper.annotation_count}
            </span>
          )}
          <button
            className="rounded-md px-1 py-0.5 text-[15px] leading-none transition-transform hover:scale-110"
            style={{ color: paper.is_favorite ? '#e0a63c' : 'var(--text-faint)' }}
            title={paper.is_favorite ? '取消收藏' : '收藏'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFav(paper)
            }}
          >
            {paper.is_favorite ? '★' : '☆'}
          </button>
          <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              className="rounded-md px-1.5 py-0.5 text-sm text-text-faint hover:bg-panel-soft hover:text-accent"
              title="更多操作"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="menu-pop">
                <button onClick={() => { setMenuOpen(false); onEdit(paper) }}>✎ 编辑元数据</button>
                <button onClick={() => { setMenuOpen(false); onToggleFav(paper) }}>
                  {paper.is_favorite ? '☆ 取消收藏' : '★ 收藏'}
                </button>
                <button
                  className="danger"
                  onClick={() => { setMenuOpen(false); onDelete(paper) }}
                >
                  🗑 删除论文
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-faint">
        {paper.authors && <span className="line-clamp-1 max-w-full">{paper.authors.split(/[;,]/)[0].trim()}{paper.authors.includes(';') || paper.authors.includes(',') ? ' 等' : ''}</span>}
        {paper.year && <span>{paper.year}</span>}
        <span>{paper.page_count} 页</span>
        {paper.open_count > 0 && <span>打开 {paper.open_count} 次</span>}
        {paper.venue && <span className="line-clamp-1 italic">{paper.venue}</span>}
        {paper.arxiv_id && <span className="badge">arXiv:{paper.arxiv_id}</span>}
      </div>

      {(paper.tags.length > 0 || paper.is_scanned || paper.ocr_status !== 'none') && (
        <div className="flex flex-wrap items-center gap-1.5">
          {paper.tags.slice(0, 4).map((t) => (
            <span key={t} className="badge">{t}</span>
          ))}
          {paper.tags.length > 4 && <span className="text-[11px] text-text-faint">+{paper.tags.length - 4}</span>}
          <OcrBadge paper={paper} progress={ocrProgress} />
        </div>
      )}

      {paper.ocr_status === 'failed' && (
        <button
          className="btn btn-ghost self-start px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--danger)' }}
          onClick={(e) => {
            e.stopPropagation()
            onRetryOcr(paper)
          }}
        >
          重试 OCR
        </button>
      )}
      {paper.ocr_status === 'pending' && onCancelOcr && (
        <button
          className="btn btn-ghost self-start px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--text-faint)' }}
          onClick={(e) => {
            e.stopPropagation()
            onCancelOcr(paper)
          }}
        >
          取消排队
        </button>
      )}
    </div>
  )
}
