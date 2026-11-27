import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { IconEllipsis, IconPencil, IconStar, IconStarOutline, IconTrash } from '../components/shared/Icon'
import type { Paper } from '../api/types'
import type { CardDragProps } from '../features/library/dnd/types'
import { prefetchPaper } from '../features/reader/paperPrefetch'
import { MenuOverlay, menuPanelClass } from '../features/shared/Dropdown'
import NextEmblem from './NextEmblem'
import { projectHue } from './terrain'

export interface OcrProgress { pages_done: number; pages_total: number }
interface Props {
  paper: Paper
  ocrProgress: OcrProgress | null
  onOpen: (paper: Paper) => void
  onEdit: (paper: Paper) => void
  onToggleFav: (paper: Paper) => void
  onDelete: (paper: Paper) => void
  onRetryOcr: (paper: Paper) => void
  onCancelOcr?: (paper: Paper) => void
  dragProps?: CardDragProps
  isDragging?: boolean
  insertSide?: 'before' | 'after' | null
  enterIndex?: number
  selected?: boolean
  onToggleSelect?: (id: number) => void
  showOpenedAt?: boolean
}

function hueOf(paper: Paper) {
  let hue = 0
  for (let i = 0; i < paper.file_hash.length; i++) hue = (hue * 31 + paper.file_hash.charCodeAt(i)) % 360
  return hue
}

export default function NextPaperCard(props: Props) {
  const { paper, ocrProgress, onOpen, onEdit, onToggleFav, onDelete, onRetryOcr, onCancelOcr, dragProps, isDragging, insertSide, enterIndex, selected, onToggleSelect, showOpenedAt } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const hoverTimer = useRef(0)
  const isMd = paper.file_type === 'markdown'
  const hue = isMd ? 205 : hueOf(paper)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const prefetch = useCallback(() => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => prefetchPaper(paper.id), 200)
  }, [paper.id])
  const open = () => onOpen(paper)
  const ocrLabel = paper.ocr_status === 'done' ? 'OCR 完成' : paper.ocr_status === 'failed' ? 'OCR 失败' : paper.ocr_status === 'running' ? `识别 ${ocrProgress?.pages_done ?? 0}/${ocrProgress?.pages_total ?? paper.page_count}` : paper.ocr_status === 'pending' ? 'OCR 排队' : paper.is_scanned ? '扫描版' : ''

  return (
    <article
      data-card
      // pl-paper-card 仅为满足 useLibraryDnd 的 DOM 契约（closest('.pl-paper-card')），
      // 不沿用旧视觉；新样式通过 .pnx- 自有类完整覆盖。
      className={`pl-paper-card pnx-paper-card ${isMd ? 'is-md' : 'is-pdf'}${selected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}${insertSide ? ` is-insert-${insertSide}` : ''}`}
      style={{ '--pnx-hue': hue, '--pnx-proj-hue': isMd ? 205 : projectHue(paper.project_id), '--pnx-delay': `${Math.min(enterIndex ?? 0, 20) * 28}ms` } as CSSProperties}
      tabIndex={0}
      aria-label={`打开${paper.title}`}
      onClick={(event) => {
        if ((event.ctrlKey || event.metaKey) && onToggleSelect) { event.preventDefault(); onToggleSelect(paper.id); return }
        if (selected) { onToggleSelect?.(paper.id); return }
        open()
      }}
      onKeyDown={(event) => { if (event.key === 'Enter') open(); if ((event.ctrlKey || event.metaKey) && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); onToggleSelect?.(paper.id) } }}
      onMouseEnter={prefetch}
      onMouseLeave={() => window.clearTimeout(hoverTimer.current)}
      {...dragProps}
    >
      <div className="pnx-book-cover">
        <span className="pnx-sx-card-emblem" aria-hidden><NextEmblem seedText={paper.file_hash} hue={isMd ? 205 : projectHue(paper.project_id)} /></span>
        <span className="pnx-book-spine" aria-hidden />
        <span className="pnx-file-type" aria-label={isMd ? 'Markdown 文档' : 'PDF 文献'}>{isMd ? 'MD' : 'PDF'}</span>
        <button className={`pnx-favorite${paper.is_favorite ? ' is-active' : ''}`} title={paper.is_favorite ? '取消收藏' : '收藏'} onClick={(event) => { event.stopPropagation(); onToggleFav(paper) }}>
          {paper.is_favorite ? <IconStar size={15} /> : <IconStarOutline size={15} />}
        </button>
        <div className="pnx-cover-title">{paper.title}</div>
        <span className="pnx-cover-rule" aria-hidden />
        <small>{paper.year ?? (isMd ? '笔记' : '研究文献')}</small>
      </div>
      <div className="pnx-paper-meta">
        <div className="pnx-paper-heading"><h3 title={paper.title}>{paper.title}</h3><div className="pnx-paper-menu" onClick={(event) => event.stopPropagation()}>
          <button className="pnx-icon-button" title="更多操作" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}><IconEllipsis size={15} /></button>
          {menuOpen && <MenuOverlay onClose={() => setMenuOpen(false)} />}
          <div className={menuPanelClass(menuOpen, 'right-0 top-full mt-1 min-w-[140px]')}>
            <button className="pnx-menu-item" onClick={() => { setMenuOpen(false); onEdit(paper) }}><IconPencil size={12} />编辑元数据</button>
            <button className="pnx-menu-item" onClick={() => { setMenuOpen(false); onToggleFav(paper) }}><IconStar size={12} />{paper.is_favorite ? '取消收藏' : '收藏论文'}</button>
            <button className="pnx-menu-item pnx-danger-text" onClick={() => { setMenuOpen(false); onDelete(paper) }}><IconTrash size={12} />删除论文</button>
          </div>
        </div></div>
        <p className="pnx-author">{paper.authors?.split(/[;,]/)[0] || (isMd ? 'Markdown 文档' : '作者待补充')}{paper.year ? ` · ${paper.year}` : ''}</p>
        <div className="pnx-paper-facts"><span>{isMd ? `${paper.page_count} 行` : `${paper.page_count} 页`}</span><span>打开 {paper.open_count} 次</span>{paper.annotation_count ? <span>{paper.annotation_count} 条批注</span> : null}</div>
        {showOpenedAt && paper.last_opened_at && <p className="pnx-last-opened">最近 {new Date(paper.last_opened_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</p>}
        {(paper.tags.length > 0 || ocrLabel) && <div className="pnx-paper-tags">{paper.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}{ocrLabel && <span className={`pnx-ocr pnx-ocr-${paper.ocr_status}`}>{ocrLabel}</span>}</div>}
        {paper.ocr_status === 'failed' && <button className="pnx-text-button pnx-danger-text" onClick={(event) => { event.stopPropagation(); onRetryOcr(paper) }}>重试 OCR</button>}
        {paper.ocr_status === 'pending' && onCancelOcr && <button className="pnx-text-button" onClick={(event) => { event.stopPropagation(); onCancelOcr(paper) }}>取消排队</button>}
      </div>
    </article>
  )
}
