import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth, applyTheme } from './stores/auth'
import AppShell from './components/layout/AppShell'
import AuthPage from './features/auth/AuthPage'
import WizardPage from './features/wizard/WizardPage'
import LibraryPage from './features/library/LibraryPage'
import ReaderPage from './features/reader/ReaderPage'
import SettingsPage from './features/settings/SettingsPage'

export default function App() {
  const { booted, boot, user, settings } = useAuth()

  useEffect(() => {
    boot()
  }, [boot])

  useEffect(() => {
    applyTheme(settings.theme)
    document.documentElement.classList.toggle('no-motion', !settings.animations)
    document.documentElement.style.fontSize = `${14 * (settings.font_scale || 1)}px`
  }, [settings.theme, settings.animations, settings.font_scale])

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

  if (!user) return <AuthPage />

  return (
    <Routes>
      <Route path="/wizard" element={<WizardPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/reader/:paperId" element={<ReaderPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
