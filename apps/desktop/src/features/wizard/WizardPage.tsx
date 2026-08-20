// 首启动向导：欢迎+数据目录 → 模型推荐（下载/导入/跳过）→ 完成
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { LLMModelInfo } from '../../api/types'
import { useAuth } from '../../stores/auth'
import { toast } from '../shared/Toast'

const MODEL_DESC: Record<string, string> = {
  'qwen3.5-2b-q4km': '默认推荐 · 语境翻译质量最佳（约 1.19 GiB）',
  'qwen3.5-0.8b-q4km': '提速档 · 更小更快，适合低配机器（约 508 MiB）',
}

function fmtSize(bytes: number) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MiB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

export default function WizardPage() {
  const navigate = useNavigate()
  const { updateSettings } = useAuth()
  const [step, setStep] = useState(1)
  const [models, setModels] = useState<LLMModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ percent: number | null; downloaded: number; total: number } | null>(null)
  const [importing, setImporting] = useState(false)
  const [loadedModel, setLoadedModel] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // 已完成向导 → 直接进文库
  useEffect(() => {
    if (localStorage.getItem('pl_wizard_done') === '1') navigate('/', { replace: true })
  }, [navigate])

  const loadModels = async () => {
    setLoadingModels(true)
    try {
      setModels(await api.llmModels())
    } catch (e) {
      toast(e instanceof Error ? e.message : '模型列表加载失败', 'error')
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (step === 2) loadModels()
  }, [step])

  const download = async (model: LLMModelInfo) => {
    if (downloading) return
    setDownloading(model.id)
    setProgress({ percent: 0, downloaded: 0, total: model.size_bytes })
    try {
      for await (const ev of api.llmDownloadStream(model.id)) {
        if (ev.event === 'progress') {
          setProgress({ percent: ev.percent, downloaded: ev.downloaded, total: ev.total_bytes || model.size_bytes })
        } else if (ev.event === 'done') {
          toast(`模型下载完成：${ev.file}`, 'ok')
          await loadModels()
        } else if (ev.event === 'error') {
          toast(ev.detail || '下载失败', 'error')
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '下载中断', 'error')
    } finally {
      setDownloading(null)
      setProgress(null)
    }
  }

  const importGguf = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.gguf')) {
      toast('仅支持 GGUF 格式模型文件', 'error')
      return
    }
    setImporting(true)
    try {
      await api.llmImport(file)
      toast('模型导入成功', 'ok')
      await loadModels()
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  const loadAndTry = async (model: LLMModelInfo) => {
    try {
      await updateSettings({ llm_model_id: model.id })
      await api.llmLoad(model.id)
      setLoadedModel(model.id)
      toast(`正在后台加载 ${model.file}，就绪后划词翻译将使用该模型`, 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载失败', 'error')
    }
  }

  const finish = () => {
    localStorage.setItem('pl_wizard_done', '1')
    navigate('/', { replace: true })
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="fade-in w-[560px]">
        {/* 步骤指示 */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {['欢迎', '模型', '完成'].map((label, i) => {
            const n = i + 1
            const state = step === n ? 'cur' : step > n ? 'done' : 'todo'
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`pl-step-dot flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium ${
                    state === 'cur'
                      ? 'pl-step-dot--cur bg-accent text-white'
                      : state === 'done'
                        ? 'bg-accent-soft text-accent'
                        : 'bg-bg-soft text-text-faint'
                  }`}
                >
                  {state === 'done' ? '✓' : n}
                </div>
                <span className={`text-xs transition-colors ${state === 'cur' ? 'text-accent' : 'text-text-faint'}`}>{label}</span>
                {n < 3 && <span className={`pl-step-line mx-1 h-px w-10 bg-border-strong ${step > n ? 'pl-step-line--done' : ''}`} />}
              </div>
            )
          })}
        </div>

        <div className="panel p-7 shadow-[var(--shadow-1)]">
          {step === 1 && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-[var(--shadow-2)]">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  <path d="M9 7h7M9 10.5h7" />
                </svg>
              </div>
              <h1 className="font-serif text-xl font-semibold">欢迎使用 PaperLens</h1>
              <p className="mx-auto mt-2 max-w-[380px] text-[13px] leading-6 text-text-soft">
                学术 PDF 精读 · 离线语境翻译 · 生词沉淀 · 批注摘录。
                <br />
                所有数据保存在本机，完全离线可用。
              </p>

              <div className="mt-5 rounded-lg border border-border bg-panel-soft p-3.5 text-left">
                <div className="mb-1 text-xs font-medium text-text-soft">数据目录</div>
                <p className="text-[12px] leading-5 text-text-faint">
                  论文、批注、生词与模型默认存放于独立数据目录（推荐 <code className="rounded bg-bg-soft px-1">D:\PaperLens</code>，无 D 盘时自动使用
                  C 盘用户目录）。PDF 与模型文件不会写入系统盘其他位置；目录可随时在设置中查看。
                </p>
              </div>

              <button className="btn btn-primary mt-6 px-8" onClick={() => setStep(2)}>
                开始配置
              </button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-[15px] font-medium">选择本地翻译模型</h2>
              <p className="mt-1 text-xs leading-5 text-text-faint">
                内嵌本地 LLM 用于学术语境翻译（词义消歧）。不下载也完全可用——词典与术语表照常工作，可稍后在「设置」中补齐。
              </p>

              <div className="mt-4 flex flex-col gap-3">
                {loadingModels ? (
                  <div className="flex justify-center py-6">
                    <div className="spinner spinner-lg" />
                  </div>
                ) : (
                  models
                    .filter((m) => m.builtin)
                    .map((m) => (
                      <div key={m.id} className={`pl-model-card rounded-lg border p-3.5 ${m.downloaded ? 'border-accent' : 'border-border hover:border-border-strong'}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[13.5px] font-medium">{m.file}</span>
                              {m.downloaded ? (
                                <span className="badge" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>已就绪</span>
                              ) : (
                                <span className="badge">未下载</span>
                              )}
                              {loadedModel === m.id && <span className="badge badge-accent">加载中…</span>}
                            </div>
                            <p className="mt-1 text-[11.5px] text-text-faint">
                              {MODEL_DESC[m.id] ?? '本地 GGUF 模型'} · {fmtSize(m.size_bytes)}
                            </p>
                          </div>
                          {m.downloaded ? (
                            <button className="btn btn-primary shrink-0" onClick={() => loadAndTry(m)}>
                              设为默认并加载
                            </button>
                          ) : (
                            <button className="btn shrink-0" onClick={() => download(m)} disabled={!!downloading}>
                              下载
                            </button>
                          )}
                        </div>

                        {downloading === m.id && progress && (
                          <div className="mt-3">
                            <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft">
                              <div
                                className="pl-progress h-full rounded-full transition-[width] duration-300"
                                style={{ width: `${progress.percent ?? 0}%` }}
                              />
                            </div>
                            <div className="mt-1 flex justify-between text-[11px] text-text-faint">
                              <span>
                                {progress.percent != null ? `${progress.percent.toFixed(1)}%` : '下载中…'}
                                {progress.total > 0 && ` · ${fmtSize(progress.downloaded)} / ${fmtSize(progress.total)}`}
                              </span>
                              <span>ModelScope 优先 · 支持断点续传</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                )}

                {models.some((m) => !m.builtin) && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-[12px] font-medium text-text-soft">已导入的模型</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {models
                        .filter((m) => !m.builtin)
                        .map((m) => (
                          <button key={m.id} className="badge" title="点击设为默认并加载" onClick={() => loadAndTry(m)}>
                            {m.file} · {fmtSize(m.size_bytes)}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>

              <input
                ref={fileInput}
                type="file"
                accept=".gguf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) importGguf(f)
                  e.target.value = ''
                }}
              />
              <div className="mt-5 flex items-center justify-between">
                <button className="btn" onClick={() => fileInput.current?.click()} disabled={importing || !!downloading}>
                  {importing ? '导入中…' : '手动导入 GGUF'}
                </button>
                <button className="btn btn-ghost text-text-faint" onClick={() => setStep(3)}>
                  跳过，稍后在设置中下载 →
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--ok)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <h2 className="text-[15px] font-medium">一切就绪</h2>
              <p className="mt-2 text-[13px] leading-6 text-text-soft">
                上传第一篇论文，开始你的精读之旅。
                <br />
                <span className="text-xs text-text-faint">阅读中划词即可翻译、入生词库、做批注。</span>
              </p>
              <div className="mt-6 flex justify-center gap-3">
                <button className="btn px-6" onClick={() => { localStorage.setItem('pl_wizard_done', '1'); navigate('/settings') }}>
                  去设置
                </button>
                <button className="btn btn-primary px-8" onClick={finish}>
                  进入文库
                </button>
              </div>
            </div>
          )}
        </div>

        {step === 2 && (
          <div className="mt-4 text-center">
            <button className="text-xs text-text-faint hover:text-accent" onClick={() => setStep(3)}>
              先跳过这一步
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
