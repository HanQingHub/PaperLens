import { useState, type FormEvent } from 'react'
import { useAuth } from '../stores/auth'
import { APP_ICONS, resolveAppIcon } from '../features/appIcon/variants'
import { loadAccounts, removeAccount, type SavedAccount } from '../features/auth/accounts'

export default function NextAuthPage() {
  const { login, register, switchAccount } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const accounts = loadAccounts()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || password.length < 4) {
      setError('请填写用户名，密码至少需要 4 位')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await login(username.trim(), password, remember)
      else await register(username.trim(), password)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const quickEnter = async (account: SavedAccount) => {
    setBusy(true)
    setError('')
    try {
      await switchAccount(account.token)
    } catch {
      removeAccount(account.username)
      setError(`账号 ${account.display_name} 的登录状态已失效，请重新登录`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pnx-root pnx-auth">
      <section className="pnx-auth-story" aria-label="产品介绍">
        <div className="pnx-auth-brand"><img src={APP_ICONS[resolveAppIcon()]} alt="" /><span>PaperLens</span></div>
        <div className="pnx-auth-quote">
          <span className="pnx-eyebrow">把阅读，变成积累</span>
          <h1>在字里行间，<br />建立你的知识坐标。</h1>
          <p>论文、批注、生词与灵感，都留在这间安静的本地书房。</p>
        </div>
        <div className="pnx-auth-books" aria-hidden><i /><i /><i /><i /></div>
        <small>无需云端 · 数据仅保存在你的设备</small>
      </section>
      <main className="pnx-auth-main">
        <form className="pnx-auth-form" onSubmit={submit}>
          <span className="pnx-eyebrow">{mode === 'login' ? '欢迎回来' : '创建本地账号'}</span>
          <h2>{mode === 'login' ? '继续你的阅读' : '开启第一本书'}</h2>
          <div className="pnx-segment" role="tablist" aria-label="登录或注册">
            {(['login', 'register'] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? 'is-active' : ''} onClick={() => { setMode(item); setError('') }}>
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
          {mode === 'login' && accounts.length > 0 && (
            <div className="pnx-recent"><label>最近账号</label><div>{accounts.map((account) => <button type="button" key={account.username} disabled={busy} onClick={() => quickEnter(account)}>{account.display_name}</button>)}</div></div>
          )}
          <label className="pnx-field"><span>用户名</span><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus /></label>
          <label className="pnx-field"><span>密码</span><div className="pnx-password"><input className="input" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /><button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? '隐藏' : '显示'}</button></div></label>
          {mode === 'login' && <label className="pnx-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />记住登录（30 天内免登录）</label>}
          {error && <p className="pnx-form-error" role="alert">{error}</p>}
          <button className="btn btn-primary pnx-submit" disabled={busy}>{busy ? '正在验证…' : mode === 'login' ? '进入书房' : '创建账号'}</button>
          <p className="pnx-auth-hint">按回车提交 · 所有阅读数据均保存在本机</p>
        </form>
      </main>
    </div>
  )
}
