// 设置页：外观 / 生词高亮 / 批注 / LLM 模型管理 / 词典 / 数据 / 应用更新 / 快捷键
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, downloadBlob } from '../../api/client'
import type { LLMModelInfo, LLMStatus } from '../../api/types'
import { useAuth } from '../../stores/auth'
import { useUpdater, type UpdatePolicy } from '../../stores/updater'
import { updaterAvailable } from '../updater/updaterCore'
import Modal, { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import '../../styles/panels.css'

const THEMES: { key: 'warm' | 'light' | 'dark' | 'system'; label: string; colors: [string, string, string] }[] = [
  { key: 'warm', label: '暖纸', colors: ['#faf7f0', '#ffffff', '#33658a'] },
  { key: 'light', label: '浅色', colors: ['#f5f6f8', '#ffffff', '#33658a'] },
  { key: 'dark', label: '深色', colors: ['#23252a', '#2b2e34', '#7fa6c9'] },
  { key: 'system', label: '跟随系统', colors: ['#f5f6f8', '#2b2e34', '#33658a'] },
]

const ANNO_COLORS: { key: string; label: string; css: string }[] = [
  { key: 'yellow', label: '黄', css: '#ffe08a' },
  { key: 'green', label: '绿', css: '#a8d5a2' },
  { key: 'blue', label: '蓝', css: '#a9d3e8' },
  { key: 'pink', label: '粉', css: '#f5b8c4' },
  { key: 'purple', label: '紫', css: '#c9b6e4' },
]

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

function fmtSize(bytes: number) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MiB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel pl-section p-5">
      <h2 className="mb-4 text-[13.5px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-4 text-text-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`relative h-[20px] w-[36px] rounded-full border transition-colors ${checked ? 'border-accent bg-accent' : 'border-border-strong bg-bg-soft'}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className="pl-toggle-thumb absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow"
        style={{ left: checked ? 18 : 2 }}
      />
    </button>
  )
}

