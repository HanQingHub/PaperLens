import { useEffect, useMemo } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAuth, applyTheme } from './stores/auth'
import { useUi } from './stores/ui'
import { useReaderTabs } from './stores/readerTabs'
import { useCompareStore } from './stores/compareStore'
import { useExternalOpen } from './stores/externalOpen'
import { api, setUnauthorizedHandler } from './api/client'
import { toast } from './features/shared/Toast'
import AppShell from './components/layout/AppShell'
import WindowControls from './components/layout/WindowControls'
import Threads from './components/shared/Threads'
import StrokeText from './components/shared/StrokeText'
import { APP_ICONS, resolveAppIcon } from './features/appIcon/variants'
import AuthPage from './features/auth/AuthPage'
import WizardPage from './features/wizard/WizardPage'
import LibraryPage from './features/library/LibraryPage'
import ReaderPage from './features/reader/ReaderPage'
import SettingsPage from './features/settings/SettingsPage'
import ReviewPage from './features/review/ReviewPage'
import UpdaterBoot from './features/updater/UpdaterBoot'

/** 主题色 → [r,g,b]（0-1），供 WebGL uniform 使用 */
function useThemeColors() {
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const toRgb = (name: string, fallback: [number, number, number]): [number, number, number] => {
      const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue(name).trim())
      if (!m) return fallback
      const n = parseInt(m[1], 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
    return {
      accent: toRgb('--accent', [0.2, 0.4, 0.54]),
      accentHex: cs.getPropertyValue('--accent').trim() || '#33658a',
      textHex: cs.getPropertyValue('--text').trim() || '#2a2f36',
    }
  }, [])
}

function BrandIcon() {
  // subscribe for reactivity
  useAuth((s) => s.settings.app_icon)
  const icon = resolveAppIcon()
  return <img src={APP_ICONS[icon]} alt="" className="h-16 w-16 rounded-2xl shadow-sm object-contain" />
}

/** 文件关联打开桥接：冷启动拉取 + 唤醒信号重拉 + 登录后串行消费（入库→跳阅读器）。
 *  挂载在登录态内外两个分支（与 UpdaterBoot 同层），未登录时路径滞留队列、登录后自动消化。 */
function ExternalOpenBridge() {
  const navigate = useNavigate()
  const user = useAuth((s) => s.user)
  const queue = useExternalOpen((s) => s.queue)
  const processing = useExternalOpen((s) => s.processing)

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | null = null
    // 路径权威源在 Rust PendingOpens 队列，事件仅作唤醒——处理器统一重拉，无竞态丢失
    const pull = () => {
      invoke<string[]>('take_pending_pdf_opens')
        .then((paths) => {
          if (!disposed && paths.length) useExternalOpen.getState().push(paths)
        })
        .catch(() => {})
    }
    pull()
    listen('paperlens:open-pdfs', pull)
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!user || processing || queue.length === 0) return
    const path = useExternalOpen.getState().shift()
    if (!path) return
    useExternalOpen.getState().setProcessing(true)
    api.openExternalPdf(path)
      .then(({ paper }) => navigate(`/reader/${paper.id}`))
      .catch(() => toast('文件不存在或无法读取', 'error'))
      .finally(() => useExternalOpen.getState().setProcessing(false))
  }, [user, queue, processing, navigate])

  return null
}

