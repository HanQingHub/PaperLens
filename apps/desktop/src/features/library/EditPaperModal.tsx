// 编辑论文元数据弹窗：标题/作者/年份/venue/DOI/标签（逗号分隔）/备注 → PATCH
// "从论文识别"：调 extract-meta 仅补空字段（后端保证不覆盖已有值），返回后刷新表单
import { useEffect, useState } from 'react'
import Modal from '../shared/Modal'
import { api } from '../../api/client'
import type { Paper } from '../../api/types'
import { toast } from '../shared/Toast'

interface Props {
  paper: Paper | null
  busy: boolean
  onClose: () => void
  onSave: (patch: { title: string; authors: string; year: number | null; venue: string; doi: string; tags: string[]; note: string }) => void
}

export default function EditPaperModal({ paper, busy, onClose, onSave }: Props) {
  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState('')
  const [year, setYear] = useState('')
  const [venue, setVenue] = useState('')
  const [doi, setDoi] = useState('')
  const [tags, setTags] = useState('')
  const [note, setNote] = useState('')
  const [extracting, setExtracting] = useState(false)

  useEffect(() => {
    if (paper) {
      setTitle(paper.title ?? '')
      setAuthors(paper.authors ?? '')
      setYear(paper.year ? String(paper.year) : '')
      setVenue(paper.venue ?? '')
      setDoi(paper.doi ?? '')
      setTags(paper.tags.join(', '))
      setNote(paper.note ?? '')
    }
  }, [paper])

  const extract = async () => {
    if (!paper || extracting) return
    setExtracting(true)
    try {
      const p = await api.extractMeta(paper.id)
      if (!title.trim() && p.title) setTitle(p.title)
      if (!authors.trim() && p.authors) setAuthors(p.authors)
      if (!year.trim() && p.year) setYear(String(p.year))
      if (!venue.trim() && p.venue) setVenue(p.venue)
      if (!doi.trim() && p.doi) setDoi(p.doi)
      toast('已从论文识别空缺字段', 'ok')
    } catch {
      toast('识别失败（PDF 缺失或不可读）', 'error')
    } finally {
      setExtracting(false)
    }
  }

  const submit = () => {
    const y = year.trim() ? Number(year.trim()) : null
    onSave({
      title: title.trim() || paper?.title || '',
      authors: authors.trim(),
      year: y && !Number.isNaN(y) ? y : null,
      venue: venue.trim(),
      doi: doi.trim(),
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      note: note.trim(),
    })
  }

  return (
    <Modal
      open={!!paper}
      title="编辑元数据"
      width={460}
      onClose={onClose}
      footer={
        <>
          <button className="btn mr-auto" onClick={extract} disabled={busy || extracting} title="仅填充空缺字段，不覆盖已有值">
            {extracting ? '识别中…' : '从论文识别'}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !title.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="pl-field block">
          <span className="pl-field-label mb-1 block text-xs text-text-soft">标题</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="pl-field block">
            <span className="pl-field-label mb-1 block text-xs text-text-soft">作者（分号分隔）</span>
            <input className="input" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Zhang, S.; Li, M." />
          </label>
          <label className="pl-field block">
            <span className="pl-field-label mb-1 block text-xs text-text-soft">年份</span>
            <input className="input" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} placeholder="2025" inputMode="numeric" />
          </label>
        </div>
        <label className="pl-field block">
          <span className="pl-field-label mb-1 block text-xs text-text-soft">期刊 / 会议</span>
          <input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} />
        </label>
        <label className="pl-field block">
          <span className="pl-field-label mb-1 block text-xs text-text-soft">DOI{paper?.arxiv_id ? ` · arXiv:${paper.arxiv_id}` : ''}</span>
          <input className="input" value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.1234/abc.def" />
        </label>
        <label className="pl-field block">
          <span className="pl-field-label mb-1 block text-xs text-text-soft">标签（逗号分隔）</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="attention, NLP" />
        </label>
        <label className="pl-field block">
          <span className="pl-field-label mb-1 block text-xs text-text-soft">备注</span>
          <textarea className="input min-h-[64px] resize-y" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Modal>
  )
}
