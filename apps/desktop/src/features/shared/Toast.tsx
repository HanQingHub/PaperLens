// 轻提示 toast（右上角滑入，自管理 DOM，无需挂载点）
// 用法：import { toast } from './shared/Toast'; toast('已保存', 'ok')

export type ToastType = 'info' | 'ok' | 'error'

interface ToastItem {
  el: HTMLDivElement
  timer: number
}

const TIMEOUT = 3200

function ensureRoot(): HTMLDivElement {
  let root = document.querySelector<HTMLDivElement>('.pl-toast-root')
  if (!root) {
    root = document.createElement('div')
    root.className = 'pl-toast-root'
    document.body.appendChild(root)
  }
  return root
}

const live = new Set<ToastItem>()

function dismiss(item: ToastItem) {
  if (!live.has(item)) return
  live.delete(item)
  item.el.classList.add('pl-toast-out')
  setTimeout(() => item.el.remove(), 200)
}

export function toast(message: string, type: ToastType = 'info') {
  const root = ensureRoot()
  // 同文案去重
  for (const item of live) {
    if (item.el.dataset.msg === message) {
      clearTimeout(item.timer)
      item.timer = window.setTimeout(() => dismiss(item), TIMEOUT)
      return
    }
  }
  const el = document.createElement('div')
  el.className = `pl-toast pl-toast-${type}`
  el.dataset.msg = message
  el.textContent = message
  root.appendChild(el)
  const item: ToastItem = { el, timer: 0 }
  item.timer = window.setTimeout(() => dismiss(item), TIMEOUT)
  live.add(item)
  el.addEventListener('click', () => dismiss(item))
}

// 供组件化使用的 hook 形式（内部同 toast()）
export function useToast() {
  return toast
}
