import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { api, saveBlobWithDialog } from '../api/client'
import type { AppIconVariant, AppSettings, LLMModelInfo, LLMStatus } from '../api/types'
import { useAuth } from '../stores/auth'
import { useUpdater, type UpdatePolicy } from '../stores/updater'
import { APP_ICONS, persistAppIconLocal } from '../features/appIcon/variants'
import Modal, { ConfirmModal } from '../features/shared/Modal'
import { IconBook, IconCheck, IconPencil, IconX } from '../components/shared/Icon'
import { toast } from '../features/shared/Toast'
import { guardMdNav } from '../features/reader/mdDirty'
import { readFrontendStyle, requestFrontendStyle, subscribeFrontendStyle } from './stylePreference'
import './NextSettingsPage.css'

const THEMES: { key: AppSettings['theme']; label: string; colors: [string, string, string] }[] = [
  { key: 'warm', label: '暖纸', colors: ['#faf7f0', '#ffffff', '#33658a'] },
  { key: 'light', label: '浅色', colors: ['#f5f6f8', '#ffffff', '#33658a'] },
  { key: 'dark', label: '深色', colors: ['#23252a', '#2b2e34', '#7fa6c9'] },
  { key: 'system', label: '跟随系统', colors: ['#f5f6f8', '#2b2e34', '#33658a'] },
  { key: 'apple', label: 'Apple', colors: ['#f2f2f7', '#ffffff', '#007aff'] },
  { key: 'claude', label: 'Claude', colors: ['#faf9f5', '#ffffff', '#c96442'] },
]

const ANNOTATION_COLORS = [
  { key: 'yellow', label: '黄', css: '#ffe08a' },
  { key: 'green', label: '绿', css: '#a8d5a2' },
  { key: 'blue', label: '蓝', css: '#a9d3e8' },
  { key: 'pink', label: '粉', css: '#f5b8c4' },
  { key: 'purple', label: '紫', css: '#c9b6e4' },
] as const

