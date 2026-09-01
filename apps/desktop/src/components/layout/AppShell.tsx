import { useLayoutEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { applyTheme, useAuth } from '../../stores/auth'
import { useUi } from '../../stores/ui'
import Sidebar from './Sidebar'
import RightPanel from './RightPanel'
import Waves from '../shared/Waves'

export default function AppShell() {
  const { user, logout } = useAuth()
  const theme = useAuth((s) => s.settings.theme)
  const animationsOn = useAuth((s) => s.settings.animations !== false)
  const { rightTab } = useUi()
  const location = useLocation()
  // 波线色取当前主题 accent：render 期主题尚未应用（applyTheme 是 App 的
  // useEffect，晚于本组件），须在同一 layout effect 里先写 data-theme 再读
  // computed style，dark/system 用户才不会读到 warm 的默认色
  const [accent, setAccent] = useState('#33658a')
  useLayoutEffect(() => {
    applyTheme(theme)
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (v) setAccent(v)
  }, [theme])

  // 阅读器整屏不透明且自带渲染负载，此页不挂 Waves（省一个全屏 rAF）
  const showWaves = animationsOn && !location.pathname.startsWith('/reader')

  return (
    <div className="relative flex h-full overflow-hidden bg-bg text-text">
      {showWaves && (
        <div className="pointer-events-none absolute inset-0 z-0 opacity-20" aria-hidden>
          <Waves
            lineColor={accent}
            waveSpeedX={0.02}
            waveSpeedY={0.01}
            waveAmpX={40}
            waveAmpY={20}
            xGap={12}
            yGap={36}
          />
        </div>
      )}
      <div className="relative z-10 flex h-full min-w-0 flex-1">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* 顶栏（无边框：顶部区域不留横线；data-tauri-drag-region 供窗口化时拖拽移动）。
              右侧 padding 条件化：右栏收起时为常驻 —/✕ 控制小部件预留 pr-20；
              右栏展开时账号+退出登录直接贴紧面板左缘（用户要求零间隙） */}
          <header
            data-tauri-drag-region
            className={`glass sticky top-0 z-30 flex h-11 shrink-0 items-center justify-end pl-3 ${rightTab ? 'pr-3' : 'pr-20'}`}
          >
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
      </div>
      {rightTab && <RightPanel />}
    </div>
  )
}