export default function SettingsPage() {
  const { settings, updateSettings } = useAuth()
  const [saving, setSaving] = useState(false)

  // ── 应用更新 ──
  const updater = useUpdater()
  const { phase, policy, setPolicy, check, download, install, setDialogOpen } = updater
  const update = updater.update
  const updatePercent =
    updater.progress && updater.progress.total
      ? Math.min(100, (updater.progress.downloaded / updater.progress.total) * 100)
      : null
  const lastCheckText = updater.lastCheckAt
    ? new Date(updater.lastCheckAt).toLocaleString('zh-CN', { hour12: false })
    : '尚未检查'

  const save = async (patch: Parameters<typeof updateSettings>[0]) => {
    setSaving(true)
    try {
      await updateSettings(patch)
    } catch {
      toast('设置保存失败，已回滚', 'error')
    } finally {
      setSaving(false)
    }
  }

  // 字号滑杆：本地即时预览 + 防抖落库
  const [fontScale, setFontScale] = useState(Number(settings.font_scale) || 1)
  useEffect(() => setFontScale(Number(settings.font_scale) || 1), [settings.font_scale])
  useEffect(() => {
    if (fontScale === settings.font_scale) return
    document.documentElement.style.fontSize = `${14 * fontScale}px`
    const t = setTimeout(() => save({ font_scale: fontScale }), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontScale])

  // ── LLM 状态轮询 ──
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null)
  const [models, setModels] = useState<LLMModelInfo[]>([])
  const refreshLlm = useCallback(async () => {
    try {
      setLlmStatus(await api.llmStatus())
      setModels(await api.llmModels())
    } catch {
      /* 静默 */
    }
  }, [])
  useEffect(() => {
    refreshLlm()
    const t = setInterval(refreshLlm, 5000)
    return () => clearInterval(t)
  }, [refreshLlm])

  const [downloading, setDownloading] = useState<string | null>(null)
  const [dlProgress, setDlProgress] = useState<{ percent: number | null; downloaded: number; total: number } | null>(null)
  const downloadModel = async (m: LLMModelInfo) => {
    if (downloading) return
    setDownloading(m.id)
    setDlProgress({ percent: 0, downloaded: 0, total: m.size_bytes })
    try {
      for await (const ev of api.llmDownloadStream(m.id)) {
        if (ev.event === 'progress') setDlProgress({ percent: ev.percent, downloaded: ev.downloaded, total: ev.total_bytes || m.size_bytes })
        else if (ev.event === 'done') {
          toast(`下载完成：${ev.file}`, 'ok')
          refreshLlm()
        } else if (ev.event === 'error') toast(ev.detail || '下载失败', 'error')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '下载中断', 'error')
    } finally {
      setDownloading(null)
      setDlProgress(null)
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
      toast('模型导入成功', 'ok')
      refreshLlm()
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  const loadModel = async (m: LLMModelInfo) => {
    try {
      await save({ llm_model_id: m.id })
      await api.llmLoad(m.id)
      toast(`正在加载 ${m.file}…`, 'ok')
      refreshLlm()
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载失败', 'error')
    }
  }
  const unloadModel = async () => {
    try {
      await api.llmUnload()
      toast('模型已卸载', 'ok')
      refreshLlm()
    } catch (e) {
      toast(e instanceof Error ? e.message : '卸载失败', 'error')
    }
  }

  // ── 数据：备份 / 缓存 ──
  const [exporting, setExporting] = useState(false)
  const exportBackup = async () => {
    setExporting(true)
    try {
      const blob = await api.backupExport()
      downloadBlob(blob, `paperlens-backup-${new Date().toISOString().slice(0, 10)}.zip`)
      toast('备份已导出', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '导出失败', 'error')
    } finally {
      setExporting(false)
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
      const r = await api.backupImport(pendingZip)
      setImportReport(r.report?.length ? r.report : ['导入完成（无详细报告）'])
      setPendingZip(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setImportBusy(false)
    }
  }

  const clearCache = async (type: 'ocr' | 'translate') => {
    try {
      const r = await api.clearCache(type)
      toast(`已清理${type === 'ocr' ? ' OCR' : '翻译'}缓存${r.freed_bytes > 0 ? `，释放 ${fmtSize(r.freed_bytes)}` : ''}`, 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '清理失败', 'error')
    }
  }

  const statusBadge = () => {
    if (!llmStatus) return <span className="badge">检测中…</span>
    if (llmStatus.state === 'ready')
      return (
        <span className="badge" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
          就绪 · {llmStatus.rss_mb != null ? `${Math.round(llmStatus.rss_mb)} MB` : ''}
          {llmStatus.model_id ? ` · ${llmStatus.model_id}` : ''}
        </span>
      )
    if (llmStatus.state === 'loading')
      return (
        <span className="badge badge-accent">
          <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> 加载中
        </span>
      )
    return <span className="badge">未加载</span>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-6">
        <h1 className="text-base font-semibold">设置</h1>

        {/* 外观 */}
        <Section title="外观">
          <Row label="主题">
            <div className="flex gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-all ${settings.theme === t.key ? 'border-accent shadow-[var(--shadow-1)]' : 'border-border hover:border-border-strong'}`}
                  onClick={() => save({ theme: t.key })}
                  title={t.label}
                >
                  <div className="flex h-7 w-11 overflow-hidden rounded-md border border-border">
                    {t.colors.map((c, i) => (
                      <span key={i} className="h-full flex-1" style={{ background: i === 2 ? 'transparent' : c }}>
                        {i === 2 && <span className="mt-1 mx-auto block h-2 w-2 rounded-full" style={{ background: c }} />}
                      </span>
                    ))}
                  </div>
                  <span className={`text-[10.5px] ${settings.theme === t.key ? 'text-accent' : 'text-text-faint'}`}>{t.label}</span>
                </button>
              ))}
            </div>
          </Row>
          <Row label="界面字号" hint={`${fontScale.toFixed(2)}×`}>
            <input
              type="range"
              min={0.85}
              max={1.3}
              step={0.05}
              value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))}
              className="w-44 accent-[var(--accent)]"
            />
          </Row>
          <Row label="动效" hint="关闭后禁用界面过渡与动画">
            <Toggle checked={settings.animations} onChange={(v) => save({ animations: v })} />
          </Row>
        </Section>

        {/* 生词高亮 */}
        <Section title="生词高亮">
          <Row label="正文高亮生词">
            <Toggle checked={settings.highlight_enabled} onChange={(v) => save({ highlight_enabled: v })} />
          </Row>
          <Row label="高亮强度" hint="三档样式强度（弱 / 中 / 强）">
            <div className="flex gap-1.5">
              {([1, 2, 3] as const).map((s) => (
                <button
                  key={s}
                  className={`rounded-md border px-3 py-1 text-[12px] transition-all ${settings.highlight_style === s ? 'border-accent text-accent' : 'border-border text-text-soft hover:border-border-strong'}`}
                  onClick={() => save({ highlight_style: s })}
                >
                  {['弱', '中', '强'][s - 1]}
                </button>
              ))}
            </div>
          </Row>
          <div className="mt-1 rounded-lg border border-border bg-panel-soft px-3.5 py-2.5 text-[13px] leading-6">
            预览：The <span className={`hl-stage-0 hl-strength-${settings.highlight_style}`}>attention</span> mechanism and{' '}
            <span className={`hl-stage-1 hl-strength-${settings.highlight_style}`}>gradient</span> descent…
            <span className="hl-stage-2"> convergence</span>
          </div>
          <Row label="仅标注当前论文出现过的词" hint="开启后仅高亮本文出现的生词，减少视觉噪音">
            <Toggle checked={settings.highlight_only_current_paper} onChange={(v) => save({ highlight_only_current_paper: v })} />
          </Row>
        </Section>

        {/* 批注 */}
        <Section title="批注">
          <Row label="默认高亮颜色">
            <div className="flex gap-2">
              {ANNO_COLORS.map((c) => (
                <button
                  key={c.key}
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 ${settings.annotation_default_color === c.key ? 'border-accent' : 'border-transparent'}`}
                  onClick={() => save({ annotation_default_color: c.key })}
                  title={c.label}
                >
                  <span className="h-[18px] w-[18px] rounded-full" style={{ background: c.css }} />
                </button>
              ))}
            </div>
          </Row>
        </Section>

        {/* LLM 模型管理 */}
        <Section title="LLM 模型管理">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px]">引擎状态</span>
            {statusBadge()}
          </div>

          <div className="flex flex-col gap-2.5">
            {models.length === 0 && <p className="py-2 text-xs text-text-faint">暂无模型，点击下方「导入 GGUF」或下载推荐模型。</p>}
            {models.map((m) => {
              const isDefault = settings.llm_model_id === m.id
              const isActive = llmStatus?.model_id === m.id && llmStatus.state !== 'unloaded'
              return (
                <div key={m.id} className={`pl-model-card rounded-lg border p-3 ${isDefault ? 'border-accent' : 'border-border'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{m.file}</span>
                    <span className="badge">{fmtSize(m.size_bytes)}</span>
                    {m.builtin ? <span className="badge">推荐</span> : <span className="badge">已导入</span>}
                    {isDefault && <span className="badge badge-accent">默认</span>}
                    {isActive && (
                      <span className="badge" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                        {llmStatus?.state === 'loading' ? '加载中…' : '已加载'}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1.5">
                      {m.downloaded ? (
                        <>
                          {!isDefault && (
                            <button className="btn px-2 py-1 text-xs" onClick={() => save({ llm_model_id: m.id })}>
                              设为默认
                            </button>
                          )}
                          {isActive ? (
                            <button className="btn px-2 py-1 text-xs" onClick={unloadModel}>
                              卸载
                            </button>
                          ) : (
                            <button className="btn btn-primary px-2 py-1 text-xs" onClick={() => loadModel(m)} disabled={llmStatus?.state === 'loading'}>
                              加载
                            </button>
                          )}
                        </>
                      ) : (
                        <button className="btn px-2 py-1 text-xs" onClick={() => downloadModel(m)} disabled={!!downloading}>
                          下载
                        </button>
                      )}
                    </span>
                  </div>
                  {downloading === m.id && dlProgress && (
                    <div className="mt-2.5">
                      <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft">
                        <div className="pl-progress h-full rounded-full transition-[width] duration-300" style={{ width: `${dlProgress.percent ?? 0}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-text-faint">
                        {dlProgress.percent != null ? `${dlProgress.percent.toFixed(1)}%` : '下载中…'}
                        {dlProgress.total > 0 && ` · ${fmtSize(dlProgress.downloaded)} / ${fmtSize(dlProgress.total)}`} · ModelScope 优先 · 断点续传
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <input
                ref={ggufInput}
                type="file"
                accept=".gguf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) importModel(f)
                  e.target.value = ''
                }}
              />
              <button className="btn px-2.5 py-1 text-xs" onClick={() => ggufInput.current?.click()} disabled={importing || !!downloading}>
                {importing ? '导入中…' : '导入 GGUF'}
              </button>
              <span className="text-[11px] text-text-faint">复制到数据目录 models/ 下即可被识别</span>
            </div>
          </div>

          <div className="mt-4 border-t border-border pt-3">
            <Row label="加载策略" hint="模型空闲后的内存回收策略">
              <div className="flex gap-1.5">
                {([0, 10, -1] as const).map((p) => (
                  <button
                    key={p}
                    className={`rounded-md border px-2.5 py-1 text-[12px] transition-all ${settings.llm_unload_policy === p ? 'border-accent text-accent' : 'border-border text-text-soft hover:border-border-strong'}`}
                    onClick={() => save({ llm_unload_policy: p })}
                  >
                    {p === 0 ? '用完即卸' : p === 10 ? '空闲 10 分钟' : '常驻'}
                  </button>
                ))}
              </div>
            </Row>
          </div>
        </Section>

        {/* 词典 */}
        <Section title="词典">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-lg">📖</div>
            <div className="text-[12.5px] leading-5 text-text-soft">
              <div className="text-[13px] text-text">ECDICT 英汉词典（本地预置）</div>
              约 340 万词条 · 毫秒级离线查询 · 含词形还原库（BNC 语料生成）
            </div>
          </div>
        </Section>

        {/* 数据 */}
        <Section title="数据">
          <Row label="数据目录" hint="论文、数据库与模型文件的存放位置（默认 D:\PaperLens，安装时自动选择）">
            <span className="text-[12px] text-text-faint">由后端管理</span>
          </Row>
          <div className="my-2 border-t border-border" />
          <Row label="备份导出" hint="导出 zip（全部账号数据 + PDF 文件），可在新装机导入恢复">
            <button className="btn px-2.5 py-1 text-xs" onClick={exportBackup} disabled={exporting}>
              {exporting ? '导出中…' : '导出备份'}
            </button>
          </Row>
          <Row label="备份导入" hint="导入备份 zip；同名账号自动加后缀改名">
            <button className="btn px-2.5 py-1 text-xs" onClick={() => zipInput.current?.click()}>导入备份</button>
          </Row>
          <div className="my-2 border-t border-border" />
          <Row label="清理 OCR 缓存" hint="删除所有论文的 OCR 解析结果（blocks 文件）">
            <button className="btn px-2.5 py-1 text-xs" onClick={() => clearCache('ocr')}>清理</button>
          </Row>
          <Row label="清理翻译缓存" hint="清空 LLM 翻译缓存表（词典与词库不受影响）">
            <button className="btn px-2.5 py-1 text-xs" onClick={() => clearCache('translate')}>清理</button>
          </Row>
        </Section>

        {/* 应用更新 */}
        <Section title="应用更新">
          <Row label="当前版本" hint={updaterAvailable() ? undefined : '浏览器开发模式（更新功能仅桌面应用可用）'}>
            <span className="text-[12.5px] text-text-soft">v{updater.currentVersion}</span>
          </Row>
          <Row label="更新策略" hint="关闭后仍可手动检查；自动下载完成后会提示重启安装">
            <div className="flex gap-1.5">
              {(['ask', 'auto', 'off'] as const).map((p) => (
                <button
                  key={p}
                  className={`rounded-md border px-2.5 py-1 text-[12px] transition-all ${policy === p ? 'border-accent text-accent' : 'border-border text-text-soft hover:border-border-strong'}`}
                  onClick={() => setPolicy(p as UpdatePolicy)}
                >
                  {p === 'ask' ? '询问' : p === 'auto' ? '自动下载' : '关闭'}
                </button>
              ))}
            </div>
          </Row>
          <Row
            label="检查更新"
            hint={`上次检查：${lastCheckText}${updater.error ? ` · 上次失败：${updater.error}` : ''}`}
          >
            <button
              className="btn px-2.5 py-1 text-xs"
              onClick={() => check({ manual: true })}
              disabled={phase === 'checking' || phase === 'downloading'}
            >
              {phase === 'checking' ? '检查中…' : '检查更新'}
            </button>
          </Row>
          {update && (
            <div className={`mt-2 rounded-lg border p-3 ${phase === 'available' || phase === 'ready' || phase === 'error' ? 'border-accent' : 'border-border'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">v{updater.currentVersion} → v{update.version}</span>
                {phase === 'available' && <span className="badge badge-accent">有新版本</span>}
                {phase === 'downloading' && <span className="badge badge-accent">下载中…</span>}
                {phase === 'ready' && (
                  <span className="badge" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                    已就绪
                  </span>
                )}
                {phase === 'error' && (
                  <span className="badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                    下载失败
                  </span>
                )}
                <span className="ml-auto flex gap-1.5">
                  {phase === 'available' && (
                    <button className="btn btn-primary px-2 py-1 text-xs" onClick={() => { setDialogOpen(true) }}>
                      查看并更新
                    </button>
                  )}
                  {phase === 'error' && (
                    <button className="btn px-2 py-1 text-xs" onClick={download}>
                      重试下载
                    </button>
                  )}
                  {phase === 'ready' && (
                    <button className="btn btn-primary px-2 py-1 text-xs" onClick={install}>
                      重启并安装
                    </button>
                  )}
                </span>
              </div>
              {phase === 'downloading' && (
                <div className="mt-2.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft">
                    <div className="pl-progress h-full rounded-full transition-[width] duration-300" style={{ width: `${updatePercent ?? 0}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-text-faint">
                    {updatePercent != null ? `${updatePercent.toFixed(1)}%` : '下载中…'}
                    {updater.progress?.total ? ` · ${fmtSize(updater.progress.downloaded)} / ${fmtSize(updater.progress.total)}` : ''}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* 快捷键 */}
        <Section title="快捷键（V1 固定）">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] text-text-faint">
                <th className="py-1.5 pr-4 font-normal">按键</th>
                <th className="py-1.5 pr-4 font-normal">动作</th>
                <th className="py-1.5 font-normal">生效条件</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map(([key, action, cond]) => (
                <tr key={key} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-4">
                    <kbd className="pl-kbd">{key}</kbd>
                  </td>
                  <td className="py-1.5 pr-4">{action}</td>
                  <td className="py-1.5 text-text-faint">{cond}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <p className="pb-4 text-center text-[11px] text-text-faint">
          {saving ? '保存中…' : '设置即改即存'} · PaperLens v{updater.currentVersion}
        </p>
      </div>

      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setPendingZip(f)
          e.target.value = ''
        }}
      />
      <ConfirmModal
        open={!!pendingZip}
        title="导入备份"
        confirmText="开始导入"
        busy={importBusy}
        onClose={() => setPendingZip(null)}
        onConfirm={doImport}
      >
        <p className="text-[13px] leading-6">
          将导入备份文件「{pendingZip?.name}」（{pendingZip ? fmtSize(pendingZip.size) : ''}）。
          <br />
          <span className="text-xs text-text-faint">已有账号数据保持不变；同名账号将自动加后缀改名。</span>
        </p>
      </ConfirmModal>
      <Modal open={!!importReport} title="备份导入报告" onClose={() => setImportReport(null)} width={460}>
        <ul className="flex flex-col gap-1.5 text-[12.5px] leading-5">
          {importReport?.map((line, i) => (
            <li key={i} className="rounded bg-panel-soft px-2.5 py-1.5">
              {line}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  )
}