const SHORTCUTS: [string, string, string][] = [
  ['T', '翻译选中文本', '有选区且无输入框聚焦'],
  ['B', '对选区新建批注', '同上'],
  ['W', '选区入生词库', '同上'],
  ['H', '选区五色高亮（循环默认色）', '同上'],
  ['Ctrl+F', '页内搜索', '阅读器聚焦'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', '缩放 / 恢复', '阅读器聚焦'],
  ['← / → 或 PgUp / PgDn', '翻页（单页模式）', '阅读器聚焦'],
  ['Esc', '关闭卡片 / 取消连线', '任意'],
]

const NAV_ITEMS = [
  ['pnx-account', '账号'],
  ['pnx-appearance', '外观'],
  ['pnx-highlight', '生词高亮'],
  ['pnx-annotation', '批注'],
  ['pnx-models', '本地模型'],
  ['pnx-dictionary', '词典'],
  ['pnx-association', '文件关联'],
  ['pnx-data', '数据与备份'],
  ['pnx-update', '应用更新'],
  ['pnx-shortcuts', '快捷键'],
] as const

const UPDATE_POLICIES: { key: UpdatePolicy; label: string }[] = [
  { key: 'ask', label: '询问' },
  { key: 'auto', label: '自动下载' },
  { key: 'off', label: '关闭' },
]

function fmtSize(bytes: number) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MiB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

function errorText(reason: unknown, fallback: string) {
  if (reason instanceof Error) return reason.message
  const text = String(reason)
  return text && text !== 'undefined' ? text : fallback
}

function Section({
  id,
  index,
  title,
  description,
  wide = false,
  children,
}: {
  id: string
  index: string
  title: string
  description?: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <section id={id} className={`pnx-section${wide ? ' pnx-section-wide' : ''}`} aria-labelledby={`${id}-title`}>
      <header className="pnx-section-header">
        <span className="pnx-section-index" aria-hidden>{`C-${index}`}</span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      <div className="pnx-section-body">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pnx-row">
      <div className="pnx-row-copy">
        <div className="pnx-row-label">{label}</div>
        {hint && <div className="pnx-row-hint">{hint}</div>}
      </div>
      <div className="pnx-row-control">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="pnx-toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="pnx-toggle-thumb" aria-hidden />
    </button>
  )
}

export default function NextSettingsPage() {
  const { settings, updateSettings, user, logout } = useAuth()
  const updater = useUpdater()
  const { phase, policy, setPolicy, check, download, install, setDialogOpen } = updater
  const frontendStyle = useSyncExternalStore(subscribeFrontendStyle, readFrontendStyle)
  const desktop = isTauri()

  const mountedRef = useRef(true)
  const downloadSessionRef = useRef(0)
  const modelActionRef = useRef(0)
  const modelWaitRef = useRef<{ finish: () => void } | null>(null)
  const llmRequestRef = useRef(0)

  const [pendingSaves, setPendingSaves] = useState(0)
  const save = useCallback(async (patch: Parameters<typeof updateSettings>[0]) => {
    if (mountedRef.current) setPendingSaves((count) => count + 1)
    try {
      await updateSettings(patch)
      return true
    } catch {
      if (mountedRef.current) toast('设置保存失败，已回滚', 'error')
      return false
    } finally {
      if (mountedRef.current) setPendingSaves((count) => Math.max(0, count - 1))
    }
  }, [updateSettings])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      downloadSessionRef.current += 1
      modelActionRef.current += 1
      modelWaitRef.current?.finish()
    }
  }, [])

  // 账号资料
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const saveDisplayName = async () => {
    const name = nameInput.trim()
    if (!name || name === user?.display_name) {
      setEditingName(false)
      return
    }
    setNameBusy(true)
    try {
      await api.updateProfile(name)
      const me = await api.me()
      if (!mountedRef.current) return
      useAuth.setState({ user: me.user })
      toast('展示名已更新', 'ok')
      setEditingName(false)
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '保存失败'), 'error')
    } finally {
      if (mountedRef.current) setNameBusy(false)
    }
  }
  const onLogout = () => {
    const run = () => {
      void logout().catch(() => toast('退出失败', 'error'))
    }
    if (!guardMdNav(run)) run()
  }

  // 字号先在本地预览，再防抖写入既有设置接口。
  const [fontScale, setFontScale] = useState(Number(settings.font_scale) || 1)
  useEffect(() => setFontScale(Number(settings.font_scale) || 1), [settings.font_scale])
  useEffect(() => {
    document.documentElement.style.fontSize = `${14 * fontScale}px`
    if (fontScale === settings.font_scale) return
    const timer = window.setTimeout(() => {
      void save({ font_scale: fontScale })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [fontScale, save, settings.font_scale])

  // 文件关联
  const [pdfAssoc, setPdfAssoc] = useState(false)
  const [mdAssoc, setMdAssoc] = useState(false)
  const [assocBusy, setAssocBusy] = useState(false)
  const [chooseExt, setChooseExt] = useState<'pdf' | 'md' | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    invoke<boolean>('get_pdf_assoc_state').then((value) => {
      if (active) setPdfAssoc(value)
    }).catch(() => {})
    invoke<boolean>('get_md_assoc_state').then((value) => {
      if (active) setMdAssoc(value)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const toggleAssoc = async (kind: 'pdf' | 'md') => {
    if (assocBusy) return
    if (!isTauri()) {
      toast('文件关联仅桌面应用可用', 'error')
      return
    }
    const enable = !(kind === 'pdf' ? pdfAssoc : mdAssoc)
    const setAssoc = kind === 'pdf' ? setPdfAssoc : setMdAssoc
    const label = kind === 'pdf' ? 'PDF' : 'Markdown'
    setAssocBusy(true)
    try {
      const result = await invoke<{ needs_system_ui: boolean }>(
        kind === 'pdf' ? 'set_pdf_assoc' : 'set_md_assoc',
        { enable },
      )
      if (!mountedRef.current) return
      setAssoc(enable)
      if (enable && result.needs_system_ui) {
        setChooseExt(kind)
      } else {
        toast(enable ? `已设为 ${label} 默认打开方式` : `已取消 ${label} 默认打开方式`, 'ok')
      }
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '设置失败'), 'error')
    } finally {
      if (mountedRef.current) setAssocBusy(false)
    }
  }

  const closeChooseModal = () => {
    const ext = chooseExt
    setChooseExt(null)
    if (!ext || !isTauri()) return
    invoke<boolean>('get_assoc_effective', { ext: `.${ext}` }).then((ok) => {
      if (ok && mountedRef.current) toast('已设为默认打开方式', 'ok')
    }).catch(() => {})
  }
  const runOpenWith = async () => {
    if (!chooseExt || !isTauri()) return
    try {
      await invoke('show_open_with', { ext: `.${chooseExt}` })
      closeChooseModal()
    } catch (reason) {
      toast(errorText(reason, '无法拉起打开方式选择框'), 'error')
    }
  }
  const runOpenSettings = () => {
    if (!isTauri()) return
    invoke('open_external', { url: 'ms-settings:defaultapps' }).catch(() => {})
  }

  // LLM 状态与模型列表
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null)
  const [models, setModels] = useState<LLMModelInfo[]>([])
  const refreshLlm = useCallback(async () => {
    const requestId = ++llmRequestRef.current
    try {
      const [status, modelList] = await Promise.all([api.llmStatus(), api.llmModels()])
      if (!mountedRef.current || requestId !== llmRequestRef.current) return
      setLlmStatus(status)
      setModels(modelList)
    } catch {
      // 状态轮询失败保持上次可用信息。
    }
  }, [])
  useEffect(() => {
    void refreshLlm()
    const timer = window.setInterval(() => void refreshLlm(), 5000)
    return () => {
      window.clearInterval(timer)
      llmRequestRef.current += 1
    }
  }, [refreshLlm])

  const [downloading, setDownloading] = useState<string | null>(null)
  const [dlProgress, setDlProgress] = useState<{ percent: number | null; downloaded: number; total: number } | null>(null)
  const downloadModel = async (model: LLMModelInfo) => {
    if (downloading) return
    const session = ++downloadSessionRef.current
    setDownloading(model.id)
    setDlProgress({ percent: 0, downloaded: 0, total: model.size_bytes })
    try {
      for await (const event of api.llmDownloadStream(model.id)) {
        if (!mountedRef.current || session !== downloadSessionRef.current) break
        if (event.event === 'progress') {
          setDlProgress({
            percent: event.percent,
            downloaded: event.downloaded,
            total: event.total_bytes || model.size_bytes,
          })
        } else if (event.event === 'done') {
          toast(`下载完成：${event.file}`, 'ok')
          void refreshLlm()
        } else if (event.event === 'error') {
          toast(event.detail || '下载失败', 'error')
        }
      }
    } catch (reason) {
      if (mountedRef.current && session === downloadSessionRef.current) {
        toast(errorText(reason, '下载中断'), 'error')
      }
    } finally {
      if (mountedRef.current && session === downloadSessionRef.current) {
        setDownloading(null)
        setDlProgress(null)
      }
    }
  }

  const ggufInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const importModel = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.gguf')) {
      toast('仅支持 GGUF 文件', 'error')
      return
    }
    setImporting(true)
    try {
      await api.llmImport(file)
      if (!mountedRef.current) return
      toast('模型导入成功', 'ok')
      void refreshLlm()
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '导入失败'), 'error')
    } finally {
      if (mountedRef.current) setImporting(false)
    }
  }

  const [modelBusy, setModelBusy] = useState<string | null>(null)
  const waitForModelPoll = () => new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (modelWaitRef.current?.finish === finish) modelWaitRef.current = null
      resolve()
    }
    const timer = window.setTimeout(finish, 800)
    modelWaitRef.current = { finish }
  })

  const loadModel = async (model: LLMModelInfo) => {
    if (modelBusy) return
    modelWaitRef.current?.finish()
    const action = ++modelActionRef.current
    setModelBusy(model.id)
    try {
      const saved = await save({ llm_model_id: model.id })
      if (!saved || !mountedRef.current || action !== modelActionRef.current) return
      await api.llmLoad(model.id)
      if (!mountedRef.current || action !== modelActionRef.current) return
      toast(`正在加载 ${model.file}…`, 'ok')
      const deadline = Date.now() + 30000
      while (mountedRef.current && action === modelActionRef.current && Date.now() < deadline) {
        await waitForModelPoll()
        if (!mountedRef.current || action !== modelActionRef.current) return
        const status = await api.llmStatus().catch(() => null)
        if (!mountedRef.current || action !== modelActionRef.current) return
        if (status && status.state !== 'loading') {
          if (status.error) toast(`加载失败：${status.error.slice(0, 200)}`, 'error')
          void refreshLlm()
          return
        }
      }
      void refreshLlm()
    } catch (reason) {
      if (mountedRef.current && action === modelActionRef.current) {
        toast(errorText(reason, '加载失败'), 'error')
      }
    } finally {
      if (mountedRef.current && action === modelActionRef.current) setModelBusy(null)
    }
  }

  const unloadModel = async () => {
    if (modelBusy) return
    modelWaitRef.current?.finish()
    const action = ++modelActionRef.current
    setModelBusy('unload')
    try {
      await api.llmUnload()
      if (!mountedRef.current || action !== modelActionRef.current) return
      toast('模型已卸载', 'ok')
      void refreshLlm()
    } catch (reason) {
      if (mountedRef.current && action === modelActionRef.current) {
        toast(errorText(reason, '卸载失败'), 'error')
      }
    } finally {
      if (mountedRef.current && action === modelActionRef.current) setModelBusy(null)
    }
  }

  // 数据目录、备份与缓存
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [selectingDir, setSelectingDir] = useState(false)
  const [pendingMigrationDir, setPendingMigrationDir] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    invoke<string>('get_data_dir').then((path) => {
      if (active) setDataDir(path)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const chooseMigrationDir = async () => {
    if (!isTauri()) {
      toast('数据目录迁移仅桌面应用可用', 'error')
      return
    }
    setSelectingDir(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, title: '选择新的数据目录（论文、数据库与模型将整体复制过去）' })
      if (mountedRef.current && typeof dir === 'string' && dir) setPendingMigrationDir(dir)
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '无法选择数据目录'), 'error')
    } finally {
      if (mountedRef.current) setSelectingDir(false)
    }
  }
  const migrateDataDir = async () => {
    if (!pendingMigrationDir || !isTauri()) return
    setMigrating(true)
    try {
      const result = await api.migrateDataDir(pendingMigrationDir)
      if (!mountedRef.current) return
      setDataDir(result.path)
      setPendingMigrationDir(null)
      toast('迁移完成，请重启应用生效', 'ok')
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '迁移失败'), 'error')
    } finally {
      if (mountedRef.current) setMigrating(false)
    }
  }

  const [exporting, setExporting] = useState(false)
  const exportBackup = async () => {
    if (!isTauri()) {
      toast('备份导出仅桌面应用可用', 'error')
      return
    }
    setExporting(true)
    try {
      const blob = await api.backupExport()
      const saved = await saveBlobWithDialog(blob, `paperlens-backup-${new Date().toISOString().slice(0, 10)}.zip`)
      if (saved && mountedRef.current) toast('备份已导出', 'ok')
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '导出失败'), 'error')
    } finally {
      if (mountedRef.current) setExporting(false)
    }
  }

  const zipInput = useRef<HTMLInputElement>(null)
  const [pendingZip, setPendingZip] = useState<File | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importReport, setImportReport] = useState<string[] | null>(null)
  const doImport = async () => {
    if (!pendingZip) return
    setImportBusy(true)
    try {
      const result = await api.backupImport(pendingZip)
      if (!mountedRef.current) return
      setImportReport(result.report?.length ? result.report : ['导入完成（无详细报告）'])
      setPendingZip(null)
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '导入失败'), 'error')
    } finally {
      if (mountedRef.current) setImportBusy(false)
    }
  }

  const [cacheBusy, setCacheBusy] = useState<'ocr' | 'translate' | null>(null)
  const clearCache = async (type: 'ocr' | 'translate') => {
    if (cacheBusy) return
    setCacheBusy(type)
    try {
      const result = await api.clearCache(type)
      if (!mountedRef.current) return
      toast(`已清理${type === 'ocr' ? ' OCR' : '翻译'}缓存${result.freed_bytes > 0 ? `，释放 ${fmtSize(result.freed_bytes)}` : ''}`, 'ok')
    } catch (reason) {
      if (mountedRef.current) toast(errorText(reason, '清理失败'), 'error')
    } finally {
      if (mountedRef.current) setCacheBusy(null)
    }
  }

  const update = updater.update
  const updatePercent = updater.progress?.total
    ? Math.min(100, (updater.progress.downloaded / updater.progress.total) * 100)
    : null
  const lastCheckText = updater.lastCheckAt
    ? new Date(updater.lastCheckAt).toLocaleString('zh-CN', { hour12: false })
    : '尚未检查'

  let engineBadge = <span className="pnx-badge">未加载</span>
  if (!llmStatus) {
    engineBadge = <span className="pnx-badge">检测中…</span>
  } else if (llmStatus.state === 'ready') {
    engineBadge = (
      <span className="pnx-badge pnx-badge-ok">
        就绪{llmStatus.rss_mb != null ? ` · ${Math.round(llmStatus.rss_mb)} MB` : ''}
        {llmStatus.model_id ? ` · ${llmStatus.model_id}` : ''}
      </span>
    )
  } else if (llmStatus.state === 'loading') {
    engineBadge = <span className="pnx-badge pnx-badge-accent"><span className="pnx-spinner" aria-hidden />加载中</span>
  } else if (llmStatus.error) {
    engineBadge = <span className="pnx-badge pnx-badge-danger" data-testid="llm-error-badge">加载失败</span>
  }

  return (
    <div className="pnx-root pnx-settings">
      <div className="pnx-settings-canvas">
        <header className="pnx-settings-hero">
          <div>
            <span className="pnx-eyebrow">PAPERLENS · PREFERENCES</span>
            <h1>设置</h1>
            <p>调整阅读环境、管理本地模型，并掌控你的数据。</p>
          </div>
          <div className="pnx-save-state" role="status" aria-live="polite">
            <span className={`pnx-save-dot${pendingSaves > 0 ? ' pnx-save-dot-busy' : ''}`} aria-hidden />
            {pendingSaves > 0 ? '正在保存设置…' : '所有设置即改即存'}
          </div>
        </header>

        <div className="pnx-settings-layout">
          <nav className="pnx-settings-nav" aria-label="设置分区">
            <span className="pnx-nav-caption">本页目录</span>
            {NAV_ITEMS.map(([id, label], index) => (
              <a key={id} href={`#${id}`} className="pnx-settings-nav-link">
                <span aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                {label}
              </a>
            ))}
            <p>PaperLens<br />v{updater.currentVersion}</p>
          </nav>

          <main className="pnx-settings-sections">
            <Section id="pnx-account" index="01" title="账号" description="本机账号与个人信息" wide>
              <div className="pnx-account-card">
                <div className="pnx-account-avatar" aria-hidden>
                  {(user?.display_name ?? user?.username ?? '我').slice(0, 1).toUpperCase()}
                </div>
                <div className="pnx-account-identity">
                  <strong>{user?.display_name ?? user?.username ?? '未登录'}</strong>
                  <span>@{user?.username ?? 'unknown'} · 登录凭据不可修改</span>
                </div>
                {!editingName ? (
                  <button
                    type="button"
                    className="pnx-button"
                    onClick={() => {
                      setNameInput(user?.display_name ?? '')
                      setEditingName(true)
                    }}
                  >
                    <IconPencil size={13} />编辑展示名
                  </button>
                ) : (
                  <form
                    className="pnx-name-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveDisplayName()
                    }}
                  >
                    <label className="pnx-sr-only" htmlFor="pnx-display-name">展示名</label>
                    <input
                      id="pnx-display-name"
                      className="pnx-input"
                      value={nameInput}
                      autoFocus
                      maxLength={30}
                      disabled={nameBusy}
                      onChange={(event) => setNameInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditingName(false)
                      }}
                    />
                    <button type="submit" className="pnx-button pnx-button-primary" disabled={nameBusy}>
                      {nameBusy ? '保存中…' : '保存'}
                    </button>
                    <button type="button" className="pnx-icon-button" aria-label="取消编辑展示名" title="取消" disabled={nameBusy} onClick={() => setEditingName(false)}>
                      <IconX size={13} />
                    </button>
                  </form>
                )}
              </div>
              <div className="pnx-account-footer">
                <div>
                  <strong>退出当前账号</strong>
                  <span>清除本机登录态，未保存的 Markdown 修改会先请求确认。</span>
                </div>
                <button type="button" className="pnx-button pnx-button-danger" onClick={onLogout}>退出登录</button>
              </div>
            </Section>

            <Section id="pnx-appearance" index="02" title="外观" description="主题、排版与界面呈现" wide>
              <div className="pnx-control-block">
                <div className="pnx-control-heading">
                  <strong>主题</strong>
                  <span>六种阅读氛围，跟随全局主题变量即时切换</span>
                </div>
                <div className="pnx-theme-grid" role="group" aria-label="主题">
                  {THEMES.map((theme) => {
                    const selected = settings.theme === theme.key
                    return (
                      <button
                        type="button"
                        key={theme.key}
                        className={`pnx-theme-option${selected ? ' pnx-option-selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => void save({ theme: theme.key })}
                      >
                        <span className="pnx-theme-preview" aria-hidden>
                          {theme.colors.map((color, index) => (
                            <span key={color + index} style={{ background: index === 2 ? 'transparent' : color }}>
                              {index === 2 && <i style={{ background: color }} />}
                            </span>
                          ))}
                        </span>
                        <span>{theme.label}</span>
                        {selected && <IconCheck size={13} />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="pnx-appearance-grid">
                <div className="pnx-control-block">
                  <Row label="界面字号" hint="拖动即时预览，停止后自动保存">
                    <div className="pnx-range-wrap">
                      <input
                        type="range"
                        min={0.85}
                        max={1.3}
                        step={0.05}
                        value={fontScale}
                        className="pnx-range"
                        aria-label="界面字号"
                        aria-valuetext={`${fontScale.toFixed(2)} 倍`}
                        onChange={(event) => setFontScale(Number(event.target.value))}
                      />
                      <output className="pnx-range-value">{fontScale.toFixed(2)}×</output>
                    </div>
                  </Row>
                  <Row label="界面动效" hint="关闭后禁用界面过渡与动画">
                    <Toggle checked={settings.animations} label="界面动效" onChange={(value) => void save({ animations: value })} />
                  </Row>
                </div>

                <div className="pnx-control-block">
                  <div className="pnx-control-heading">
                    <strong>界面风格</strong>
                    <span>切换前自动保存阅读进度，并保护未保存的 Markdown</span>
                  </div>
                  <div className="pnx-segment" role="group" aria-label="界面风格">
                    {(['next', 'classic'] as const).map((style) => (
                      <button
                        type="button"
                        key={style}
                        className={frontendStyle === style ? 'pnx-segment-active' : ''}
                        aria-pressed={frontendStyle === style}
                        onClick={() => requestFrontendStyle(style)}
                      >
                        {style === 'next' ? '层析界面' : '经典界面'}
                      </button>
                    ))}
                  </div>
                  <p className="pnx-inline-note">当前：{frontendStyle === 'next' ? '层析界面（STRATA）' : '经典界面（Classic）'}</p>
                </div>
              </div>

              <div className="pnx-control-block">
                <div className="pnx-control-heading">
                  <strong>应用图标</strong>
                  <span>桌面快捷方式与窗口图标同步更新；任务栏固定图标需重新固定</span>
                </div>
                <div className="pnx-icon-grid" role="group" aria-label="应用图标">
                  {(['orbit', 'diamond'] as const).map((variant) => {
                    const selected = settings.app_icon === variant
                    return (
                      <button
                        type="button"
                        key={variant}
                        className={`pnx-icon-option${selected ? ' pnx-option-selected' : ''}`}
                        aria-pressed={selected}
                        onClick={async () => {
                          const saved = await save({ app_icon: variant as AppIconVariant })
                          if (!saved) return
                          persistAppIconLocal(variant)
                          if (!isTauri()) return
                          try {
                            await invoke('set_app_icon', { variant })
                          } catch {
                            // 设置已保存；原生图标刷新失败不影响下次启动。
                          }
                        }}
                      >
                        <img src={APP_ICONS[variant]} alt="" />
                        <span>{variant === 'orbit' ? '环日 · ORBIT' : '墨方 · DIAMOND'}</span>
                        {selected && <IconCheck size={13} />}
                      </button>
                    )
                  })}
                </div>
              </div>
            </Section>

            <Section id="pnx-highlight" index="03" title="生词高亮" description="让词汇积累自然发生在阅读中">
              <Row label="正文高亮生词" hint="在阅读正文中标记生词库词汇">
                <Toggle checked={settings.highlight_enabled} label="正文高亮生词" onChange={(value) => void save({ highlight_enabled: value })} />
              </Row>
              <div className="pnx-control-block">
                <div className="pnx-control-heading"><strong>高亮强度</strong><span>弱 / 中 / 强三档</span></div>
                <div className="pnx-segment" role="group" aria-label="高亮强度">
                  {([1, 2, 3] as const).map((strength) => (
                    <button
                      type="button"
                      key={strength}
                      className={settings.highlight_style === strength ? 'pnx-segment-active' : ''}
                      aria-pressed={settings.highlight_style === strength}
                      onClick={() => void save({ highlight_style: strength })}
                    >
                      {['弱', '中', '强'][strength - 1]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pnx-highlight-preview" aria-label="生词高亮预览">
                预览：The <span className={`pnx-word-new pnx-highlight-level-${settings.highlight_style}`}>attention</span> mechanism and{' '}
                <span className={`pnx-word-learning pnx-highlight-level-${settings.highlight_style}`}>gradient</span> descent…
                <span className="pnx-word-known"> convergence</span>
              </div>
              <Row label="仅标注当前论文出现过的词" hint="减少跨文献生词带来的视觉噪音">
                <Toggle
                  checked={settings.highlight_only_current_paper}
                  label="仅标注当前论文出现过的词"
                  onChange={(value) => void save({ highlight_only_current_paper: value })}
                />
              </Row>
            </Section>

            <Section id="pnx-annotation" index="04" title="批注" description="设定每次划词高亮的起点">
              <div className="pnx-control-block">
                <div className="pnx-control-heading"><strong>默认高亮颜色</strong><span>阅读器中仍可随时更换</span></div>
                <div className="pnx-color-list" role="group" aria-label="默认高亮颜色">
                  {ANNOTATION_COLORS.map((color) => (
                    <button
                      type="button"
                      key={color.key}
                      className={`pnx-color-option${settings.annotation_default_color === color.key ? ' pnx-color-selected' : ''}`}
                      aria-label={`${color.label}色`}
                      aria-pressed={settings.annotation_default_color === color.key}
                      title={`${color.label}色`}
                      onClick={() => void save({ annotation_default_color: color.key })}
                    >
                      <span style={{ background: color.css }} aria-hidden />
                    </button>
                  ))}
                </div>
              </div>
              <p className="pnx-inline-note">默认色用于新建高亮，不会改动已有批注。</p>
            </Section>

            <Section id="pnx-models" index="05" title="LLM 模型管理" description="本地推理引擎、模型下载与内存策略" wide>
              <div className="pnx-engine-bar">
                <div>
                  <strong>引擎状态</strong>
                  <span>模型状态每 5 秒自动同步</span>
                </div>
                <div role="status" aria-live="polite">{engineBadge}</div>
              </div>
              {llmStatus?.state === 'unloaded' && llmStatus.error && (
                <div className="pnx-error-box" role="alert" data-testid="llm-error">加载失败：{llmStatus.error.slice(0, 300)}</div>
              )}

              <div className="pnx-model-list">
                {models.length === 0 && (
                  <div className="pnx-empty-state">
                    <strong>还没有可用模型</strong>
                    <span>导入本地 GGUF 文件，或下载推荐模型开始使用。</span>
                  </div>
                )}
                {models.map((model) => {
                  const isDefault = settings.llm_model_id === model.id
                  const isActive = llmStatus?.model_id === model.id && llmStatus.state !== 'unloaded'
                  return (
                    <article key={model.id} className={`pnx-model-card${isDefault ? ' pnx-model-default' : ''}`}>
                      <div className="pnx-model-main">
                        <div className="pnx-model-title">
                          <strong>{model.file}</strong>
                          <div className="pnx-badge-list">
                            <span className="pnx-badge">{fmtSize(model.size_bytes)}</span>
                            <span className="pnx-badge">{model.builtin ? '推荐' : '已导入'}</span>
                            {isDefault && <span className="pnx-badge pnx-badge-accent">默认</span>}
                            {isActive && (
                              <span className="pnx-badge pnx-badge-ok">{llmStatus?.state === 'loading' ? '加载中…' : '已加载'}</span>
                            )}
                          </div>
                        </div>
                        <div className="pnx-model-actions">
                          {model.downloaded ? (
                            <>
                              {!isDefault && (
                                <button type="button" className="pnx-button" onClick={() => void save({ llm_model_id: model.id })}>设为默认</button>
                              )}
                              {isActive ? (
                                <button type="button" className="pnx-button" disabled={modelBusy !== null} onClick={() => void unloadModel()}>
                                  {modelBusy === 'unload' ? '卸载中…' : '卸载'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="pnx-button pnx-button-primary"
                                  disabled={llmStatus?.state === 'loading' || modelBusy !== null}
                                  onClick={() => void loadModel(model)}
                                >
                                  {modelBusy === model.id ? '加载中…' : '加载'}
                                </button>
                              )}
                            </>
                          ) : (
                            <button type="button" className="pnx-button" disabled={Boolean(downloading)} onClick={() => void downloadModel(model)}>
                              {downloading === model.id ? '下载中…' : '下载'}
                            </button>
                          )}
                        </div>
                      </div>
                      {downloading === model.id && dlProgress && (
                        <div className="pnx-download-progress">
                          <div
                            className="pnx-progress-track"
                            role="progressbar"
                            aria-label={`下载 ${model.file}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={dlProgress.percent ?? undefined}
                          >
                            <span style={{ width: `${Math.max(0, Math.min(100, dlProgress.percent ?? 0))}%` }} />
                          </div>
                          <div className="pnx-progress-copy" role="status">
                            <span>{dlProgress.percent != null ? `${dlProgress.percent.toFixed(1)}%` : '下载中…'}</span>
                            <span>
                              {dlProgress.total > 0 ? `${fmtSize(dlProgress.downloaded)} / ${fmtSize(dlProgress.total)} · ` : ''}
                              ModelScope 优先 · 断点续传
                            </span>
                          </div>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>

              <div className="pnx-model-footer">
                <input
                  ref={ggufInput}
                  type="file"
                  accept=".gguf"
                  className="pnx-file-input"
                  aria-label="选择 GGUF 模型文件"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void importModel(file)
                    event.target.value = ''
                  }}
                />
                <button type="button" className="pnx-button" onClick={() => ggufInput.current?.click()} disabled={importing || Boolean(downloading)}>
                  {importing ? '导入中…' : '导入 GGUF'}
                </button>
                <span>复制到数据目录 models/ 下即可被识别</span>
              </div>
              <div className="pnx-strategy-row">
                <Row label="加载策略" hint="模型空闲后的内存回收策略">
                  <div className="pnx-segment" role="group" aria-label="模型加载策略">
                    {([0, 10, -1] as const).map((unloadPolicy) => (
                      <button
                        type="button"
                        key={unloadPolicy}
                        className={settings.llm_unload_policy === unloadPolicy ? 'pnx-segment-active' : ''}
                        aria-pressed={settings.llm_unload_policy === unloadPolicy}
                        onClick={() => void save({ llm_unload_policy: unloadPolicy })}
                      >
                        {unloadPolicy === 0 ? '用完即卸' : unloadPolicy === 10 ? '空闲 10 分钟' : '常驻'}
                      </button>
                    ))}
                  </div>
                </Row>
              </div>
            </Section>

            <Section id="pnx-dictionary" index="06" title="词典" description="离线查词，无需等待网络">
              <div className="pnx-dictionary-card">
                <div className="pnx-dictionary-icon"><IconBook size={22} /></div>
                <div>
                  <strong>ECDICT 英汉词典</strong>
                  <span>本地预置 · 约 340 万词条</span>
                  <p>毫秒级离线查询，含基于 BNC 语料生成的词形还原库。</p>
                </div>
              </div>
            </Section>

            <Section id="pnx-association" index="07" title="文件关联" description="双击文档，直接进入阅读">
              {!desktop && <p className="pnx-desktop-note">文件关联仅在桌面应用中可用。</p>}
              <Row label="设为 PDF 默认打开方式" hint="双击 PDF 默认用 PaperLens 打开并收进文库，图标保持 PDF 样式">
                <Toggle checked={pdfAssoc} label="设为 PDF 默认打开方式" disabled={!desktop || assocBusy} onChange={() => void toggleAssoc('pdf')} />
              </Row>
              <Row label="设为 Markdown 默认打开方式" hint="双击 .md 文件默认用 PaperLens 打开并收进文库">
                <Toggle checked={mdAssoc} label="设为 Markdown 默认打开方式" disabled={!desktop || assocBusy} onChange={() => void toggleAssoc('md')} />
              </Row>
              <Row label="关联打开时保存到文库" hint="关闭后仅临时阅读，不进文库与统计；关闭页签即清除，生词库保留">
                <Toggle checked={settings.assoc_open_save} label="关联打开时保存到文库" onChange={(value) => void save({ assoc_open_save: value })} />
              </Row>
            </Section>

            <Section id="pnx-data" index="08" title="数据与备份" description="迁移存储位置、恢复数据与释放空间" wide>
              <div className="pnx-data-grid">
                <div className="pnx-data-path">
                  <span>当前数据目录</span>
                  <strong title={dataDir ?? undefined}>{dataDir ?? '由后端管理'}</strong>
                  <p>论文、数据库与模型文件统一存放在此目录。</p>
                </div>
                <button type="button" className="pnx-button" onClick={() => void chooseMigrationDir()} disabled={!desktop || selectingDir || migrating}>
                  {selectingDir ? '选择中…' : migrating ? '迁移中…' : '迁移数据目录'}
                </button>
              </div>

              <div className="pnx-data-actions">
                <div className="pnx-data-action">
                  <div><strong>备份导出</strong><span>导出全部账号数据与 PDF 文件为 zip，可在新装机恢复</span></div>
                  <button type="button" className="pnx-button" onClick={() => void exportBackup()} disabled={!desktop || exporting}>
                    {exporting ? '导出中…' : '导出备份'}
                  </button>
                </div>
                <div className="pnx-data-action">
                  <div><strong>备份导入</strong><span>导入备份 zip；已有数据不变，同名账号自动加后缀</span></div>
                  <button type="button" className="pnx-button" onClick={() => zipInput.current?.click()} disabled={importBusy}>导入备份</button>
                </div>
                <div className="pnx-data-action">
                  <div><strong>清理 OCR 缓存</strong><span>删除所有论文的 OCR 解析结果（blocks 文件）</span></div>
                  <button type="button" className="pnx-button" onClick={() => void clearCache('ocr')} disabled={cacheBusy !== null}>
                    {cacheBusy === 'ocr' ? '清理中…' : '清理缓存'}
                  </button>
                </div>
                <div className="pnx-data-action">
                  <div><strong>清理翻译缓存</strong><span>清空 LLM 翻译缓存表，词典与词库不受影响</span></div>
                  <button type="button" className="pnx-button" onClick={() => void clearCache('translate')} disabled={cacheBusy !== null}>
                    {cacheBusy === 'translate' ? '清理中…' : '清理缓存'}
                  </button>
                </div>
              </div>
            </Section>

            <Section id="pnx-update" index="09" title="应用更新" description="版本状态与更新策略" wide>
              <div className="pnx-update-overview">
                <div className="pnx-version-card">
                  <span>当前版本</span>
                  <strong>v{updater.currentVersion}</strong>
                  <small>{desktop ? '桌面更新通道已连接' : '浏览器开发模式 · 更新功能仅桌面应用可用'}</small>
                </div>
                <div className="pnx-update-controls">
                  <div className="pnx-control-heading"><strong>更新策略</strong><span>自动下载完成后会提示重启安装</span></div>
                  <div className="pnx-segment" role="group" aria-label="更新策略">
                    {UPDATE_POLICIES.map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        className={policy === item.key ? 'pnx-segment-active' : ''}
                        aria-pressed={policy === item.key}
                        onClick={() => setPolicy(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="pnx-check-row">
                    <div>
                      <strong>检查更新</strong>
                      <span>上次检查：{lastCheckText}{updater.error ? ` · 上次失败：${updater.error}` : ''}</span>
                    </div>
                    <button
                      type="button"
                      className="pnx-button"
                      onClick={() => void check({ manual: true })}
                      disabled={!desktop || phase === 'checking' || phase === 'downloading'}
                    >
                      {phase === 'checking' ? '检查中…' : '检查更新'}
                    </button>
                  </div>
                </div>
              </div>

              {update && (
                <div className={`pnx-update-card${phase === 'available' || phase === 'ready' || phase === 'error' ? ' pnx-update-card-active' : ''}`}>
                  <div className="pnx-update-card-header">
                    <div>
                      <strong>v{updater.currentVersion} <span aria-hidden>→</span> v{update.version}</strong>
                      <div className="pnx-badge-list">
                        {phase === 'available' && <span className="pnx-badge pnx-badge-accent">有新版本</span>}
                        {phase === 'downloading' && <span className="pnx-badge pnx-badge-accent">下载中…</span>}
                        {phase === 'ready' && <span className="pnx-badge pnx-badge-ok">已就绪</span>}
                        {phase === 'error' && <span className="pnx-badge pnx-badge-danger">下载失败</span>}
                      </div>
                    </div>
                    <div className="pnx-model-actions">
                      {phase === 'available' && (
                        <button type="button" className="pnx-button pnx-button-primary" onClick={() => setDialogOpen(true)}>查看并更新</button>
                      )}
                      {phase === 'error' && <button type="button" className="pnx-button" onClick={() => void download()}>重试下载</button>}
                      {phase === 'ready' && <button type="button" className="pnx-button pnx-button-primary" onClick={() => void install()}>重启并安装</button>}
                    </div>
                  </div>
                  {phase === 'downloading' && (
                    <div className="pnx-download-progress">
                      <div
                        className="pnx-progress-track"
                        role="progressbar"
                        aria-label="下载应用更新"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={updatePercent ?? undefined}
                      >
                        <span style={{ width: `${Math.max(0, updatePercent ?? 0)}%` }} />
                      </div>
                      <div className="pnx-progress-copy" role="status">
                        <span>{updatePercent != null ? `${updatePercent.toFixed(1)}%` : '下载中…'}</span>
                        {updater.progress?.total ? <span>{fmtSize(updater.progress.downloaded)} / {fmtSize(updater.progress.total)}</span> : <span>正在获取更新包</span>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Section>

            <Section id="pnx-shortcuts" index="10" title="快捷键" description="V1 固定快捷键与生效条件" wide>
              <div className="pnx-table-wrap">
                <table className="pnx-shortcut-table">
                  <caption className="pnx-sr-only">PaperLens 固定快捷键</caption>
                  <thead>
                    <tr><th scope="col">按键</th><th scope="col">动作</th><th scope="col">生效条件</th></tr>
                  </thead>
                  <tbody>
                    {SHORTCUTS.map(([key, action, condition]) => (
                      <tr key={key}>
                        <td><kbd>{key}</kbd></td>
                        <td>{action}</td>
                        <td>{condition}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <footer className="pnx-settings-footer">
              <span>{pendingSaves > 0 ? '保存中…' : '设置即改即存'}</span>
              <span>PaperLens v{updater.currentVersion}</span>
            </footer>
          </main>
        </div>
      </div>

      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        className="pnx-file-input"
        aria-label="选择备份 zip 文件"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) setPendingZip(file)
          event.target.value = ''
        }}
      />

      <ConfirmModal
        open={Boolean(pendingZip)}
        title="导入备份"
        confirmText="开始导入"
        busy={importBusy}
        onClose={() => {
          if (!importBusy) setPendingZip(null)
        }}
        onConfirm={() => void doImport()}
      >
        <div className="pnx-modal-copy">
          <p>将导入备份文件「{pendingZip?.name}」（{pendingZip ? fmtSize(pendingZip.size) : ''}）。</p>
          <span>已有账号数据保持不变；同名账号将自动加后缀改名。</span>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={Boolean(pendingMigrationDir)}
        title="迁移数据目录"
        confirmText="开始迁移"
        busy={migrating}
        onClose={() => {
          if (!migrating) setPendingMigrationDir(null)
        }}
        onConfirm={() => void migrateDataDir()}
      >
        <div className="pnx-modal-copy">
          <p>将把论文、数据库与模型整体迁移到：</p>
          <strong>{pendingMigrationDir}</strong>
          <span>迁移完成后需要重启应用生效。旧目录不会被删除，确认后可手动清理。</span>
        </div>
      </ConfirmModal>

      <Modal open={Boolean(importReport)} title="备份导入报告" onClose={() => setImportReport(null)} width={460}>
        <ul className="pnx-report-list">
          {importReport?.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
        </ul>
      </Modal>

      <Modal open={chooseExt !== null && desktop} title="默认打开方式未生效" onClose={closeChooseModal} width={430}>
        <div className="pnx-modal-copy">
          <p>PaperLens 已注册打开方式，但系统默认仍指向其他应用（新版 Windows 会拦截应用直改默认）。</p>
          <span>推荐「选择打开方式」：在系统选择框中选中 PaperLens 并勾选「始终」，即可完成默认设置。</span>
          <div className="pnx-modal-actions">
            <button type="button" className="pnx-button pnx-button-primary" onClick={() => void runOpenWith()}>选择打开方式</button>
            <button type="button" className="pnx-button" onClick={runOpenSettings}>打开系统设置</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
