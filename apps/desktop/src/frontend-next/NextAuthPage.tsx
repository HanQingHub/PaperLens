import { useState, type FormEvent } from 'react'
import { useAuth } from '../stores/auth'
import { APP_ICONS, resolveAppIcon } from '../features/appIcon/variants'
import { loadAccounts, removeAccount, type SavedAccount } from '../features/auth/accounts'
import NextStrataSlices from './NextStrataSlices'
import { strataMotionOn, useStrataDocument } from './strataDocument'

export default function NextAuthPage() {
  useStrataDocument()
  const { login, register, switchAccount } = useAuth()
  const animations = useAuth((s) => s.settings.animations)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const accounts = loadAccounts()
  const motion = animations && strataMotionOn()

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
    <div className="pnx-root pnx-auth pnx-sx-gate">
      <section className="pnx-sx-gate-comp" aria-label="产品介绍">
        <div className="pnx-sx-gate-rule" aria-hidden><span>PAPERLENS / 研究阅读系统</span><span>STRATA · LOCAL NODE</span></div>
        <div className="pnx-sx-gate-type">
          <span className="pnx-sx-gate-big" aria-hidden>层<br />析</span>
          <span className="pnx-sx-gate-en">STRATA</span>
          <p>把一篇论文切成可以被<b>阅读、比较、记住</b>的层。<br />文本、公式、图表、批注与生词，各自成层，叠成你的研究地形。</p>
        </div>
        <div className="pnx-sx-gate-bar" aria-hidden />
        <div className="pnx-sx-gate-disc" aria-hidden />
        <div className="pnx-sx-gate-art"><NextStrataSlices size="lg" motion={motion} parallax /></div>
        <div className="pnx-sx-gate-ticks" aria-hidden />
      </section>
      <main className="pnx-auth-main pnx-sx-gate-panel">
        <div className="pnx-sx-gate-top">
          <span className="pnx-sx-badge"><i aria-hidden />离线模式 · 数据只在本机</span>
          <span className="pnx-sx-mono">LOCAL</span>
        </div>
        <form className="pnx-auth-form" onSubmit={submit}>
          <div className="pnx-auth-brand"><img src={APP_ICONS[resolveAppIcon()]} alt="" /><span>PaperLens</span></div>
          <span className="pnx-eyebrow">{mode === 'login' ? 'ACCESS / 入口' : 'REGISTER / 本地账号'}</span>
          <h2>{mode === 'login' ? '进入你的研究地形' : '创建本地账号'}</h2>
          <div className="pnx-segment" role="tablist" aria-label="登录或注册">
            {(['login', 'register'] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? 'is-active' : ''} onClick={() => { setMode(item); setError('') }}>
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
          {mode === 'login' && accounts.length > 0 && (
            <div className="pnx-recent"><label>最近账号</label><div>{accounts.map((account) => <button type="button" key={account.username} disabled={busy} onClick={() => quickEnter(account)}><i aria-hidden>{account.display_name.slice(0, 1).toUpperCase()}</i>{account.display_name}</button>)}</div></div>
          )}
          <label className="pnx-field"><span>用户名 <em>USER</em></span><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus /></label>
          <label className="pnx-field"><span>密码 <em>{mode === 'login' ? 'KEY' : 'KEY · ≥ 6 位'}</em></span><div className="pnx-password"><input className="input" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /><button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? '隐藏' : '显示'}</button></div></label>
          {mode === 'login' && <label className="pnx-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />记住登录（30 天内免登录）</label>}
          {error && <p className="pnx-form-error" role="alert">{error}</p>}
          <button className="btn btn-primary pnx-submit" disabled={busy}><span>{busy ? '正在验证…' : mode === 'login' ? '进入文库' : '创建账号'}</span><span aria-hidden>→</span></button>
          <p className="pnx-auth-hint">按回车提交 · 所有阅读数据均保存在本机</p>
        </form>
        <div className="pnx-sx-gate-foot"><span>本地索引 · 离线翻译 · 间隔复习</span><span>核心功能离线可用</span></div>
      </main>
    </div>
  )
}
