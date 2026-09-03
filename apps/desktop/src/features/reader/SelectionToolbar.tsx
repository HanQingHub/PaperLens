// 划词浮动工具条（毛玻璃 + 120ms 淡入）：翻译/释义/入生词/批注/高亮/摘录/复制
// 选区携带 paperId：主窗格选区可批注；对照窗格选区仅翻译/入词/摘录/复制（批注数据
// 归属主窗格文档，B/H 隐藏 + 动作守卫双保险防写错论文）
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useAuth } from '../../stores/auth'
import { useReader, ANNO_COLORS } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { useCompareStore } from '../../stores/compareStore'
import { useWords } from '../../stores/words'
import { createAnnotation } from '../../api/client'
import { parseAnnotation } from '../../stores/readerStore'
import { citationSuffix, wordCount } from './readerUtils'
import { lemmaCandidates, resolveLemma } from './lemma'

/** 工具条动作句柄：ReaderPage 快捷键（T/B/W/H）通过 actionsRef 复用 */
export interface SelectionActions {
  translate: () => void
  dict: () => void
  addWord: () => void
  startLinking: () => void
  highlight: () => void
}

const Btn = ({
  label,
  title,
  onClick,
  danger,
}: {
  label: React.ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) => (
  <button
    title={title}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] transition-all duration-100 ${
      danger ? 'text-danger hover:bg-[rgba(181,72,60,.1)]' : 'text-text-soft hover:bg-accent-soft hover:text-accent'
    }`}
  >
    {label}
  </button>
)

export default function SelectionToolbar({
  onTranslate,
  onToast,
  actionsRef,
}: {
  onTranslate: (mode: 'word' | 'dict') => void
  onToast: (msg: string) => void
  /** ReaderPage 快捷键复用动作句柄（可选） */
  actionsRef?: React.MutableRefObject<SelectionActions | null>
}) {
  const selection = useReader((s) => s.selection)
  const paper = useReader((s) => s.paper)
  const annotations = useReader((s) => s.annotations)
  const upsertAnnotation = useReader((s) => s.upsertAnnotation)
  const setLinking = useReader((s) => s.setLinking)
  const setSelection = useReader((s) => s.setSelection)
  const stageMap = useWords((s) => s.stageMap)
  const bumpAnnotations = useReaderBus((s) => s.bumpAnnotations)
  const { settings } = useAuth()
  const [colorIdx, setColorIdx] = useState(() =>
    Math.max(0, ANNO_COLORS.indexOf((settings.annotation_default_color as (typeof ANNO_COLORS)[number]) ?? 'yellow')),
  )
  const [busy, setBusy] = useState(false)

  // 动作句柄注册（hooks 必须在早退前调用；实现于渲染体后段写入 actionsImpl）
  const actionsImpl = useRef<SelectionActions | null>(null)
  useEffect(() => {
    if (actionsRef) actionsRef.current = actionsImpl.current
    return () => {
      if (actionsRef) actionsRef.current = null
    }
  })

  if (!selection || !paper) return null
  const pageNo = selection.pageIndex + 1
  // 选区来源裁决：对照窗格选区（paperId ≠ 主文档）动作落到对照论文，且不提供批注
  const comparePaper = useCompareStore.getState().paper
  const selPaper = selection.paperId === paper.id ? paper : comparePaper
  const fromCompare = selection.paperId !== paper.id

  // ── 入生词库 ──
  const addWord = async () => {
    const word = selection.text.trim().split(/\s+/)[0] ?? ''
    if (!word) return
    const exists = lemmaCandidates(word).some((c) => stageMap.has(c))
    if (exists) {
      onToast(`「${word}」已在生词库中`)
      return
    }
    setBusy(true)
    try {
      const lemma = (await resolveLemma(word, stageMap)) ?? word.toLowerCase()
      await api.addWord({
        lemma,
        translation: '',
        paper_id: selection.paperId,
        sentence: selection.sentence,
        context: `${selection.prev} ▸ ${selection.next}`.trim(),
      })
      // bump words store 由复习页等监听刷新；本地 bump 高亮
      const words = await api.words({ q: lemma })
      const hit = words.find((w) => w.lemma === lemma)
      if (hit) useWords.getState().bump(hit)
      useReader.getState().bumpHighlight()
      onToast(`已加入生词库：${lemma}`)
    } catch {
      onToast('入词库失败')
    } finally {
      setBusy(false)
    }
  }

  // ── 五色高亮循环（句子批注）──
  const cycleHighlight = async () => {
    if (fromCompare) {
      onToast('对照窗格不支持批注')
      return
    }
    const color = ANNO_COLORS[colorIdx]
    setColorIdx((i) => (i + 1) % ANNO_COLORS.length)
    if (!selection.rects.length) return
    // 同选区已有句子批注 → PATCH 换色；否则新建
    const same = annotations.find(
      (a) => a.type === 'sentence' && a.page_no === pageNo && a.anchorText === selection.text,
    )
    try {
      if (same) {
        const raw = await api.updateAnnotation(same.id, { color })
        upsertAnnotation({ ...parseAnnotationSafe(raw), color })
      } else {
        const raw = await createAnnotation(paper.id, {
          page_no: pageNo,
          type: 'sentence',
          anchor_json: JSON.stringify({ rects: selection.rects, text: selection.text }),
          color,
          text: '',
        })
        upsertAnnotation(parseAnnotationSafe(raw))
      }
      bumpAnnotations()
    } catch {
      onToast('高亮失败')
    }
  }

  // ── 摘录 ──
  const excerpt = async () => {
    try {
      await api.addExcerpt({
        paper_id: selection.paperId,
        page_no: pageNo,
        text: selection.text,
      })
      onToast('已保存摘录')
    } catch {
      onToast('摘录失败')
    }
  }

  // ── 复制附引用（引用后缀按选区来源论文的元数据）──
  const copy = async () => {
    const cite = citationSuffix(selPaper?.authors ?? null, selPaper?.year ?? null, selPaper?.title ?? null, pageNo)
    try {
      await navigator.clipboard.writeText(`${selection.text}\n${cite}`)
      onToast('已复制（附引用）')
    } catch {
      onToast('复制失败')
    }
  }

  // ── 连线批注 ──
  const startLinking = () => {
    if (fromCompare) {
      onToast('对照窗格不支持批注')
      return
    }
    setLinking({
      pageIndex: selection.pageIndex,
      rects: selection.rects.length ? selection.rects : [[0, 0, 10, 10]],
      text: selection.text,
      drag: null,
      cardDraft: null,
    })
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  // 供 ReaderPage 快捷键复用（T/B/W/H）
  actionsImpl.current = {
    translate: () => onTranslate('word'),
    dict: () => onTranslate('dict'),
    addWord,
    startLinking,
    highlight: cycleHighlight,
  }

  const isSentence = wordCount(selection.text) > 6

  return (
    <div
      className="glass fade-in fixed z-40 flex items-center gap-0.5 rounded-lg border border-border-strong px-1 py-0.5 shadow-[var(--shadow-2)]"
      style={{
        left: Math.max(8, selection.toolbarX),
        top: selection.toolbarBelow ? selection.toolbarY : selection.toolbarY,
        transform: 'translateX(-50%)',
      }}
    >
      <Btn label={<b className="font-serif">T</b>} title={isSentence ? '翻译（整句）' : '翻译'} onClick={() => onTranslate('word')} />
      <Btn label="典" title="词典释义（ECDICT）" onClick={() => onTranslate('dict')} />
      <Btn label={<b>W</b>} title="入生词库" onClick={addWord} />
      {!fromCompare && (
        <Btn
          label={<b>B</b>}
          title="连线批注：从锚点拖出曲线到页边落卡"
          onClick={startLinking}
        />
      )}
      {!fromCompare && (
        <Btn
          label={
            <span className="relative flex h-4 w-4 items-center justify-center">
              <span className={`anno-${ANNO_COLORS[colorIdx]} absolute inset-0 rounded-[3px]`} />
              <b className="relative text-[10px]">H</b>
            </span>
          }
          title={`高亮（${ANNO_COLORS[colorIdx]}，循环五色）`}
          onClick={cycleHighlight}
        />
      )}
      <Btn label="❝" title="摘录" onClick={excerpt} />
      <Btn label={CopyIcon} title="复制附引用" onClick={copy} />
      {busy && <span className="px-1 text-[10px] text-text-faint">…</span>}
    </div>
  )
}

const CopyIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

// api.updateAnnotation 返回后端 AnnotationRaw；解析为内部结构
function parseAnnotationSafe(raw: unknown): ReturnType<typeof parseAnnotation> {
  return parseAnnotation(raw as Parameters<typeof parseAnnotation>[0])
}
