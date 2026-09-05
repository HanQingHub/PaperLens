// 生词悬停释义卡：高亮词 hover 浮现 lemma + 中文释义 + 掌握状态
// cardRef 供 PageView 判断指针是否位于卡内（relatedTarget/target 守卫），卡内移动不收卡
import { useEffect, type RefObject } from 'react'
import { useWords } from '../../stores/words'
import { STAGE_LABELS } from './stageLabels'
import { computeHoverCardPos } from './hoverPos'
import { IconSpeaker } from '../../components/shared/Icon'
import { speak } from './speech'

export default function WordHoverCard({
  lemma,
  anchorRect,
  onClose,
  cardRef,
}: {
  lemma: string
  anchorRect: DOMRect
  onClose: () => void
  cardRef?: RefObject<HTMLDivElement | null>
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
      ref={cardRef}
      className="pl-word-hover card"
      style={{ left: pos.left, top: pos.top }}
      role="tooltip"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="u-break min-w-0 flex-1 truncate text-[13px] font-medium" title={word?.lemma ?? lemma}>
          {word?.lemma ?? lemma}
        </span>
        <button
          className="flex shrink-0 items-center text-[11px] text-text-faint transition-all hover:text-accent"
          title="发音"
          onMouseDown={(e) => {
            e.stopPropagation() // 页面层 onMouseDown 会先收卡（hideHover），必须先于 click 拦下
            speak(word?.lemma ?? lemma)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <IconSpeaker size={11} />
        </button>
        <span className="badge">{STAGE_LABELS[word?.stage ?? 0]}</span>
      </div>
      <div className="u-break mt-1 max-h-12 overflow-hidden text-[12px] leading-5 text-text-soft">
        {word?.translation || '暂无释义 · 点击查询'}
      </div>
      {word && word.review_count > 0 && (
        <div className="mt-0.5 text-[10.5px] text-text-faint">已复习 {word.review_count} 次</div>
      )}
    </div>
  )
}
