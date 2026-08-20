import { useState } from 'react'
import { useAuth } from '../../stores/auth'

export default function AuthPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

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

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-bg">
      <div className="pl-auth-bg" aria-hidden />
      <div className="fade-in relative w-[380px]">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-[var(--shadow-2)] transition-transform duration-300 hover:scale-105">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <path d="M9 7h7M9 10.5h7" />
            </svg>
          </div>
          <div className="text-center">
            <h1 className="pl-brand font-serif text-[26px] font-semibold tracking-[0.08em]">PaperLens</h1>
            <p className="mt-1 text-xs text-text-faint">学术 PDF 精读 · 离线翻译 · 生词沉淀</p>
          </div>
        </div>

        <form onSubmit={submit} className="panel pl-auth-card p-6">
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
          <p className="mt-4 text-center text-[11px] leading-5 text-text-faint">
            数据完全保存在本机
            <br />
            支持多个本地账号，数据彼此隔离
          </p>
        </form>
      </div>
    </div>
  )
}
