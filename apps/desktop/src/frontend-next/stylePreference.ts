import { pidFromPath, guardMdNav } from '../features/reader/mdDirty'
import { toast } from '../features/shared/Toast'

export type FrontendStyle = 'next' | 'classic'

const STORAGE_KEY = 'pl_frontend_style'
const CHANGE_EVENT = 'paperlens:frontend-style'
const listeners = new Set<() => void>()

/** 同步读取：无记录、存储不可用或值非法时均使用全新界面。 */
export function readFrontendStyle(): FrontendStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'classic' ? 'classic' : 'next'
  } catch {
    return 'next'
  }
}

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeFrontendStyle(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener()
  }
  const onLocal = () => listener()
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE_EVENT, onLocal)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE_EVENT, onLocal)
  }
}

export function setFrontendStyle(style: FrontendStyle) {
  try {
    localStorage.setItem(STORAGE_KEY, style)
  } catch {
    toast('界面偏好无法持久化，本次仍会生效', 'error')
  }
  emit()
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

// ── 切换前 flush 阅读进度 ─────────────────────────────────────
// 新阅读器挂载时注册自己的位置快照回调；切换只在有活动阅读器时 await 它。
// 经典阅读器卸载时会自行落库，因此这里不做任何 DOM 结构启发式读取。
export type ReaderFlush = () => Promise<void>

let registeredFlush: ReaderFlush | null = null

export function registerReaderFlush(callback: ReaderFlush | null): void {
  registeredFlush = callback
}

/** 所有入口共用：先经过未保存 Markdown 门禁 → flush 进度 → 再切换界面。 */
export function requestFrontendStyle(style: FrontendStyle) {
  if (style === readFrontendStyle()) return
  const run = () => {
    const flush = registeredFlush
    void Promise.resolve()
      .then(() => flush?.())
      .catch(() => {})
      .finally(() => setFrontendStyle(style))
  }
  if (!guardMdNav(run, pidFromPath(window.location.pathname))) run()
}
