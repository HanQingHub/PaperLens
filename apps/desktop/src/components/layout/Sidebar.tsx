// 左侧栏：单一元素，宽度在 56px ↔ 208px 间平滑过渡，展开时原位推挤（压缩）右侧内容，
// 无任何悬浮覆盖层。折叠态悬停 150ms 后原位展开预览，移出 250ms 后收回；
// 点击底部按钮固定展开/收起（状态持久化）。
import { useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useUi } from '../../stores/ui'
import { useUpdater } from '../../stores/updater'
import { useAuth } from '../../stores/auth'
import { APP_ICONS, resolveAppIcon } from '../../features/appIcon/variants'

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  )
}

const icons = {
  library: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A9 9 0 0 1 3 19.4a1.65 1.65 0 0 0 .33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  review: 'M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42z M7 7h.01',
  chart: 'M18 20V10 M12 20V4 M6 20v-6',
  collapse: 'M15 18l-6-6 6-6',
}

/** 导航内容：标签始终渲染，折叠时由 CSS 渐隐（宽度过渡期间无布局跳变） */
function NavContent({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const { rightTab, openPanel, openReview, lastPaperId, clearLastPaper } = useUi()
  const navigate = useNavigate()
  const location = useLocation()
  const hasUpdate = useUpdater((s) => s.update !== null && s.phase !== 'idle')
  useAuth((s) => s.settings.app_icon)
  const brandIcon = APP_ICONS[resolveAppIcon()]

  const itemCls = (active: boolean) => `pl-nav-item${active ? ' pl-nav-item--active' : ''}`

  // 文库导航：在读（/reader/*）时点击 = 等同「返回文库」（清除记忆回列表）；
  // 在设置/复习等非文库页点击时，若本会话有打开过的论文则恢复阅读，否则进列表。
  const onLibraryClick = (e: React.MouseEvent) => {
    if (location.pathname.startsWith('/reader/')) {
      clearLastPaper()
      return // 默认跳 /，显式退出
    }
    if (location.pathname !== '/' && lastPaperId != null) {
      e.preventDefault()
      navigate(`/reader/${lastPaperId}`)
    }
  }

  return (
    <>
      {/* 品牌区（跟随 app_icon 变体） */}
      <div className="pl-side-brand">
        <img src={brandIcon} alt="" className="h-6 w-6 shrink-0 rounded-md object-contain" />
        <span className="pl-side-label truncate font-serif text-sm font-semibold tracking-wide">PaperLens</span>
      </div>

      {/* 导航 */}
      <nav className="flex flex-col gap-0.5 overflow-hidden p-2">
        <NavLink to="/" onClick={onLibraryClick} className={({ isActive }) => itemCls(isActive || location.pathname.startsWith('/reader/'))} title="文库">
          <span className="pl-nav-icon"><Icon path={icons.library} /></span>
          <span className="pl-side-label">文库</span>
        </NavLink>
        <NavLink to="/review" onClick={() => openReview('review')} className={({ isActive }) => itemCls(isActive || location.pathname === '/review')} title="生词复习">
          <span className="pl-nav-icon"><Icon path={icons.review} /></span>
          <span className="pl-side-label">生词复习</span>
        </NavLink>
        <button onClick={() => openPanel('stats')} className={itemCls(rightTab === 'stats')} title="阅读统计">
          <span className="pl-nav-icon"><Icon path={icons.chart} /></span>
          <span className="pl-side-label">阅读统计</span>
        </button>
        <button onClick={() => navigate('/settings')} className={`${itemCls(false)} relative`} title="设置">
          <span className="pl-nav-icon"><Icon path={icons.settings} /></span>
          <span className="pl-side-label">设置</span>
          {hasUpdate && <span className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full" style={{ background: 'var(--danger)' }} />}
        </button>
      </nav>

      <div className="flex-1" />

      {/* 固定/收起按钮（图标随状态旋转） */}
      <button
        onClick={onToggle}
        className="pl-side-collapse"
        title={pinned ? '收起侧栏' : '固定展开侧栏'}
      >
        <span className="pl-collapse-icon">
          <Icon path={icons.collapse} size={14} />
        </span>
        <span className="pl-side-label">{pinned ? '收起侧栏' : '固定侧栏'}</span>
      </button>
    </>
  )
}

export default function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUi()
  const [peek, setPeek] = useState(false)
  const enterTimer = useRef(0)
  const leaveTimer = useRef(0)

  // 展开 = 固定展开 或 折叠态悬停预览；两种态共用同一元素，宽度平滑过渡
  const expanded = !sidebarCollapsed || peek

  // 悬停预览：进入延迟 150ms（指针扫过不触发），离开延迟 250ms（移向内容区不误收）
  const enter = () => {
    if (!sidebarCollapsed) return
    window.clearTimeout(leaveTimer.current)
    window.clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(() => setPeek(true), 150)
  }
  const leave = () => {
    window.clearTimeout(enterTimer.current)
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setPeek(false), 250)
  }

  return (
    <aside
      className={`pl-sidebar relative z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-panel${expanded ? '' : ' is-collapsed'}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <NavContent pinned={!sidebarCollapsed} onToggle={toggleSidebar} />
    </aside>
  )
}
