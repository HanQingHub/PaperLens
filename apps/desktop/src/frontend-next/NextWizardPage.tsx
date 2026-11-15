import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { api, llmDownloadStream } from '../api/client'
import type { LLMModelInfo } from '../api/types'
import { useAuth } from '../stores/auth'
import { IconBook, IconCheck, IconPlus, IconSpark } from '../components/shared/Icon'
import { toast } from '../features/shared/Toast'
import './NextWizardPage.css'

const MODEL_DESC: Record<string, string> = {
  'qwen3.5-2b-q4km': '默认推荐 · 语境翻译质量最佳（约 1.19 GiB）',
  'qwen3.5-0.8b-q4km': '提速档 · 更小更快，适合低配机器（约 508 MiB）',
}

const STEPS = ['安顿书房', '准备模型', '开始阅读']

type DownloadProgress = {
  percent: number | null
  downloaded: number
  total: number
}

function fmtSize(bytes: number) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MiB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback
}

export default function NextWizardPage() {
  const navigate = useNavigate()
  const { updateSettings } = useAuth()
  const [step, setStep] = useState(1)
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  const [choosingDir, setChoosingDir] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [models, setModels] = useState<LLMModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [loadingModel, setLoadingModel] = useState<string | null>(null)
  const [loadedModel, setLoadedModel] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const modelRequest = useRef(0)
  const downloadAbort = useRef<AbortController | null>(null)
  const desktop = isTauri()

  useEffect(() => {
    mounted.current = true
    try {
      if (localStorage.getItem('pl_wizard_done') === '1') navigate('/', { replace: true })
    } catch {
      // 存储不可用时仍允许完成本次初始化。
    }
    return () => {
      mounted.current = false
      modelRequest.current += 1
      downloadAbort.current?.abort()
      downloadAbort.current = null
    }
  }, [navigate])

  useEffect(() => {
    if (!isTauri()) return
    let active = true
    invoke<string>('get_data_dir')
      .then((path) => {
        if (active) setDataDir(path)
      })
      .catch(() => {
        // 浏览器预览或命令不可用时，由后端继续管理默认目录。
      })
    return () => {
      active = false
    }
  }, [])

  const loadModels = useCallback(async () => {
    const request = ++modelRequest.current
    setLoadingModels(true)
    setModelError(false)
    try {
      const list = await api.llmModels()
      if (mounted.current && request === modelRequest.current) setModels(list)
    } catch (reason) {
      if (mounted.current && request === modelRequest.current) {
        setModelError(true)
        toast(errorMessage(reason, '模型列表加载失败'), 'error')
      }
    } finally {
      if (mounted.current && request === modelRequest.current) setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    if (step === 2) {
      void loadModels()
      return
    }
    modelRequest.current += 1
    downloadAbort.current?.abort()
    downloadAbort.current = null
    setDownloading(null)
    setProgress(null)
    setLoadingModels(false)
  }, [step, loadModels])

  const chooseDataDir = async () => {
    if (!isTauri() || choosingDir || migrating) return
    setChoosingDir(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        title: '选择 PaperLens 数据目录（论文、数据库与模型将整体复制过去）',
      })
      if (!mounted.current || typeof selected !== 'string' || !selected) return
      if (selected === dataDir) {
        setPendingDir(null)
        toast('所选位置已是当前数据目录')
      } else {
        setPendingDir(selected)
      }
    } catch (reason) {
      if (mounted.current) toast(errorMessage(reason, '无法打开目录选择器'), 'error')
    } finally {
      if (mounted.current) setChoosingDir(false)
    }
  }

  const confirmDataDir = async () => {
    if (!pendingDir) {
      setStep(2)
      return
    }
    setMigrating(true)
    try {
      const result = await api.migrateDataDir(pendingDir)
      if (!mounted.current) return
      setDataDir(result.path)
      setPendingDir(null)
      toast('数据目录迁移完成，重启应用后生效；旧目录未删除', 'ok')
      setStep(2)
    } catch (reason) {
      if (mounted.current) toast(errorMessage(reason, '数据目录迁移失败'), 'error')
    } finally {
      if (mounted.current) setMigrating(false)
    }
  }

  const download = async (model: LLMModelInfo) => {
    if (downloading || importing || loadingModel) return
    downloadAbort.current?.abort()
    const controller = new AbortController()
    downloadAbort.current = controller
    setDownloading(model.id)
    setProgress({ percent: 0, downloaded: 0, total: model.size_bytes })
    try {
      for await (const event of llmDownloadStream(model.id, { signal: controller.signal })) {
        if (!mounted.current || controller.signal.aborted) break
        if (event.event === 'progress') {
          setProgress({
            percent: event.percent,
            downloaded: event.downloaded,
            total: event.total_bytes || model.size_bytes,
          })
        } else if (event.event === 'done') {
          toast(`模型下载完成：${event.file}`, 'ok')
          await loadModels()
        } else if (event.event === 'error') {
          toast(event.detail || '下载失败', 'error')
          break
        }
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        toast(errorMessage(reason, '下载中断'), 'error')
      }
    } finally {
      if (downloadAbort.current === controller) {
        downloadAbort.current = null
        if (mounted.current) {
          setDownloading(null)
          setProgress(null)
        }
      }
    }
  }

  const importGguf = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.gguf')) {
      toast('仅支持 GGUF 格式模型文件', 'error')
      return
    }
    if (importing || downloading || loadingModel) return
    setImporting(true)
    try {
      await api.llmImport(file)
      if (!mounted.current) return
      toast('模型导入成功', 'ok')
      await loadModels()
    } catch (reason) {
      if (mounted.current) toast(errorMessage(reason, '导入失败'), 'error')
    } finally {
      if (mounted.current) setImporting(false)
    }
  }

  const loadAndTry = async (model: LLMModelInfo) => {
    if (loadingModel || downloading || importing) return
    setLoadingModel(model.id)
    try {
      await updateSettings({ llm_model_id: model.id })
      await api.llmLoad(model.id)
      if (!mounted.current) return
      setLoadedModel(model.id)
      toast(`正在后台加载 ${model.file}，就绪后划词翻译将使用该模型`, 'ok')
    } catch (reason) {
      if (mounted.current) toast(errorMessage(reason, '加载失败'), 'error')
    } finally {
      if (mounted.current) setLoadingModel(null)
    }
  }

  const markDone = () => {
    try {
      localStorage.setItem('pl_wizard_done', '1')
    } catch {
      toast('无法保存向导完成状态，下次启动可能再次显示本页', 'error')
    }
  }

  const finish = () => {
    markDone()
    navigate('/', { replace: true })
  }

  const goSettings = () => {
    markDone()
    navigate('/settings')
  }

  const skipModels = () => {
    downloadAbort.current?.abort()
    setStep(3)
  }

  const builtinModels = models.filter((model) => model.builtin)
  const importedModels = models.filter((model) => !model.builtin)
  const shownDir = pendingDir ?? dataDir
  const busy = importing || Boolean(downloading) || Boolean(loadingModel)

  return (
    <div className="pnx-root pnx-wizard">
      <aside className="pnx-wizard-story" aria-label="PaperLens 产品介绍">
        <header className="pnx-wizard-brand">
          <span className="pnx-wizard-brand-mark"><IconBook size={19} /></span>
          <span>PaperLens</span>
        </header>
        <div className="pnx-wizard-story-copy">
          <p className="pnx-eyebrow">你的私人研究书房</p>
          <h1>让每一页阅读，<br />都有迹可循。</h1>
          <p>论文、批注、生词与灵感，收进一间安静的本地书房。</p>
        </div>
        <div className="pnx-cover-scene" aria-hidden="true">
          <div className="pnx-cover-shadow" />
          <div className="pnx-cover-book">
            <span className="pnx-cover-spine" />
            <div className="pnx-cover-topline"><span>PAPERLENS</span><span>VOL. 01</span></div>
            <IconBook size={38} />
            <div className="pnx-cover-title">READ<br />DEEPLY</div>
            <div className="pnx-cover-rule" />
            <span className="pnx-cover-caption">NOTES · WORDS · IDEAS</span>
          </div>
          <div className="pnx-cover-note"><IconSpark size={14} /><span>离线阅读，安静积累</span></div>
        </div>
        <footer className="pnx-wizard-story-foot">数据仅保存在你的设备 · 无需云端</footer>
      </aside>

      <main className="pnx-wizard-main">
        <nav className="pnx-wizard-steps" aria-label="初始化进度">
          <ol>
            {STEPS.map((label, index) => {
              const number = index + 1
              const complete = step > number
              return (
                <li
                  key={label}
                  className={`pnx-wizard-step${step === number ? ' pnx-wizard-step-current' : ''}${complete ? ' pnx-wizard-step-done' : ''}`}
                  aria-current={step === number ? 'step' : undefined}
                >
                  <span className="pnx-wizard-step-number">{complete ? <IconCheck size={13} /> : number}</span>
                  <span>{label}</span>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="pnx-wizard-content" key={step}>
          {step === 1 && (
            <section className="pnx-wizard-panel" aria-labelledby="pnx-directory-title">
              <p className="pnx-eyebrow">01 · 安顿你的文献</p>
              <h2 id="pnx-directory-title">先为收藏选一个家</h2>
              <p className="pnx-wizard-lead">所有内容默认保存在独立数据目录，离线也能阅读、翻译与整理。</p>

              <div className={`pnx-directory-card${pendingDir ? ' pnx-directory-card-pending' : ''}`}>
                <div className="pnx-directory-heading">
                  <span className="pnx-directory-icon"><IconBook size={20} /></span>
                  <div>
                    <h3>数据目录</h3>
                    <p>{pendingDir ? '新目录待确认' : '当前保存位置'}</p>
                  </div>
                  <span className="pnx-status-tag">{pendingDir ? '待迁移' : '本地'}</span>
                </div>
                <div className="pnx-directory-path" title={shownDir ?? undefined}>
                  {shownDir ?? (desktop ? '正在读取数据目录…' : '由应用自动管理')}
                </div>
                <p className="pnx-directory-description">论文、批注、生词、数据库与模型统一存放于此，不会散落在系统其他位置。</p>
                {desktop && (
                  <button className="pnx-button pnx-button-secondary" type="button" onClick={chooseDataDir} disabled={choosingDir || migrating}>
                    <IconPlus size={14} />
                    {choosingDir ? '正在打开选择器…' : pendingDir ? '重新选择目录' : '选择其他目录'}
                  </button>
                )}
              </div>

              {pendingDir ? (
                <p className="pnx-wizard-notice" role="status">确认后将整体复制到新目录，旧目录不会删除；迁移需重启应用后生效。</p>
              ) : (
                <p className="pnx-wizard-notice">推荐 D:\PaperLens；无 D 盘时自动使用 C 盘用户目录。之后也可在设置中迁移。</p>
              )}

              <div className="pnx-wizard-actions pnx-wizard-actions-end">
                <button className="pnx-button pnx-button-primary" type="button" onClick={confirmDataDir} disabled={migrating || choosingDir}>
                  {migrating ? '正在迁移数据…' : pendingDir ? '确认迁移并继续' : '使用此目录，继续'}
                  {!migrating && <span aria-hidden="true">→</span>}
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="pnx-wizard-panel pnx-wizard-models" aria-labelledby="pnx-models-title">
              <p className="pnx-eyebrow">02 · 准备语境翻译</p>
              <h2 id="pnx-models-title">挑选一位本地阅读助手</h2>
              <p className="pnx-wizard-lead">本地 LLM 用于学术语境翻译与词义消歧。不下载也能使用词典、术语表和批注。</p>

              <div className="pnx-model-list-wrap" aria-busy={loadingModels}>
                {loadingModels ? (
                  <div className="pnx-model-empty" role="status"><span className="pnx-loading-mark" aria-hidden="true" />正在整理推荐模型…</div>
                ) : modelError ? (
                  <div className="pnx-model-empty">
                    <p role="alert">暂时未能取得模型列表。</p>
                    <button className="pnx-button pnx-button-secondary" type="button" onClick={() => void loadModels()}>重新加载</button>
                  </div>
                ) : builtinModels.length === 0 ? (
                  <div className="pnx-model-empty">暂无内置推荐模型，可导入已有 GGUF 文件。</div>
                ) : (
                  <ul className="pnx-model-list">
                    {builtinModels.map((model) => {
                      const isDownloading = downloading === model.id
                      const isLoading = loadingModel === model.id
                      return (
                        <li className={`pnx-model-card${model.downloaded ? ' pnx-model-card-ready' : ''}`} key={model.id}>
                          <div className="pnx-model-copy">
                            <div className="pnx-model-name-row">
                              <h3>{model.file}</h3>
                              <span className={`pnx-status-tag${model.downloaded ? ' pnx-status-tag-ready' : ''}`}>{model.downloaded ? '已就绪' : '未下载'}</span>
                            </div>
                            <p>{MODEL_DESC[model.id] ?? '本地 GGUF 模型'} · {fmtSize(model.size_bytes)}</p>
                          </div>
                          <div className="pnx-model-action">
                            {model.downloaded ? (
                              <button className="pnx-button pnx-button-primary" type="button" onClick={() => void loadAndTry(model)} disabled={busy || loadedModel === model.id}>
                                {isLoading ? '正在设置…' : loadedModel === model.id ? '已设为默认' : '设为默认并加载'}
                                {loadedModel === model.id && !isLoading && <IconCheck size={14} />}
                              </button>
                            ) : (
                              <button className="pnx-button pnx-button-secondary" type="button" onClick={() => void download(model)} disabled={busy}>
                                {isDownloading ? '下载中…' : '下载模型'}
                              </button>
                            )}
                          </div>
                          {isDownloading && progress && (
                            <div className="pnx-download-progress">
                              <div
                                className="pnx-progress-track"
                                role="progressbar"
                                aria-label={`${model.file} 下载进度`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={progress.percent ?? undefined}
                              >
                                <span
                                  className={`pnx-progress-fill${progress.percent == null ? ' pnx-progress-fill-indeterminate' : ''}`}
                                  style={progress.percent == null ? undefined : { transform: `scaleX(${Math.max(0, Math.min(100, progress.percent)) / 100})` }}
                                />
                              </div>
                              <div className="pnx-progress-copy">
                                <span>
                                  {progress.percent != null ? `${progress.percent.toFixed(1)}%` : '下载中…'}
                                  {progress.total > 0 && ` · ${fmtSize(progress.downloaded)} / ${fmtSize(progress.total)}`}
                                </span>
                                <span>ModelScope 优先 · 支持断点续传</span>
                              </div>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {importedModels.length > 0 && !loadingModels && (
                <div className="pnx-imported-models">
                  <h3>已导入的模型</h3>
                  <ul>
                    {importedModels.map((model) => (
                      <li key={model.id}>
                        <div><strong>{model.file}</strong><span>{fmtSize(model.size_bytes)}</span></div>
                        <button className="pnx-button pnx-button-quiet" type="button" title="设为默认并加载" onClick={() => void loadAndTry(model)} disabled={busy || loadedModel === model.id}>
                          {loadingModel === model.id ? '正在设置…' : loadedModel === model.id ? '已设为默认' : '使用此模型'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <input
                ref={fileInput}
                className="pnx-file-input"
                type="file"
                accept=".gguf"
                aria-label="选择 GGUF 模型文件"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void importGguf(file)
                }}
              />
              <div className="pnx-wizard-actions pnx-wizard-actions-split">
                <button className="pnx-button pnx-button-secondary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
                  <IconPlus size={14} />{importing ? '正在导入…' : '导入 GGUF'}
                </button>
                <button className="pnx-button pnx-button-ghost" type="button" onClick={skipModels} disabled={importing || Boolean(loadingModel)}>
                  {loadedModel ? '完成配置' : '跳过，稍后在设置中下载'}<span aria-hidden="true">→</span>
                </button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="pnx-wizard-panel pnx-wizard-complete" aria-labelledby="pnx-complete-title">
              <div className="pnx-complete-seal" aria-hidden="true"><IconCheck size={30} /></div>
              <p className="pnx-eyebrow">03 · 书房已经就绪</p>
              <h2 id="pnx-complete-title">从第一篇论文开始</h2>
              <p className="pnx-wizard-lead">上传一篇论文，留下第一段批注。阅读中划词即可翻译、收入生词库，让理解慢慢沉淀。</p>
              <div className="pnx-complete-summary">
                <div><IconCheck size={15} /><span>本地数据目录已确认</span></div>
                <div><IconCheck size={15} /><span>{loadedModel ? '默认翻译模型已保存，将在后台就绪' : '基础词典与术语表可用，模型可稍后配置'}</span></div>
                <div><IconCheck size={15} /><span>文库、阅读与笔记功能已开放</span></div>
              </div>
              <div className="pnx-wizard-actions pnx-wizard-actions-center">
                <button className="pnx-button pnx-button-secondary" type="button" onClick={goSettings}>先去设置</button>
                <button className="pnx-button pnx-button-primary" type="button" onClick={finish}>进入文库<span aria-hidden="true">→</span></button>
              </div>
            </section>
          )}
        </div>
        <footer className="pnx-wizard-main-foot">本地文献 · 离线阅读 · 安静思考</footer>
      </main>
    </div>
  )
}
