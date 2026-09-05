// 高亮信息操作条：点击高亮块浮现（上方优先，顶部空间不足翻转到下方）。
// 信息行（色点/原文预览/页码）+ 换色五点 + 编辑笔记 + 删除。
// 外部 mousedown / Esc 关闭；随 geom 重渲染自动跟随缩放位置。
import { useEffect, useRef } from 'react'
import { ANNO_COLORS, type ReaderAnnotation } from '../../stores/readerStore'
import { IconPencil, IconTrash } from '../../components/shared/Icon'
import { pdfRectToCss } from '../../shared/coords'

const POPOVER_W = 300
const POPOVER_H = 44

interface Props {
  anno: ReaderAnnotation
  pageIndex: number
  geom: { baseW: number; baseH: number; scale: number }
  /** 舞台可视宽度（水平 clamp 用） */
  containerW: number
  onClose: () => void
  onEdit: () => void
  onColor: (color: string) => void
  onDelete: () => void
}

export default function HighlightPopover({
  anno, pageIndex, geom, containerW, onClose, onEdit, onColor, onDelete,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // 外部 mousedown 关闭（capture：抢在文本选择之前）；Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (!anno.rects.length) return null
  const css = pdfRectToCss(anno.rects[0], geom)
  let top = css.top - POPOVER_H - 6
  let below = false
  if (top < 2) {
    top = css.top + css.height + 6
    below = true
  }
  const left = Math.max(8, Math.min(css.left, containerW - POPOVER_W - 8))
  const preview = (anno.anchorText || '').slice(0, 48)

  return (
    <div
      ref={ref}
      className="glass fade-in absolute z-30 rounded-lg border border-border-strong px-2 py-1.5 shadow-[var(--shadow-2)]"
      style={{ left, top, width: POPOVER_W }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 信息行 */}
      <div className="flex items-center gap-1.5 text-[10.5px] text-text-faint">
        <span className={`h-2 w-2 shrink-0 rounded-full anno-${anno.color}`} />
        <span className="min-w-0 flex-1 truncate" title={anno.anchorText}>
          {preview || '（无原文）'}
        </span>
        <span className="shrink-0">第 {pageIndex + 1} 页</span>
      </div>

      {/* 操作行 */}
      <div className="mt-1 flex items-center gap-1">
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-soft hover:bg-accent-soft hover:text-accent"
          title="编辑笔记"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          <IconPencil size={11} /> 编辑
        </button>
        <div className="mx-0.5 flex items-center gap-1" title="换色">
          {ANNO_COLORS.map((c) => (
            <button
              key={c}
              className={`h-3 w-3 rounded-full border ${c === anno.color ? 'border-accent' : 'border-transparent'} anno-${c} hover:scale-110`}
              title={`换为${c}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onColor(c)
              }}
            />
          ))}
        </div>
        <button
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-danger hover:bg-[rgba(181,72,60,.1)]"
          title="删除高亮"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <IconTrash size={11} /> 删除
        </button>
      </div>
      {below && <div className="sr-only">（浮条位于高亮下方）</div>}
    </div>
  )
}
