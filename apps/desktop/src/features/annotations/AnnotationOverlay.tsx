// 批注渲染层（句子高亮 + 连线锚点 + 已保存卡片 + 信息操作条 + 编辑/删除闪烁）。
// 独立于 reader 模块（坐标工具走 shared/coords，避免 reader↔annotations 循环依赖）。
import { memo, useEffect, useMemo, useState } from 'react'
import { api, patchAnnotation } from '../../api/client'
import { useReader, parseAnnotation, type ReaderAnnotation } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { cardEdgeX, linkPath, mergePdfRects, pdfPointToCss, pdfRectToCss, rectCenter } from '../../shared/coords'
import { fitRectEdgesToInk, fitRectVertical, type InkMap, type LineBand } from '../../shared/highlightGeometry'
import { FLASH_ANIM_MS } from '../../shared/constants'
import { toast } from '../shared/Toast'
import NoteCard from './NoteCard'
import HighlightPopover from './HighlightPopover'

// memo：缩放 wheel 期间父组件逐帧重渲染时，批注层（props 不变）整体跳过
const AnnotationOverlay = memo(function AnnotationOverlay({
  pageIndex,
  geom,
  cssW,
  cssH,
  lineBands,
  ink,
  inkScale,
  locateId,
  popoverId,
  onClosePopover,
}: {
  pageIndex: number
  geom: { baseW: number; baseH: number; scale: number }
  cssW: number
  cssH: number
  /** 行盒 bands（舞台坐标）：句子高亮行渲染前钳制，与词带/选区等高 */
  lineBands: LineBand[]
  /** 页面 canvas 墨迹：矩形左右缘吸附到真实字形边界（落库几何含文本层
   * advance 漂移，半字切割根因）；OCR 页/超大 canvas 无墨迹 → 跳过 */
  ink?: InkMap
  /** canvas 像素 / 舞台 px */
  inkScale?: number
  locateId: number | null
  /** 当前打开信息条的 sentence 批注 id（PageView 命中判定写入） */
  popoverId: number | null
  onClosePopover: () => void
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
      onClosePopover()
    } catch {
      toast('批注删除失败', 'error')
    }
  }

  const setColor = async (annoId: number, color: string) => {
    try {
      const raw = await patchAnnotation(annoId, { color })
      upsertAnnotation(parseAnnotation(raw))
      bumpAnnotations()
    } catch {
      toast('换色失败', 'error')
    }
  }

  return (
    <>
      {/* 句子五色高亮（点击命中判定在 PageView stage 层，rect 不再接收事件）。
          渲染前按行合并（吸收历史数据中的同行碎片/重叠/双层 rect），再钳制到
          行盒 band（新旧数据行高归一，与词带/选区等高）；多行矩形 → 单个
          clipPath → 裁剪单个填色 rect：重叠处单次填充，无半透明 α 叠加暗条
          与竖缝（pdf.js 官方 highlight editor 同款方案） */}
      {sentences.map((a) => {
        const rects = mergePdfRects(a.rects).map((r) => {
          // 垂直=块内字符墨迹（行带框架内）；水平缘吸附真实字形（落库几何含漂移）
          const c = fitRectVertical(ink, pdfRectToCss(r, geom), lineBands, inkScale ?? 0)
          return ink && inkScale ? fitRectEdgesToInk(ink, c, c.height, inkScale) : c
        })
        if (!rects.length) return null
        const clipId = `anno-clip-${a.id}`
        return (
          <svg
            key={a.id}
            data-anno-id={a.id}
            className="anno-rect-svg"
            width={cssW}
            height={cssH}
          >
            <title>{a.text || a.anchorText}</title>
            <defs>
              <clipPath id={clipId}>
                {rects.map((c, i) => (
                  <rect key={i} x={c.left} y={c.top} width={c.width} height={c.height} rx={2} />
                ))}
              </clipPath>
            </defs>
            <rect
              x={0}
              y={0}
              width={cssW}
              height={cssH}
              className={`anno-rect anno-${a.color}`}
              clipPath={`url(#${clipId})`}
            />
          </svg>
        )
      })}

      {/* 高亮信息操作条（点击高亮块浮现） */}
      {popoverId != null && (() => {
        const anno = pageAnnos.find((a) => a.id === popoverId && a.type === 'sentence')
        if (!anno) return null
        return (
          <HighlightPopover
            anno={anno}
            pageIndex={pageIndex}
            geom={geom}
            containerW={cssW}
            onClose={onClosePopover}
            onEdit={() => {
              setEditingId(anno.id)
              setEditText(anno.text)
              onClosePopover()
            }}
            onColor={(c) => setColor(anno.id, c)}
            onDelete={() => del(anno.id)}
          />
        )
      })()}

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