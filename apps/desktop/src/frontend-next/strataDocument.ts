/**
 * 层析 STRATA · 文档级开关与动效判定。
 * 层析界面挂载期间在 <html> 上挂 .pnx-strata，strata.css 据此把主题变量整体重定向为层析色板，
 * 使 .pnx-root 内的 next 组件与借用的经典组件（Tailwind 工具类 / .btn / .input / Modal / Toast）
 * 统一取色；切回经典界面时随卸载移除，经典界面零影响。
 */
import { useLayoutEffect } from 'react'

let mounted = 0

export function useStrataDocument(): void {
  useLayoutEffect(() => {
    mounted += 1
    document.documentElement.classList.add('pnx-strata')
    return () => {
      mounted = Math.max(0, mounted - 1)
      if (mounted === 0) document.documentElement.classList.remove('pnx-strata')
    }
  }, [])
}

/** 声明式标记：供类组件（如错误边界回退屏）使用 */
export function StrataDocument(): null {
  useStrataDocument()
  return null
}

/** 动效总开关：设置「动画」关闭（html.no-motion）或系统减少动态效果时返回 false */
export function strataMotionOn(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.classList.contains('no-motion')) return false
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true
  }
}
