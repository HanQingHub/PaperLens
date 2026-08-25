// 生词悬停释义卡：高亮词 hover 浮现 lemma + 中文释义 + 掌握状态
import { useEffect } from 'react'
import { useWords } from '../../stores/words'
import { STAGE_LABELS } from './stageLabels'
import { computeHoverCardPos } from './hoverPos'

export default function WordHoverCard({
  lemma,
  anchorRect,
  onClose,
}: {
  lemma: string
  anchorRect: DOMRect
  onClose: () => void
}) {
  const word = useWords((s) => s.words.find((w) => w.lemma === lemma))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pos = computeHoverCardPos(anchorRect, window.innerWidth, window.innerHeight)
  return (
    <div
      className="pl-word-hover card"
      style={{ left: pos.left, top: pos.top }}
      role="tooltip"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{word?.lemma ?? lemma}</span>
        <span className="badge">{STAGE_LABELS[word?.stage ?? 0]}</span>
      </div>
      <div className="mt-1 max-h-12 overflow-hidden text-[12px] leading-5 text-text-soft">
        {word?.translation || '暂无释义 · 点击查询'}
      </div>
      {word && word.review_count > 0 && (
        <div className="mt-0.5 text-[10.5px] text-text-faint">已复习 {word.review_count} 次</div>
      )}
    </div>
  )
}
