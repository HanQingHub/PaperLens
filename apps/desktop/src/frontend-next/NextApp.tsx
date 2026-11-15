import { Navigate, Route, Routes } from 'react-router-dom'
import NextShell from './NextShell'
import NextLibraryPage from './NextLibraryPage'
import NextReaderPage from './NextReaderPage'
import NextReviewPage from './NextReviewPage'
import NextSettingsPage from './NextSettingsPage'
import NextWizardPage from './NextWizardPage'

/**
 * 全新界面的路由表：与经典界面逐条对齐（/wizard 独立于壳，其余在壳内）。
 * 页签对账（ensureFromPath）、脏 Markdown 拦截、关闭页签路由选择都由 NextShell 承担。
 */
export default function NextApp() {
  return (
    <Routes>
      <Route path="/wizard" element={<NextWizardPage />} />
      <Route element={<NextShell />}>
        <Route path="/" element={<NextLibraryPage />} />
        <Route path="/reader/:paperId" element={<NextReaderPage />} />
        <Route path="/review" element={<NextReviewPage />} />
        <Route path="/settings" element={<NextSettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
