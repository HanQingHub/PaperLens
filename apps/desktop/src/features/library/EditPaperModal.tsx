// 编辑论文元数据弹窗：标题/作者/年份/venue/标签（逗号分隔）/备注 → PATCH
import { useEffect, useState } from 'react'
import Modal from '../shared/Modal'
import type { Paper } from '../../api/types'

interface Props {
  paper: Paper | null
  busy: boolean
  onClose: () => void
  onSave: (patch: { title: string; authors: string; year: number | null; venue: string; tags: string[]; note: string }) => void
}

export default function EditPaperModal({ paper, busy, onClose, onSave }: Props) {
  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState('')
  const [year, setYear] = useState('')
  const [venue, setVenue] = useState('')
  const [tags, setTags] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (paper) {
      setTitle(paper.title ?? '')
      setAuthors(paper.authors ?? '')
      setYear(paper.year ? String(paper.year) : '')
      setVenue(paper.venue ?? '')
      setTags(paper.tags.join(', '))
      setNote(paper.note ?? '')
    }
  }, [paper])

  const submit = () => {
    const y = year.trim() ? Number(year.trim()) : null
    onSave({
      title: title.trim() || paper?.title || '',
      authors: authors.trim(),
      year: y && !Number.isNaN(y) ? y : null,
      venue: venue.trim(),
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
