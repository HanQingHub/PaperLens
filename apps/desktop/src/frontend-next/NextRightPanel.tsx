import { IconX } from '../components/shared/Icon'
import { useUi, type RightPanelTab } from '../stores/ui'
import { StatsPanel } from '../features/stats/StatsPanel'
import { AnnotationsPanel } from '../features/annotations/AnnotationsPanel'
import { GlossaryPanel } from '../features/glossary/GlossaryPanel'

const TITLES: Record<Exclude<RightPanelTab, null>, string> = { annotations: '批注与摘录', stats: '阅读统计', glossary: '本文术语表' }
const TAB_LABELS: Record<Exclude<RightPanelTab, null>, string> = { annotations: '批注', stats: '统计', glossary: '术语表' }

export default function NextRightPanel() {
  const { rightTab, openPanel, closePanel } = useUi()
  if (!rightTab) return null
  return (
    <aside className="pnx-right-panel" aria-label={TITLES[rightTab]}>
      <header data-tauri-drag-region>
        <strong>{TITLES[rightTab]}</strong>
        <button className="pnx-icon-button" title="关闭面板" onClick={closePanel}><IconX size={13} /></button>
      </header>
      <div className="pnx-panel-tabs" role="tablist">
        {(['annotations', 'stats', 'glossary'] as const).map((tab) => <button key={tab} role="tab" aria-selected={rightTab === tab} className={rightTab === tab ? 'is-active' : ''} onClick={() => openPanel(tab)}>{TAB_LABELS[tab]}</button>)}
      </div>
      <div className="pnx-right-content">
        {rightTab === 'annotations' && <AnnotationsPanel />}
        {rightTab === 'stats' && <StatsPanel />}
        {rightTab === 'glossary' && <GlossaryPanel />}
      </div>
    </aside>
  )
}
