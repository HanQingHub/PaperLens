// 窗口控制小部件：最小化 / 退出（无边框窗口的自绘控制，无最大化按钮——产品要求保持全屏沉浸）
// 固定悬浮右上角，全屏与窗口化（F11）下均常驻；close 走 CloseRequested → 壳层优雅关闭链路。
// 非 Tauri 环境（浏览器 dev 调试）不渲染：getCurrentWindow 渲染期裸读
// __TAURI_INTERNALS__.metadata 会抛 TypeError，无守卫曾是整树白屏根因之一。
import { useMemo } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

const Btn = ({
  label,
  title,
  onClick,
  danger,
}: {
  label: React.ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) => (
  <button
    title={title}
    onMouseDown={(e) => e.stopPropagation()}
    onClick={onClick}
    className={`flex h-7 w-7 items-center justify-center rounded-md bg-black/20 text-[13px] leading-none text-white/60 backdrop-blur-sm transition-colors hover:bg-black/40 ${
      danger ? 'hover:text-[#ff5f57]' : 'hover:text-white'
    }`}
  >
    {label}
  </button>
)

export default function WindowControls() {
  const win = useMemo(() => {
    if (!isTauri()) return null
    try {
      return getCurrentWindow()
    } catch {
      return null
    }
  }, [])
  if (!win) return null
  return (
    <div className="fixed right-1.5 top-1.5 z-[100] flex items-center gap-1">
      <Btn
        label={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        }
        title="最小化"
        onClick={() => void win.minimize()}
      />
      <Btn
        label={
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        }
        title="退出 PaperLens"
        danger
        onClick={() => void win.close()}
      />
    </div>
  )
}
