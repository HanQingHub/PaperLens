// 自绘下拉：触发按钮 + 弹出菜单（缩放淡入过渡、外点/Esc 关闭），替代原生 select 与无动画菜单
import { useEffect, useState, type ReactNode } from 'react'

export interface DropdownItem {
  key: string
  label: ReactNode
  /** 右侧附加内容（如计数） */
  hint?: ReactNode
  active?: boolean
}

/** 菜单面板通用样式：open 控制过渡态；extra 传定位/尺寸类（调用方决定 top/left/宽度） */
export function menuPanelClass(open: boolean, extra = ''): string {
  return `absolute z-50 rounded-lg border border-[var(--border-strong)] bg-panel p-1 shadow-[var(--shadow-2)] transition-all duration-150 ease-out origin-top ${
    open ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none -translate-y-1 scale-95 opacity-0'
  }${extra ? ` ${extra}` : ''}`
}

/** 全屏透明遮罩：菜单展开期间拦截外点（mousedown 即关，不干扰菜单内 click） */
export function MenuOverlay({ onClose }: { onClose: () => void }) {
  return <div className="fixed inset-0 z-40" onMouseDown={onClose} />
}

export default function Dropdown({
  label,
  items,
  onSelect,
  className = 'relative',
  triggerClass = '',
  panelClass = 'left-0 top-full mt-1 min-w-[112px]',
  emptyText,
  title,
}: {
  label: ReactNode
  items: DropdownItem[]
  onSelect: (key: string) => void
  className?: string
  triggerClass?: string
  panelClass?: string
  emptyText?: string
  title?: string
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className={className}>
      <button className={`flex items-center gap-1.5 ${triggerClass}`} onClick={() => setOpen((v) => !v)} title={title} aria-expanded={open}>
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 opacity-60 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <MenuOverlay onClose={() => setOpen(false)} />}
      {/* 常驻挂载 + pointer-events 切换：收起同样走过渡动画 */}
      <div className={menuPanelClass(open, panelClass)}>
        {items.length === 0 ? (
          emptyText && <span className="block px-2.5 py-1.5 text-xs text-text-faint">{emptyText}</span>
        ) : (
          items.map((it) => (
            <button
              key={it.key}
              className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                it.active ? 'bg-accent-soft font-medium text-accent' : 'text-text hover:bg-bg-soft'
              }`}
              onClick={() => {
                onSelect(it.key)
                setOpen(false)
              }}
            >
              <span className="min-w-0 truncate">{it.label}</span>
              {it.hint != null && <span className="shrink-0 text-text-faint">{it.hint}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
