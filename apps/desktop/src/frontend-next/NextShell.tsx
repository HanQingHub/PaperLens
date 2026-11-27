import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
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
import { useStrataDocument } from './strataDocument'

type SceneKey = 'library' | 'reader' | 'review' | 'settings'

const SCENES: { key: SceneKey; num: string; label: string }[] = [
  { key: 'library', num: '01', label: '文库' },
  { key: 'reader', num: '02', label: '阅读台' },
  { key: 'review', num: '03', label: '复习' },
  { key: 'settings', num: '04', label: '设置' },
]

function sceneOf(pathname: string): SceneKey | null {
  if (pathname === '/') return 'library'
  if (pathname.startsWith('/reader/')) return 'reader'
  if (pathname.startsWith('/review')) return 'review'
  if (pathname.startsWith('/settings')) return 'settings'
  return null
}

export default function NextShell() {
  useStrataDocument()
  const location = useLocation()
  const navigate = useNavigate()
  const tabs = useReaderTabs((s) => s.tabs)
  const hydratedFor = useReaderTabs((s) => s.hydratedFor)
  const user = useAuth((s) => s.user)
  const fontScale = useAuth((s) => s.settings.font_scale)
  const rightTab = useUi((s) => s.rightTab)
  const openPanel = useUi((s) => s.openPanel)
  const openReview = useUi((s) => s.openReview)
  const hasUpdate = useUpdater((s) => s.update !== null && s.phase !== 'idle')
  const mdConfirmOpen = useSyncExternalStore(subscribeMdGuard, hasPendingNav)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [inkStyle, setInkStyle] = useState<CSSProperties>({ width: 0 })
  const scenesRef = useRef<HTMLElement>(null)
  const currentId = tabIdFromPath(location.pathname)
  const reading = location.pathname.startsWith('/reader/')
  const scene = sceneOf(location.pathname)
  const lastReaderTab = [...tabs].reverse().find((tab) => tab.kind === 'reader')
  const readerTarget = reading ? location.pathname : lastReaderTab ? routeOf(lastReaderTab) : null

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

  // 墨条：量取当前场景按钮的位置；路由、字号、窗口尺寸变化时重测
  useLayoutEffect(() => {
    const measure = () => {
      const active = scenesRef.current?.querySelector<HTMLElement>('.pnx-sx-scene.is-active')
      setInkStyle(active ? { transform: `translateX(${active.offsetLeft}px)`, width: active.offsetWidth } : { width: 0, opacity: 0 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [scene, fontScale])

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

  const goScene = (key: SceneKey) => {
    if (key === 'library') guardedNavigate('/')
    else if (key === 'reader') { if (readerTarget) guardedNavigate(readerTarget) }
    else if (key === 'review') guardedNavigate('/review', () => openReview('review'))
    else guardedNavigate('/settings')
  }

  const userName = user?.display_name ?? user?.username ?? ''

  return (
    <div className={`pnx-root pnx-shell pnx-sx-shell${reading ? ' pnx-shell-reading' : ''}`}>
      <div className="pnx-workspace">
        <header className="pnx-topbar pnx-sx-topbar" data-tauri-drag-region>
          <button type="button" className="pnx-sx-brand" title="层析 · 返回文库" onClick={() => goScene('library')}>
            <img src={APP_ICONS[resolveAppIcon()]} alt="" />
            <b>层析</b>
            <small>STRATA<br />PAPERLENS</small>
          </button>
          <nav className="pnx-sx-scenes" aria-label="主导航" ref={scenesRef}>
            {SCENES.map((item) => {
              const active = scene === item.key
              const disabled = item.key === 'reader' && !readerTarget
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`pnx-sx-scene${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  disabled={disabled}
                  title={disabled ? '暂无打开的论文' : item.label}
                  onClick={() => goScene(item.key)}
                >
                  <span className="pnx-sx-scene-num">{item.num}</span>
                  <span className="pnx-sx-scene-label">{item.label}</span>
                  {item.key === 'settings' && hasUpdate && <i className="pnx-update-dot" aria-label="有可用更新" />}
                </button>
              )
            })}
            <span className="pnx-sx-ink" aria-hidden style={inkStyle} />
          </nav>
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
          <span className="pnx-sx-drag" data-tauri-drag-region aria-hidden />
          {!online && <span className="pnx-offline" role="status">离线 · 本地</span>}
          <div className="pnx-sx-tools">
            <button type="button" className={`pnx-icon-button${rightTab === 'stats' ? ' is-active' : ''}`} aria-pressed={rightTab === 'stats'} onClick={() => openPanel('stats')} title="阅读统计">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 17.5h15M5 14.5v-5M9 14.5V4.5M13 14.5v-7M17 14.5V11" /></svg>
            </button>
            <button type="button" className={`pnx-icon-button${rightTab === 'annotations' ? ' is-active' : ''}`} aria-pressed={rightTab === 'annotations'} onClick={() => openPanel('annotations')} title="批注">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 3.5h13v9l-4 4h-9z" /><path d="M12.5 16.5v-4h4M6.5 7.5h7M6.5 10.5h4" /></svg>
            </button>
            <button type="button" className="pnx-avatar" title={`当前账号：${userName}`} onClick={() => guardedNavigate('/settings')}>{(userName || '我').slice(0, 1).toUpperCase()}</button>
          </div>
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
