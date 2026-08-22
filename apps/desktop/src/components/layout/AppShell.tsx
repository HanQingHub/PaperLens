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
        {/* 顶栏（无边框：顶部区域不留横线；data-tauri-drag-region 供窗口化时拖拽移动）。
            右侧 padding 条件化：右栏收起时为常驻 —/✕ 控制小部件预留 pr-20；
            右栏展开时账号+退出登录直接贴紧面板左缘（用户要求零间隙） */}
        <header
          data-tauri-drag-region
          className={`glass sticky top-0 z-30 flex h-11 shrink-0 items-center justify-between pl-3 ${rightTab ? 'pr-3' : 'pr-20'}`}
        >
          <div className="flex items-center gap-2 text-xs text-text-faint">
            <span className="font-serif text-sm font-semibold tracking-wide text-accent">PaperLens</span>
            <span className="opacity-40">·</span>
            <span>论文精读 · 翻译 · 生词 · 批注</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-soft">{user?.display_name ?? user?.username}</span>
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={logout}>
              退出登录
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
