// 认证 + 用户设置 store
import { create } from 'zustand'
import { api, ApiError, setToken, waitForBackend } from '../api/client'
import type { AppSettings, User } from '../api/types'
import { upsertAccount, removeAccount } from '../features/auth/accounts'

/** 主题消毒（coerceSettings 与 pl_theme 本地镜像共用一份白名单） */
function coerceTheme(v: unknown): AppSettings['theme'] {
  return typeof v === 'string' && ['warm', 'light', 'dark', 'system', 'apple', 'claude'].includes(v)
    ? (v as AppSettings['theme'])
    : 'warm'
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: coerceTheme(localStorage.getItem('pl_theme')),
  font_scale: 1,
  highlight_enabled: true,
  highlight_style: 2,
  highlight_only_current_paper: false,
  annotation_default_color: 'yellow',
  llm_model_id: null,
  llm_unload_policy: 10,
  animations: true,
  app_icon: 'orbit',
}

/** 布尔兼容：历史脏数据可能是 "True"/"1" 等 */
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1'
}

/** 设置类型消毒：服务端数据一律强转，杜绝字符串混入导致渲染崩溃 */
export function coerceSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) } as AppSettings
  s.font_scale = Number(s.font_scale) || 1
  const hs = Number(s.highlight_style)
  s.highlight_style = (hs === 1 || hs === 2 || hs === 3 ? hs : 2) as 1 | 2 | 3
  const lp = Number(s.llm_unload_policy)
  s.llm_unload_policy = Number.isFinite(lp) ? lp : 10
  s.highlight_enabled = truthy(s.highlight_enabled)
  s.highlight_only_current_paper = truthy(s.highlight_only_current_paper)
  s.animations = truthy(s.animations)
  s.theme = coerceTheme(s.theme)
  if (s.app_icon !== 'orbit' && s.app_icon !== 'diamond') s.app_icon = 'orbit'
  return s
}

interface AuthState {
  token: string | null
  user: User | null
  settings: AppSettings
  booted: boolean
  /** 启动失败（后端超时等非 401 错误）：置错误屏，等待用户重试 */
  bootError: string | null
  boot: () => Promise<void>
  retryBoot: () => Promise<void>
  /** 用已存 token 直接进入（登录页最近账号 chips）；401 抛错由调用方摘除该账号 */
  switchAccount: (token: string) => Promise<void>
  login: (u: string, p: string, remember: boolean) => Promise<void>
  register: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  token: localStorage.getItem('pl_token'),
  user: null,
  settings: DEFAULT_SETTINGS,
  booted: false,
  bootError: null,

  boot: async () => {
    if (!get().token) {
      set({ booted: true })
      return
    }
    try {
      // server 未就绪时等待而非失败：启动竞态下静默登出是历史 bug
      await waitForBackend()
      const me = await api.me()
      set({ user: me.user, settings: coerceSettings(me.settings), booted: true, bootError: null })
    } catch (e) {
      // 仅明确的 401（会话失效）清 token；网络/超时错误保会话进错误屏
      if (e instanceof ApiError && e.status === 401) {
        setToken(null)
        set({ token: null, user: null, booted: true, bootError: null })
        return
      }
      set({ bootError: e instanceof Error ? e.message : '启动失败' })
    }
  },

  /** 错误屏重试：回到未启动态重新走 boot */
  retryBoot: async () => {
    set({ booted: false, bootError: null })
    await get().boot()
  },

  switchAccount: async (token: string) => {
    setToken(token)
    set({ token, booted: false, bootError: null })
    await get().boot()
    if (get().bootError || !get().user) {
      // token 失效：boot 已清会话，抛错让 UI 摘除该账号
      throw new Error('登录状态已失效')
    }
  },

  login: async (username, password, remember) => {
    const r = await api.login(username, password, remember)
    setToken(r.token)
    set({ token: r.token, user: r.user })
    upsertAccount({ username: r.user.username, display_name: r.user.display_name ?? r.user.username, token: r.token, at: Date.now() })
    const me = await api.me().catch(() => null)
    if (me) set({ settings: coerceSettings(me.settings) })
  },

  register: async (username, password) => {
    const r = await api.register(username, password)
    setToken(r.token)
    set({ token: r.token, user: r.user })
    upsertAccount({ username: r.user.username, display_name: r.user.display_name ?? r.user.username, token: r.token, at: Date.now() })
  },

  logout: async () => {
    const current = get().user?.username
    await api.logout().catch(() => {})
    setToken(null)
    // 主题回到本地镜像（最近应用的主题）而非模块加载快照：会话内换过主题后登出，
    // 登录页与重启后保持一致观感
    set({
      token: null,
      user: null,
      settings: coerceSettings({ theme: coerceTheme(localStorage.getItem('pl_theme')) }),
    })
    if (current) removeAccount(current) // logout 已服务端销毁 session，摘除死 token
  },

  updateSettings: async (patch) => {
    const prev = get().settings
    set({ settings: coerceSettings({ ...prev, ...patch }) })
    try {
      const saved = await api.updateSettings(patch)
      set({ settings: coerceSettings(saved) })
    } catch {
      // 乐观更新失败回滚
      set({ settings: prev })
      throw new Error('设置保存失败')
    }
  },
}))

let themeAnimTimer: number | undefined

// 主题应用到 <html data-theme>，并写 pl_theme 本地镜像（登录页/启动画布在
// 服务端设置到达前按镜像呈现；登出后读镜像回填 settings）。
// 主题值变化且动效开启时挂 300ms 全局过渡类（首次应用/同值不挂）。
export function applyTheme(theme: AppSettings['theme']) {
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  if (root.dataset.theme && !root.classList.contains('no-motion')) {
    root.classList.add('theme-anim')
    void root.offsetWidth // 防御性强制样式计算，规避引擎批处理差异（规范上 after-change style 已足以启动过渡）
    clearTimeout(themeAnimTimer)
    themeAnimTimer = window.setTimeout(() => root.classList.remove('theme-anim'), 350)
  }
  root.dataset.theme = theme
  localStorage.setItem('pl_theme', theme)
}