export default function App() {
  const { booted, boot, bootError, retryBoot, user, settings } = useAuth()
  const themeColors = useThemeColors()
  const animationsOn = settings.animations !== false

  useEffect(() => {
    boot()
  }, [boot])

  // 触控板捏合兜底：WebView2 恢复 pinch 手势后，捏合以 ctrlKey wheel 事件到达
  // 页面；无 preventDefault 的页面会被 WebView2 做整页 Page Scale 缩放（UI 变形）。
  // 全局 capture 吞掉所有 ctrl+wheel 默认行为——阅读器内缩放由 ReaderPage /
  // ComparePane 自身监听（目标链后段，preventDefault 幂等、传播不受影响）接管。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault()
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // 401 统一处理：会话失效 → 登出 + 提示（api/client 的 request() 触发）
  useEffect(() => {
    setUnauthorizedHandler(() => {
      useAuth.getState().logout()
      toast('登录已过期，请重新登录', 'error')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    applyTheme(settings.theme)
    document.documentElement.classList.toggle('no-motion', !settings.animations)
    document.documentElement.style.fontSize = `${14 * (settings.font_scale || 1)}px`
  }, [settings.theme, settings.animations, settings.font_scale])

  // Sync shortcut/window icon with current variant (covers orbit/diamond switch + update cache clear)
  useEffect(() => {
    if (!booted) return
    const v = resolveAppIcon()
    if (isTauri()) {
      invoke('set_app_icon', { variant: v }).catch(() => {})
    }
  }, [booted, settings.app_icon])

  useEffect(() => {
    if (!isTauri()) return
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        const win = getCurrentWindow()
        win.setFullscreen(!(await win.isFullscreen()))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 全局兜底：阻止 WebView2 对拖入文件的默认导航（文库页有自己的 drop 处理，
  // 阅读器/设置等页面无 drop 处理，不兜底会整页跳走丢失会话）
  useEffect(() => {
    if (!isTauri()) return
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const location = useLocation()
  useEffect(() => {
    if (location.pathname === '/review') {
      useUi.getState().closePanel()
    }
  }, [location.pathname])

  // 标签页按账号隔离：登录后读入该账号持久化标签（含账号切换清旧文档缓存），
  // 登出清内存与解析态文档缓存，对照窗格一并退出
  const userId = user?.id
  useEffect(() => {
    if (userId != null) {
      useReaderTabs.getState().hydrate(userId)
    } else {
      useReaderTabs.getState().clearMemory()
      useCompareStore.getState().setPaper(null)
    }
  }, [userId])

  if (!booted) {
    if (bootError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
          <p className="text-sm text-danger">{bootError}</p>
          <button className="btn btn-primary" onClick={retryBoot}>
            重试
          </button>
        </div>
      )
    }
    if (animationsOn) {
      return (
        <div className="relative flex h-full flex-col items-center justify-center gap-6 overflow-hidden bg-bg">
          <div className="absolute inset-0 opacity-40" aria-hidden>
            <Threads color={themeColors.accent} amplitude={1} distance={0} enableMouseInteraction={false} />
          </div>
          <div className="relative flex flex-col items-center gap-4">
            <BrandIcon />
            <div className="w-[min(520px,80vw)]">
              <StrokeText
                text="PAPERLENS"
                strokeColor={themeColors.accentHex}
                fillColor={themeColors.textHex}
                fontSize={72}
                fontWeight={800}
                letterSpacing={2}
                drawDuration={1.4}
                fillDelay={0.15}
                fillMode="wipe"
                trigger="mount"
              />
            </div>
            <div className="flex items-center gap-2.5 rounded-full border border-border bg-panel/80 px-5 py-1.5 shadow-[var(--shadow-1)] backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="text-[12.5px] font-semibold tracking-[0.32em] text-accent">HanQing 工作室出品</span>
            </div>
          </div>
          <div className="relative flex flex-col items-center gap-3 text-text-faint">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span className="text-xs tracking-widest">正在准备你的书房…</span>
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3 text-text-faint">
          <BrandIcon />
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs tracking-widest">PAPERLENS</span>
        </div>
      </div>
    )
  }

  if (!user)
    return (
      <>
        <WindowControls />
        <AuthPage />
        <UpdaterBoot />
        <ExternalOpenBridge />
      </>
    )

  return (
    <>
      <WindowControls />
      <ExternalOpenBridge />
      <Routes>
        <Route path="/wizard" element={<WizardPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/reader/:paperId" element={<ReaderPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <UpdaterBoot />
    </>
  )
}
