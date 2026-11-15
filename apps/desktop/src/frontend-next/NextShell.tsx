import { useEffect, useState, useSyncExternalStore } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { useReaderTabs } from '../stores/readerTabs'
import { useCompareStore } from '../stores/compareStore'
import { useUi } from '../stores/ui'
import { useUpdater } from '../stores/updater'
import { APP_ICONS, resolveAppIcon } from '../features/appIcon/variants'
import { guardMdNav, pidFromPath, confirmPendingNav, hasPendingNav, subscribeMdGuard, takePendingNav } from '../features/reader/mdDirty'
import { routeOf, tabIdFromPath, type AppTab } from '../features/reader/tabOps'
import { ConfirmModal } from '../features/shared/Modal'
import { IconX } from '../components/shared/Icon'
import NextRightPanel from './NextRightPanel'

const NAV = [
  { to: '/', key: 'library', label: '文库', glyph: '书' },
  { to: '/review', key: 'review', label: '生词复习', glyph: '词' },
  { to: '/settings', key: 'settings', label: '设置', glyph: '设' },
] as const

export default function NextShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const tabs = useReaderTabs((s) => s.tabs)
  const hydratedFor = useReaderTabs((s) => s.hydratedFor)
  const user = useAuth((s) => s.user)
  const rightTab = useUi((s) => s.rightTab)
  const openPanel = useUi((s) => s.openPanel)
  const openReview = useUi((s) => s.openReview)
  const hasUpdate = useUpdater((s) => s.update !== null && s.phase !== 'idle')
  const mdConfirmOpen = useSyncExternalStore(subscribeMdGuard, hasPendingNav)
  const [online, setOnline] = useState(() => navigator.onLine)
  const currentId = tabIdFromPath(location.pathname)
  const reading = location.pathname.startsWith('/reader/')

  useEffect(() => {
    useReaderTabs.getState().ensureFromPath(location.pathname)
  }, [location.pathname, hydratedFor])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const guardedNavigate = (to: string, prepare?: () => void) => {
    const run = () => {
      prepare?.()
      if (to !== location.pathname) navigate(to)
    }
    if (!guardMdNav(run, pidFromPath(location.pathname))) run()
  }

  const closeTab = (tab: AppTab) => {
    const run = () => {
      const next = useReaderTabs.getState().closeTab(tab.id, currentId)
      if (tab.kind === 'reader' && tab.paperId != null && useCompareStore.getState().paperId === tab.paperId) {
        useCompareStore.getState().setPaper(null)
      }
      if (next != null) navigate(next)
    }
    if (!guardMdNav(run, tab.kind === 'reader' ? tab.paperId ?? -1 : -1)) run()
  }

  const openTab = (tab: AppTab) => guardedNavigate(routeOf(tab))

  return (
    <div className={`pnx-root pnx-shell${reading ? ' pnx-shell-reading' : ''}`}>
      <aside className="pnx-nav-rail" aria-label="主导航">
        <NavLink to="/" className="pnx-brand" title="PaperLens 文库" onClick={(e) => { e.preventDefault(); guardedNavigate('/') }}>
          <img src={APP_ICONS[resolveAppIcon()]} alt="" />
        </NavLink>
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              onClick={(e) => {
                e.preventDefault()
                guardedNavigate(item.to, item.key === 'review' ? () => openReview('review') : undefined)
              }}
              className={({ isActive }) => `pnx-nav-button${isActive ? ' is-active' : ''}`}
              title={item.label}
            >
              <span aria-hidden>{item.glyph}</span><small>{item.label}</small>
              {item.key === 'settings' && hasUpdate && <i className="pnx-update-dot" aria-label="有可用更新" />}
            </NavLink>
          ))}
          <button className={`pnx-nav-button${rightTab === 'stats' ? ' is-active' : ''}`} onClick={() => openPanel('stats')} title="阅读统计">
            <span aria-hidden>览</span><small>阅读统计</small>
          </button>
        </nav>
        <div className="pnx-nav-bottom">
          <button className={`pnx-nav-button${rightTab === 'annotations' ? ' is-active' : ''}`} onClick={() => openPanel('annotations')} title="批注"><span aria-hidden>注</span><small>批注</small></button>
          <button className="pnx-avatar" title={`当前账号：${user?.display_name ?? user?.username ?? ''}`} onClick={() => guardedNavigate('/settings')}>{(user?.display_name ?? user?.username ?? '我').slice(0, 1).toUpperCase()}</button>
        </div>
      </aside>

      <div className="pnx-workspace">
        <header className="pnx-topbar" data-tauri-drag-region>
          <div className="pnx-tabs" role="tablist" aria-label="全局页签">
            {tabs.map((tab) => {
              const active = tab.id === currentId
              return (
                <div
                  key={tab.id}
                  className={`pnx-tab${active ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  title={tab.title}
                  onClick={() => openTab(tab)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTab(tab) } }}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab) } }}
                >
                  {tab.kind === 'reader' && <span className="pnx-tab-kind">{tab.fileType === 'markdown' ? 'MD' : 'PDF'}</span>}
                  <span className="pnx-tab-title">{tab.title}</span>
                  <button className="pnx-tab-close" aria-label={`关闭${tab.title}`} title="关闭页签" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); closeTab(tab) }}><IconX size={11} /></button>
                </div>
              )
            })}
          </div>
          {!online && <span className="pnx-offline" role="status">离线模式 · 本地功能可用</span>}
          <span className="pnx-window-space" aria-hidden />
        </header>
        <main className={`pnx-content${reading ? '' : ' pnx-page-enter'}`} key={reading ? 'reader' : location.pathname}>
          <Outlet />
        </main>
      </div>
      {rightTab && <NextRightPanel />}
      <ConfirmModal open={mdConfirmOpen} title="有未保存的更改" confirmText="放弃更改" danger onClose={() => takePendingNav()} onConfirm={() => confirmPendingNav()}>
        Markdown 有未保存的更改，现在离开或切换界面将丢失这些修改。
      </ConfirmModal>
    </div>
  )
}
