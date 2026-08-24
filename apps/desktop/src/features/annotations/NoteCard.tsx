// 连线批注卡片：可拖动 / 右下缩放 / 编辑（失焦保存）/ 删除；点击锚点互跳
import { useEffect, useRef, useState } from 'react'
import { createAnnotation, patchAnnotation, type AnnotationRaw } from '../../api/client'
import { useReader, parseAnnotation, type ReaderAnnotation, type PdfRect } from '../../stores/readerStore'
import { cssPointToPdf, pdfPointToCss, type PageGeom } from '../../shared/coords'
import { FLASH_ANIM_MS } from '../../shared/constants'
import { toast } from '../shared/Toast'

interface NoteCardProps {
  anno: ReaderAnnotation & { card: NonNullable<ReaderAnnotation['card']> }
  geom: PageGeom
  onDelete: () => void
  onSaved: (raw: AnnotationRaw) => void
}

export default function NoteCard({ anno, geom, onDelete, onSaved }: NoteCardProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(anno.text)
  const [card, setCard] = useState(anno.card)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCard(anno.card)
    setText(anno.text)
  }, [anno.card, anno.text, anno.id])

  const cssPos = pdfPointToCss(card.x, card.y, geom)
  const cssW = card.w * geom.scale
  const cssH = card.h * geom.scale

  const saveCard = (next: { x: number; y: number; w: number; h: number }) => {
    setCard(next)
    patchAnnotation(anno.id, { card_json: JSON.stringify(next) })
      .then(onSaved)
      .catch(() => toast('批注保存失败', 'error'))
  }

  const saveText = () => {
    setEditing(false)
    if (text !== anno.text) {
      patchAnnotation(anno.id, { text }).then(onSaved).catch(() => toast('批注保存失败', 'error'))
    }
  }

  // 卡片拖动（header 手柄）
  const startDrag = (e: React.MouseEvent) => {
    if (editing) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const origin = { ...card }
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / geom.scale
      const dy = (ev.clientY - startY) / geom.scale
      setCard({ ...origin, x: origin.x + dx, y: origin.y - dy })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      saveCard(cardRef.current ? getCardFromDom(cardRef.current, geom) : card)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 右下角缩放
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const origin = { ...card }
    const onMove = (ev: MouseEvent) => {
      const dw = (ev.clientX - startX) / geom.scale
      const dh = (ev.clientY - startY) / geom.scale
      setCard({
        ...origin,
        w: Math.max(80 / geom.scale, origin.w + dw),
        h: Math.max(60 / geom.scale, origin.h + dh),
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      saveCard(cardRef.current ? getCardFromDom(cardRef.current, geom) : card)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={cardRef}
      data-note-card={anno.id}
      className="note-card"
      style={{ left: cssPos.x, top: cssPos.y, width: cssW, height: cssH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex h-6 cursor-move items-center justify-between border-b border-border px-2"
        onMouseDown={startDrag}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="text-[10px] font-medium text-accent">笔记</span>
        <span className="flex items-center gap-1">
          <button
            className="px-0.5 text-[11px] text-text-faint hover:text-accent"
            title="编辑"
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            ✎
          </button>
          <button
            className="px-0.5 text-[11px] text-text-faint hover:text-danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={saveText}
          onKeyDown={(e) => {
            if (e.key === 'Escape') saveText()
          }}
        />
      ) : (
        <div
          className="flex-1 cursor-pointer overflow-hidden whitespace-pre-wrap px-2.5 py-1.5 text-xs leading-relaxed"
          onDoubleClick={() => setEditing(true)}
          onClick={(e) => {
            e.stopPropagation()
            // 卡片 → 锚点互跳闪烁
            const anchor = document.querySelector(`[data-anno-id="${anno.id}"].anno-anchor`)
            anchor?.classList.add('flash-anim')
            setTimeout(() => anchor?.classList.remove('flash-anim'), FLASH_ANIM_MS)
          }}
          title="双击编辑"
        >
          {text || <span className="text-text-faint">（空笔记，双击编辑）</span>}
        </div>
      )}
      <div className="resize-handle" onMouseDown={startResize}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="4.5" cy="8" r="1.4" />
          <circle cx="8" cy="4.5" r="1.4" />
        </svg>
      </div>
    </div>
  )
}

/** 从 DOM 元素当前几何反算 PDF 空间卡片（拖动结束时保存） */
function getCardFromDom(el: HTMLElement, geom: PageGeom) {
  const left = parseFloat(el.style.left)
  const top = parseFloat(el.style.top)
  const w = parseFloat(el.style.width)
  const h = parseFloat(el.style.height)
  const p1 = cssPointToPdf(left, top, geom)
  const p2 = cssPointToPdf(left + w, top + h, geom)
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.max(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  }
}

// ── 新建草稿卡（连线松手后出现，textarea 失焦保存）──────────
export function DraftCard({
  pageIndex,
  geom,
  anchorRects,
  card,
}: {
  pageIndex: number
  geom: PageGeom
  anchorRects: PdfRect[]
  card: { x: number; y: number; w: number; h: number }
}) {
  const paperId = useReader((s) => s.paper?.id)
  const setLinking = useReader((s) => s.setLinking)
  const upsertAnnotation = useReader((s) => s.upsertAnnotation)
  const linkingText = useReader((s) => s.linking?.text ?? '')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const cssPos = pdfPointToCss(card.x, card.y, geom)

  const save = async () => {
    if (saving || !paperId) return
    if (!text.trim()) {
      // 空草稿失焦视同取消，不产生空批注
      setLinking(null)
      return
    }
    setSaving(true)
    try {
      const raw = await createAnnotation(paperId, {
        page_no: pageIndex + 1,
        type: 'word_note',
        anchor_json: JSON.stringify({ rects: anchorRects, text: linkingText }),
        card_json: JSON.stringify(card),
        text,
      })
      upsertAnnotation(parseAnnotation(raw))
      setLinking(null)
    } catch {
      setSaving(false) // 失败留在草稿态可重试
    }
  }

  return (
    <div
      className="note-card"
      style={{ left: cssPos.x, top: cssPos.y, width: card.w * geom.scale, height: card.h * geom.scale }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex h-6 items-center justify-between border-b border-border px-2">
        <span className="text-[10px] font-medium text-accent">新笔记 · 失焦保存</span>
        <button
          className="px-0.5 text-[11px] text-text-faint hover:text-danger"
          title="取消 (Esc)"
          // mousedown 阶段阻止焦点转移：textarea 不失焦 → blur-save 不会抢先发出创建请求
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setLinking(null)}
        >
          ✕
        </button>
      </div>
      <textarea
        autoFocus
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setLinking(null)
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
        }}
        placeholder="写笔记 / 贴译文…（Ctrl+Enter 保存，Esc 取消）"
      />
    </div>
  )
}