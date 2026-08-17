// 认证 + 用户设置 store
import { create } from 'zustand'
import { api, setToken } from '../api/client'
import type { AppSettings, User } from '../api/types'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'warm',
  font_scale: 1,
  highlight_enabled: true,
  highlight_style: 2,
  highlight_only_current_paper: false,
  annotation_default_color: 'yellow',
  llm_model_id: null,
  llm_unload_policy: 10,
  animations: true,
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
  if (!s.theme || !['warm', 'light', 'dark', 'system'].includes(s.theme)) s.theme = 'warm'
  return s
}

interface AuthState {
  token: string | null
  user: User | null
  settings: AppSettings
  booted: boolean
  boot: () => Promise<void>
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

  boot: async () => {
    if (!get().token) {
      set({ booted: true })
      return
    }
    try {
      const me = await api.me()
      set({ user: me.user, settings: coerceSettings(me.settings), booted: true })
    } catch {
      setToken(null)
      set({ token: null, user: null, booted: true })
    }
  },

  login: async (username, password, remember) => {
    const r = await api.login(username, password, remember)
    setToken(r.token)
    set({ token: r.token, user: r.user })
    const me = await api.me().catch(() => null)
    if (me) set({ settings: coerceSettings(me.settings) })
  },

  register: async (username, password) => {
    const r = await api.register(username, password)
    setToken(r.token)
    set({ token: r.token, user: r.user })
  },

  logout: async () => {
    await api.logout().catch(() => {})
    setToken(null)
    set({ token: null, user: null, settings: DEFAULT_SETTINGS })
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

// 主题应用到 <html data-theme>
export function applyTheme(theme: AppSettings['theme']) {
  document.documentElement.dataset.theme = theme
}
