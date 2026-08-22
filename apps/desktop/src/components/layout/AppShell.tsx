import { Outlet } from 'react-router-dom'
import { useAuth } from '../../stores/auth'
import { useUi } from '../../stores/ui'
import Sidebar from './Sidebar'
import RightPanel from './RightPanel'

export default function AppShell() {
  const { user, logout } = useAuth()
  const { rightTab } = useUi()

  return (
    <div className="flex h-full overflow-hidden bg-bg text-text">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* 顶栏（无边框：与侧栏竖线的 T 交角不对齐，按"删线"方案移除 border-b，glass 背景保留分层观感） */}
        <header className="glass sticky top-0 z-30 flex h-11 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-2 text-xs text-text-faint">
            <span className="font-serif text-sm font-semibold tracking-wide text-accent">PaperLens</span>
            <span className="opacity-40">·</span>
            <span>论文精读 · 翻译 · 生词 · 批注</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-soft">{user?.display_name ?? user?.username}</span>
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={logout}>
              退出
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      {rightTab && <RightPanel />}
    </div>
  )
}
