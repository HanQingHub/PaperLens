// 右侧滑出面板骨架：Tab 切换 + 内容由 features 提供
import { useUi, type RightPanelTab } from '../../stores/ui'
import { StatsPanel } from '../../features/stats/StatsPanel'
import { AnnotationsPanel } from '../../features/annotations/AnnotationsPanel'
import { GlossaryPanel } from '../../features/glossary/GlossaryPanel'
import WordsPanel from '../../features/words/WordsPanel'

const TITLES: Record<Exclude<RightPanelTab, null>, string> = {
  annotations: '批注',
  stats: '统计',
  glossary: '术语表',
  words: '生词库',
}

export default function RightPanel() {
  const { rightTab, closePanel } = useUi()
  if (!rightTab) return null

  return (
    <aside
      className="slide-in z-35 flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-panel shadow-[var(--shadow-2)]"
    >
      {/* pr-20：为右上角常驻窗口控制小部件（—/✕）预留空间，避免与面板关闭按钮重叠 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-4 pr-20">
        <span className="text-sm font-medium">{TITLES[rightTab]}</span>
        <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={closePanel}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rightTab === 'annotations' && <AnnotationsPanel />}
        {rightTab === 'stats' && <StatsPanel />}
        {rightTab === 'glossary' && <GlossaryPanel />}
        {rightTab === 'words' && <WordsPanel />}
      </div>
    </aside>
  )
}
