import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAuth, applyTheme } from './stores/auth'
import { setUnauthorizedHandler } from './api/client'
import { toast } from './features/shared/Toast'
import AppShell from './components/layout/AppShell'
import AuthPage from './features/auth/AuthPage'
import WizardPage from './features/wizard/WizardPage'
import LibraryPage from './features/library/LibraryPage'
import ReaderPage from './features/reader/ReaderPage'
import SettingsPage from './features/settings/SettingsPage'
import UpdaterBoot from './features/updater/UpdaterBoot'

export default function App() {
  const { booted, boot, user, settings } = useAuth()

  useEffect(() => {
    boot()
  }, [boot])

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

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3 text-text-faint">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs tracking-widest">PAPERLENS</span>
        </div>
      </div>
    )
  }

  if (!user)
    return (
      <>
        <AuthPage />
        <UpdaterBoot />
      </>
    )

  return (
    <>
      <Routes>
        <Route path="/wizard" element={<WizardPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/reader/:paperId" element={<ReaderPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <UpdaterBoot />
    </>
  )
}
