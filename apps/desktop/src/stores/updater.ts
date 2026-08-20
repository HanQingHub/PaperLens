// 自动更新状态机（设计文档五·更新流程）：
// idle → checking → available ──下载──→ downloading → ready ──安装(应用退出)──→ [新版本]
//                    └→ idle（无更新/失败）        └→ error（可重试）
// 更新策略（设备级，localStorage；启动检查发生在登录前，故不存后端 app_settings）
import { create } from 'zustand'
import {
  updaterAvailable, checkForUpdate, downloadUpdate, installUpdate, runStartupCheck,
  type RemoteUpdate, type StartupCheckResult,
} from '../api/updaterCore'

// 通知回调由 features 层注入（UpdaterBoot 注册 toast），store 不反向依赖 features
type NotifyFn = (message: string, type: 'info' | 'ok' | 'error') => void
let notify: NotifyFn = () => {}
export function setUpdaterNotify(fn: NotifyFn) {
  notify = fn
}

export type UpdatePolicy = 'ask' | 'auto' | 'off'
export type UpdaterPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

const POLICY_KEY = 'pl_update_policy'

function loadPolicy(): UpdatePolicy {
  const v = localStorage.getItem(POLICY_KEY)
  return v === 'auto' || v === 'off' || v === 'ask' ? v : 'ask'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface UpdaterState {
  phase: UpdaterPhase
  policy: UpdatePolicy
  /** 当前应用版本（startup_check 回填；web dev 下保持占位） */
  currentVersion: string
  update: RemoteUpdate | null
  progress: { downloaded: number; total: number | null } | null
  error: string | null
  lastCheckAt: number | null
  dialogOpen: boolean
  /** 启动自检结果（P1-6 版本核对 + resources 完整性） */
  startup: StartupCheckResult | null

  setPolicy: (p: UpdatePolicy) => void
  setDialogOpen: (v: boolean) => void
  applyStartupCheck: (r: StartupCheckResult) => void
  /** manual=true 由用户触发（失败弹 toast、有更新即弹窗） */
  check: (opts: { manual: boolean }) => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: 'idle',
  policy: loadPolicy(),
  currentVersion: '0.1.0',
  update: null,
  progress: null,
  error: null,
  lastCheckAt: null,
  dialogOpen: false,
  startup: null,

  setPolicy: (p) => {
    localStorage.setItem(POLICY_KEY, p)
    set({ policy: p })
  },

  setDialogOpen: (v) => set({ dialogOpen: v }),

  applyStartupCheck: (r) => set({ startup: r, currentVersion: r.appVersion }),

  check: async ({ manual }) => {
    if (!updaterAvailable()) {
      if (manual) notify('更新功能仅限桌面应用内使用', 'error')
      return
    }
    if (['checking', 'downloading'].includes(get().phase)) return

    const policy = get().policy
    set({ phase: 'checking', error: null })
    try {
      const u = await checkForUpdate()
      set({ lastCheckAt: Date.now() })
      if (!u) {
        set({ phase: 'idle', update: null })
        if (manual) notify('已是最新版本', 'ok')
        return
      }
      set({ phase: 'available', update: u })
      if (policy === 'auto') {
        // 自动策略：后台下载，完成后弹窗引导重启安装
        await get().download()
      } else if (policy === 'ask' || manual) {
        set({ dialogOpen: true })
      }
    } catch (e) {
      // 自动/后台检查失败静默（不阻塞启动），手动检查提示
      set({ phase: 'error', error: errMsg(e) })
      if (manual) notify(`检查更新失败：${errMsg(e)}`, 'error')
    }
  },

  download: async () => {
    const { update, phase, policy } = get()
    if (!update || phase === 'downloading') return
    set({ phase: 'downloading', progress: { downloaded: 0, total: null }, error: null })
    try {
      await downloadUpdate(update, (downloaded, total) =>
        set({ progress: { downloaded, total } }),
      )
      set({ phase: 'ready' })
      if (policy === 'auto') set({ dialogOpen: true })
    } catch (e) {
      // 无断点续传，失败整包重试（设计文档 P1-4）
      set({ phase: 'error', error: errMsg(e) })
    }
  },

  install: async () => {
    const { update, phase } = get()
    if (!update || phase !== 'ready') return
    try {
      await installUpdate(update)
      // Windows 下插件 exit(0) 交由 NSIS 静默安装并拉起新版本，流程不返回
    } catch (e) {
      set({ phase: 'error', error: errMsg(e) })
      notify(`安装失败：${errMsg(e)}`, 'error')
    }
  },
}))

/** 启动自检入口（UpdaterBoot 调用）：失败静默，不阻塞启动 */
export async function bootStartupCheck(): Promise<StartupCheckResult | null> {
  if (!updaterAvailable()) return null
  try {
    const r = await runStartupCheck()
    useUpdater.getState().applyStartupCheck(r)
    return r
  } catch {
    return null
  }
}
