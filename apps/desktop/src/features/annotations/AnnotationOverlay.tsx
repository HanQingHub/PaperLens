// 批注渲染层（句子高亮 + 连线锚点 + 已保存卡片 + 编辑/删除闪烁）。
// 独立于 reader 模块（坐标工具走 shared/coords，避免 reader↔annotations 循环依赖）。
import { memo, useEffect, useMemo, useState } from 'react'
import { api, patchAnnotation } from '../../api/client'
import { useReader, parseAnnotation, type ReaderAnnotation } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { cardEdgeX, linkPath, pdfPointToCss, pdfRectToCss, rectCenter } from '../../shared/coords'
import { FLASH_ANIM_MS } from '../../shared/constants'
import { toast } from '../shared/Toast'
import NoteCard from './NoteCard'

// memo：缩放 wheel 期间父组件逐帧重渲染时，批注层（props 不变）整体跳过
const AnnotationOverlay = memo(function AnnotationOverlay({
  pageIndex,
  geom,
  cssW,
  cssH,
  locateId,
}: {
  pageIndex: number
  geom: { baseW: number; baseH: number; scale: number }
  cssW: number
  cssH: number
  locateId: number | null
}) {
  const annotations = useReader((s) => s.annotations)
  const removeAnnotation = useReader((s) => s.removeAnnotation)
  const upsertAnnotation = useReader((s) => s.upsertAnnotation)
  const setLocate = useReader((s) => s.setLocateAnnotation)
  const bumpAnnotations = useReaderBus((s) => s.bumpAnnotations)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const pageAnnos = useMemo(() => annotations.filter((a) => a.page_no === pageIndex + 1), [annotations, pageIndex])
  const wordNotes = useMemo(
    () =>
      pageAnnos.filter(
        (a): a is ReaderAnnotation & { card: NonNullable<ReaderAnnotation['card']> } =>
          a.type === 'word_note' && a.card != null,
      ),
    [pageAnnos],
  )
  const sentences = useMemo(() => pageAnnos.filter((a) => a.type === 'sentence'), [pageAnnos])

  // 定位批注（readerBus → 闪烁 + 滚动已由 ReaderPage 处理页级跳转）
  useEffect(() => {
    if (locateId == null) return
    const target = pageAnnos.find((a) => a.id === locateId)
    if (target) {
      const el = document.querySelector(`[data-anno-id="${locateId}"]`)
      el?.classList.add('flash-anim')
      setTimeout(() => {
        el?.classList.remove('flash-anim')
        setLocate(null)
      }, FLASH_ANIM_MS)
    }
  }, [locateId, pageAnnos, setLocate])

  const saveEditText = async (annoId: number) => {
    setEditingId(null)
    try {
      const raw = await patchAnnotation(annoId, { text: editText })
      upsertAnnotation(parseAnnotation(raw))
      bumpAnnotations()
    } catch {
      toast('批注保存失败', 'error')
    }
  }

  const del = async (annoId: number) => {
    try {
      await api.deleteAnnotation(annoId)
      removeAnnotation(annoId)
      bumpAnnotations()
    } catch {
      toast('批注删除失败', 'error')
    }
  }

  return (
    <>
      {/* 句子五色高亮 */}
      {sentences.map((a) =>
        a.rects.map((r, i) => {
          const css = pdfRectToCss(r, geom)
          return (
            <div
              key={`${a.id}-${i}`}
              data-anno-id={a.id}
              className={`anno-rect anno-${a.color}`}
              style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
              title={a.text || a.anchorText}
              onClick={(e) => {
                e.stopPropagation()
                if (editingId !== a.id) {
                  setEditingId(a.id)
                  setEditText(a.text)
                }
              }}
            />
          )
        }),
      )}

      {/* 高亮编辑小卡片 */}
      {editingId != null && (() => {
        const anno = pageAnnos.find((a) => a.id === editingId)
        if (!anno || !anno.rects.length) return null
        const css = pdfRectToCss(anno.rects[0], geom)
        return (
          <div
            className="note-card fade-in"
            style={{ left: css.left, top: css.top + css.height + 6, width: 230 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-2 py-1">
              <span className="text-[11px] text-text-faint">批注 · 第 {pageIndex + 1} 页</span>
              <button
                className="px-1 text-xs text-text-faint hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  del(anno.id)
                }}
              >
                删除
              </button>
            </div>
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={() => saveEditText(anno.id)}
              placeholder="写点笔记…"
              style={{ height: 64 }}
            />
          </div>
        )
      })()}

      {/* word_note 连线（SVG） */}
      <svg className="anno-links" width={cssW} height={cssH}>
        {wordNotes.map((a) => {
          if (!a.rects.length || !a.card) return null
          const c = rectCenter(a.rects[0])
          const anchor = pdfPointToCss(c.x, c.y, geom)
          const cardCss = pdfPointToCss(a.card.x, a.card.y, geom)
          const cw = a.card.w * geom.scale
          const ex = cardEdgeX(cardCss.x, cw, anchor.x)
          return (
            <path
              key={a.id}
              data-anno-id={a.id}
              d={linkPath(anchor.x, anchor.y, ex, cardCss.y + 20)}
              stroke="var(--accent)"
              strokeWidth={1.2}
              fill="none"
              opacity={0.7}
            />
          )
        })}
      </svg>

      {/* word_note 锚点 */}
      {wordNotes.map((a) => {
        if (!a.rects.length) return null
        const c = rectCenter(a.rects[0])
        const anchor = pdfPointToCss(c.x, c.y, geom)
        return (
          <div
            key={a.id}
            data-anno-id={a.id}
            className="anno-anchor"
            style={{ left: anchor.x - 5, top: anchor.y - 5 }}
            title={a.anchorText}
            onClick={(e) => {
              e.stopPropagation()
              // 锚点 → 卡片闪烁（互跳）
              const card = document.querySelector(`[data-note-card="${a.id}"]`)
              card?.classList.add('flash-anim')
              card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              setTimeout(() => card?.classList.remove('flash-anim'), FLASH_ANIM_MS)
            }}
          />
        )
      })}

      {/* word_note 卡片 */}
      {wordNotes.map((a) => (
        <NoteCard
          key={a.id}
          anno={a}
          geom={geom}
          onDelete={() => del(a.id)}
          onSaved={(raw) => {
            upsertAnnotation(parseAnnotation(raw))
            bumpAnnotations()
          }}
        />
      ))}
    </>
  )
})

export default AnnotationOverlay