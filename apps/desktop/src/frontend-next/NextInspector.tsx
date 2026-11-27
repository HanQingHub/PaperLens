import type { Paper } from '../api/types'
import type { OcrProgress } from './NextPaperCard'
import { toast } from '../features/shared/Toast'
import NextEmblem from './NextEmblem'
import { READ_STATE_LABEL, projectHue, readState } from './terrain'

/** 层析 STRATA · 文库检查器：悬停预览、点击锁定；只读展示 + 复用页面既有动作 */

interface Props {
  paper: Paper | null
  index: number
  total: number
  projectName: string | null
  peek: boolean
  selected: boolean
  onOpen: () => void
  onEdit: () => void
  onToggleFavorite: () => void
  onToggleSelect: () => void
  ocrProgress: OcrProgress | null
  onDelete: () => void
  onRetryOcr: () => void
  onCancelOcr: () => void
}

const OCR_LABEL: Record<Paper['ocr_status'], string> = { none: '无需 OCR', pending: 'OCR 排队', running: 'OCR 识别中', done: 'OCR 完成', failed: 'OCR 失败' }

function fmtDate(value: string | null): string {
  if (!value) return '尚未打开'
  const t = new Date(value)
  if (Number.isNaN(t.getTime())) return '—'
  return t.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function NextInspector({ paper, index, total, projectName, peek, selected, onOpen, onEdit, onToggleFavorite, onToggleSelect, ocrProgress, onDelete, onRetryOcr, onCancelOcr }: Props) {
  if (!paper) {
    return (
      <aside className="pnx-sx-inspector is-empty" aria-label="论文检查器">
        <span className="pnx-eyebrow">INSPECTOR</span>
        <strong>悬停或选中一篇论文</strong>
        <p>地形里每个体块是一篇论文：高度是批注数，顶面是阅读状态，色带是所属项目。双击体块进入阅读台。</p>
        <div className="pnx-sx-insp-legend">
          <span><i data-state="unread" />未读</span>
          <span><i data-state="reading" />在读</span>
          <span><i data-state="read" />读过</span>
        </div>
      </aside>
    )
  }
  const hue = paper.file_type === 'markdown' ? 205 : projectHue(paper.project_id)
  const state = readState(paper)
  const copyDoi = async () => {
    if (!paper.doi) return
    try {
      await navigator.clipboard.writeText(paper.doi)
      toast(`DOI 已复制：${paper.doi}`)
    } catch {
      toast('无法写入剪贴板', 'error')
    }
  }
  return (
    <aside className={`pnx-sx-inspector${peek ? ' is-peek' : ''}`} aria-label="论文检查器" aria-live="polite">
      {peek && <span className="pnx-sx-insp-peek">悬停预览 · 点击锁定</span>}
      <div className="pnx-sx-insp-head">
        <div className="pnx-sx-insp-emblem"><NextEmblem seedText={paper.file_hash} hue={hue} label={`${String(index + 1).padStart(2, '0')}·${paper.year ?? '—'}`} size={104} /></div>
        <div className="pnx-sx-insp-hm">
          <span className="pnx-sx-mono">{String(index + 1).padStart(2, '0')} / {total}</span>
          <span className="pnx-sx-insp-proj"><i style={{ background: `hsl(${hue} 62% 48%)` }} />{projectName ?? '未分组'}</span>
          <span className={`pnx-sx-state is-${state}`}><i />{READ_STATE_LABEL[state]}</span>
          {paper.ocr_status !== 'none' && <span className={`pnx-sx-ocr is-${paper.ocr_status}`}>{OCR_LABEL[paper.ocr_status]}</span>}
        </div>
      </div>
      <h2 className="pnx-sx-insp-title">{paper.title}</h2>
      {paper.authors && <p className="pnx-sx-insp-authors">{paper.authors}</p>}
      <dl className="pnx-sx-insp-meta">
        <div><dt>年份</dt><dd>{paper.year ?? '—'}</dd></div>
        <div><dt>{paper.file_type === 'markdown' ? '行数' : '页数'}</dt><dd>{paper.page_count}</dd></div>
        <div><dt>批注</dt><dd>{paper.annotation_count ?? 0}</dd></div>
        <div className="wide"><dt>期刊 / 会议</dt><dd>{paper.venue || '—'}</dd></div>
        <div className="wide"><dt>DOI</dt><dd className="pnx-sx-insp-doi"><span>{paper.doi || (paper.arxiv_id ? `arXiv:${paper.arxiv_id}` : '—')}</span>{paper.doi && <button type="button" className="pnx-icon-button" title="复制 DOI" onClick={() => void copyDoi()}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 6.5h10v10h-10z" /><path d="M3.5 13.5v-10h10" /></svg></button>}</dd></div>
        <div><dt>打开</dt><dd>{paper.open_count} 次</dd></div>
        <div className="span2"><dt>上次阅读</dt><dd>{fmtDate(paper.last_opened_at)}</dd></div>
      </dl>
      {paper.tags.length > 0 && <div className="pnx-sx-insp-tags">{paper.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      {(paper.ocr_status === 'running' || paper.ocr_status === 'failed' || paper.ocr_status === 'pending') && (
        <div className="pnx-sx-insp-ocr">
          <div className="pnx-sx-insp-ocr-row">
            <span>{paper.ocr_status === 'running' ? `识别 ${ocrProgress?.pages_done ?? 0} / ${ocrProgress?.pages_total ?? paper.page_count} 页` : paper.ocr_status === 'failed' ? 'OCR 识别失败' : 'OCR 排队中'}</span>
            {paper.ocr_status === 'failed' && <button type="button" className="btn btn-ghost" onClick={onRetryOcr}>重试 OCR</button>}
            {paper.ocr_status === 'pending' && <button type="button" className="btn btn-ghost" onClick={onCancelOcr}>取消排队</button>}
          </div>
          {paper.ocr_status === 'running' && (
            <span className="pnx-sx-bar"><i style={{ width: `${Math.round(((ocrProgress?.pages_done ?? 0) / Math.max(1, ocrProgress?.pages_total ?? paper.page_count)) * 100)}%` }} /></span>
          )}
        </div>
      )}
      {paper.note && <div className="pnx-sx-insp-note"><span className="pnx-eyebrow">NOTE · 备注</span><p>{paper.note}</p></div>}
      <div className="pnx-sx-insp-actions">
        <button type="button" className="btn btn-primary" onClick={onOpen}>进入阅读台 <span aria-hidden>↗</span></button>
        <button type="button" className="btn" onClick={onEdit}>编辑</button>
        <button type="button" className={`btn${paper.is_favorite ? ' is-on' : ''}`} aria-pressed={paper.is_favorite} onClick={onToggleFavorite}>{paper.is_favorite ? '★ 已收藏' : '☆ 收藏'}</button>
        <button type="button" className={`btn btn-ghost${selected ? ' is-on' : ''}`} aria-pressed={selected} onClick={onToggleSelect}>{selected ? '✓ 已选' : '＋ 多选'}</button>
        <button type="button" className="btn btn-ghost btn-danger-text" onClick={onDelete}>删除</button>
      </div>
    </aside>
  )
}
