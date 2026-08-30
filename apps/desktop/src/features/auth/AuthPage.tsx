import { useMemo, useState } from 'react'
import { useAuth } from '../../stores/auth'
import Threads from '../../components/shared/Threads'
import StrokeText from '../../components/shared/StrokeText'
import { type SavedAccount, loadAccounts, removeAccount } from './accounts'

/** 主题色 → Threads RGB + StrokeText hex，对齐 App.tsx useThemeColors 逻辑 */
function useAuthTheme() {
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const accentHex = cs.getPropertyValue('--accent').trim() || '#33658a'
    const textHex = cs.getPropertyValue('--text').trim() || '#2a2f36'
    const m = /^#([0-9a-f]{6})$/i.exec(accentHex)
    const rgb: [number, number, number] = m
      ? [((parseInt(m[1], 16) >> 16) & 255) / 255, ((parseInt(m[1], 16) >> 8) & 255) / 255, (parseInt(m[1], 16) & 255) / 255]
      : [0.2, 0.4, 0.54]
    return { accentRgb: rgb, accentHex, textHex }
  }, [])
}

export default function AuthPage() {
  const { login, register, switchAccount } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const { accentRgb, accentHex, textHex } = useAuthTheme()
  const accounts = loadAccounts()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || password.length < 4) {
      setErr('用户名不能为空，密码至少 4 位')
      return
    }
    setBusy(true)
    setErr('')
    try {
      if (mode === 'login') await login(username.trim(), password, remember)
      else await register(username.trim(), password)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const quickEnter = async (acc: SavedAccount) => {
    setErr('')
    setBusy(true)
    try {
      await switchAccount(acc.token)
    } catch {
      removeAccount(acc.username)
      setErr(`账号 ${acc.display_name} 的登录状态已失效，请重新登录`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-bg">
      <div className="absolute inset-0 opacity-40" aria-hidden>
        <Threads color={accentRgb} amplitude={1} distance={0} enableMouseInteraction={false} />
      </div>
      <div className="fade-in relative flex flex-col items-center">
        <div className="mb-6 flex w-[min(520px,80vw)] justify-center">
          <StrokeText
            text="PAPERLENS"
            strokeColor={accentHex}
            fillColor={textHex}
            fontSize={72}
            fontWeight={800}
            letterSpacing={2}
            drawDuration={1.4}
            fillDelay={0.15}
            fillMode="wipe"
            trigger="mount"
          />
        </div>

        <form onSubmit={submit} className="panel pl-auth-card w-[380px] p-6">
          {accounts.length > 0 && mode === 'login' && (
            <div className="mb-4">
              <span className="mb-1.5 block text-xs text-text-soft">最近账号</span>
              <div className="flex flex-wrap gap-1.5">
                {accounts.map((acc) => (
                  <button
                    key={acc.username}
                    type="button"
                    disabled={busy}
                    onClick={() => quickEnter(acc)}
                    className="rounded-full border border-border px-2.5 py-1 text-[12px] text-text-soft transition-colors hover:border-accent hover:text-accent"
                    title={`以 ${acc.display_name} 直接进入`}
                  >
                    {acc.display_name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mb-4 flex rounded-lg bg-bg-soft p-1 text-[13px]">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m)
                  setErr('')
                }}
                className={`flex-1 rounded-md py-1.5 transition-all ${mode === m ? 'bg-panel text-accent shadow-[var(--shadow-1)] font-medium' : 'text-text-faint hover:text-text-soft'}`}
              >
                {m === 'login' ? '登录' : '注册新账号'}
              </button>
            ))}
          </div>

          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-text-soft">用户名</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </label>
          <label className="mb-4 block">
            <span className="mb-1 block text-xs text-text-soft">密码</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>

          {mode === 'login' && (
            <label className="mb-4 flex cursor-pointer items-center gap-2 text-xs text-text-soft">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--accent)]" />
              记住我（30 天内免登录）
            </label>
          )}

          {err && <div className="mb-3 rounded-md bg-[rgba(181,72,60,.08)] px-3 py-2 text-xs text-danger">{err}</div>}

          <button className="btn btn-primary w-full justify-center py-2" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登 录' : '创建账号'}
          </button>
        </form>
      </div>
    </div>
  )
}
