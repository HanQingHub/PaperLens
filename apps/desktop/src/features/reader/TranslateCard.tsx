// 翻译卡片：四层命中徽标 + LLM 流式打字机 + 句译 + 修正译法 + 入生词
import { useEffect, useRef, useState } from 'react'
import { ssePost, SseTimeoutError } from '../../api/sse'
import { IconCheck, IconHistory, IconPencil, IconPin, IconPlus, IconStar, IconX } from '../../components/shared/Icon'
import { api, addGlossaryTerm } from '../../api/client'
import type { TranslateEvent } from '../../api/types'
import { useReaderBus } from '../../stores/readerBus'
import { useWords } from '../../stores/words'
import { useReader } from '../../stores/readerStore'
import { lemmaCandidates } from './lemma'

interface HistoryItem {
  id: number
  word: string
  sentence: string | null
  mode: string
  result: Record<string, unknown>
  created_at: string
}

export interface TranslateRequest {
  id: number
  /** 翻译目标论文（主窗格 = 路由 pid；对照窗格选区 = 对照论文） */
  paperId: number
  word: string
  sentence: string
  prev: string
  next: string
  /** dict = 仅词典释义（不发 LLM 词卡请求，直查 dictionary） */
  mode: 'word' | 'dict'
  /** 长选区：出卡后自动触发整句翻译 */
  autoSentence?: boolean
  /** 位置（fixed 视口坐标） */
  x: number
  y: number
  below: boolean
}

type CardStatus = 'loading' | 'streaming' | 'done' | 'error'

interface HitInfo {
  layer: 'wordbook' | 'glossary' | 'cache' | 'ecdict' | 'dict'
  translation?: string
  stage?: number
  badge?: string
  term?: string
  pos?: string | null
  phonetic?: string | null
  gloss?: string | null
}

const LAYER_LABEL: Record<HitInfo['layer'], string> = {
  wordbook: '生词库',
  glossary: '本文术语',
  cache: '缓存',
  ecdict: '词典',
  dict: '词典',
}

/** 错误码→固定前端文案（禁用“超时”二字；后端 detail 仅 console.debug 留痕，不直显） */
const ERR_COPY: Record<string, string> = {
  llm_loading_timeout: '模型加载中…正在自动加载',
  llm_timeout: '模型响应较慢，已自动重试',
  interrupted: '模型状态变化，已自动重试',
  llm_empty: '模型暂无有效输出，已自动重试',
  word_invalid: '所选内容无需翻译',
  text_invalid: '所选内容无需翻译',
  text_too_long: '所选内容过长，请缩小范围',
  internal: '服务暂不可用，可重试',
}

/** 可自动重试的模型未就绪类错误码 */
function isLlmNotReady(code: string) {
  return code === 'llm_loading_timeout' || code === 'interrupted' || code === 'llm_timeout' || code === 'llm_empty'
}

/** 从 LLM 分区文本提取【文中意】行（入生词库默认译法） */
function extractTranslation(stream: string, fallback: string) {
  const m = stream.match(/【文中意】\s*([^\n【]+)/)
  if (m) return m[1].trim().slice(0, 80)
  const gloss = stream.match(/【基本义】\s*([^\n【]+)/)
  if (gloss) return gloss[1].trim().slice(0, 80)
  const clean = stream.replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 80) : fallback
}

export default function TranslateCard({
  paperId,
  request,
  onClose,
  onToast,
}: {
  paperId: number
  request: TranslateRequest | null
  onClose: () => void
  onToast: (msg: string) => void
}) {
  const [pinned, setPinned] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[] | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0, below: true })
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [hit, setHit] = useState<HitInfo | null>(null)
  const [streamText, setStreamText] = useState('')
  const [status, setStatus] = useState<CardStatus>('loading')
  const [errorDetail, setErrorDetail] = useState('')
  const [engine, setEngine] = useState('')
  const [sentenceMode, setSentenceMode] = useState(false)
  const [sentenceText, setSentenceText] = useState('')
  const [sentenceStatus, setSentenceStatus] = useState<CardStatus | null>(null)
  const [sentenceError, setSentenceError] = useState('')
  const [fixOpen, setFixOpen] = useState(false)
  const [fixText, setFixText] = useState('')
  const [saved, setSaved] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const sentenceAbortRef = useRef<AbortController | null>(null)
  // LLM 未就绪自动重试计数（word/sentence 共用；request.id 变化置 0；上限 2 次）
  const autoRetriedRef = useRef(0)
  const loadTriggeredRef = useRef(false)
  // 状态镜像 refs：runWordRequest/runSentence 闭包捕获调用时刻旧值，
  // catch（看门狗掐流）需读最新值判定"无任何内容才兜底"，故每 render 同步
  const statusRef = useRef<CardStatus>('loading')
  const streamTextRef = useRef('')
  const sentenceStatusRef = useRef<CardStatus | null>(null)
  const sentenceTextRef = useRef('')
  useEffect(() => {
    statusRef.current = status
  }, [status])
  useEffect(() => {
    streamTextRef.current = streamText
  }, [streamText])
  useEffect(() => {
    sentenceStatusRef.current = sentenceStatus
  }, [sentenceStatus])
  useEffect(() => {
    sentenceTextRef.current = sentenceText
  }, [sentenceText])
      const bumpGlossary = useReaderBus((s) => s.bumpGlossary)
  const stageMap = useWords((s) => s.stageMap)
  const bumpHighlight = useReader((s) => s.bumpHighlight)

  // 位置跟随请求（钉住/拖动后不动）
  useEffect(() => {
    if (request && !pinned && !dragPos && !isDragging) {
      setPos({ x: request.x, y: request.y, below: request.below })
    } else if (request && !pinned && dragPos) {
      // 新请求且未钉住但有拖动位置时，重置为新锚点
      setDragPos(null)
      setPos({ x: request.x, y: request.y, below: request.below })
    }
  }, [request, pinned, dragPos, isDragging])

  // 拖动
  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent) => {
      const x = e.clientX - dragOffset.current.x
      const y = e.clientY - dragOffset.current.y
      const clampedX = Math.min(Math.max(12, x), window.innerWidth - 330)
      const clampedY = Math.min(Math.max(12, y), window.innerHeight - 100)
      setDragPos({ x: clampedX, y: clampedY })
    }
    const onUp = () => setIsDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  const [llmHint, setLlmHint] = useState('')
  useEffect(() => {
    if (status !== 'loading' || !request || request.mode === 'dict') {
      setLlmHint('')
      return
    }
    let cancelled = false
    let elapsed = 0
    const tick = async () => {
      try {
        const st = await api.llmStatus()
        if (cancelled) return
        if (st.state === 'loading') setLlmHint(`模型加载中…（已等待 ${elapsed}s）`)
        else if (st.state === 'unloaded' && elapsed > 5) setLlmHint('模型未加载，将自动加载…')
        else setLlmHint('')
      } catch {
        /* 静默 */
      }
    }
    tick()
    const t = setInterval(() => { elapsed += 2; tick() }, 2000)
    return () => { cancelled = true; clearInterval(t); setLlmHint('') }
  }, [status, request])

  // ── 等待 LLM 就绪后执行重试（word/sentence 共用；signal 取消即停）──
  // 返回 {ready}；未就绪时返回 {ready:false, failMsg} 由调用方落终态 UI。
  const waitLlmReady = async (signal: AbortSignal): Promise<{ ready: boolean; failMsg?: string }> => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (signal.aborted) return { ready: false }
      let st = null
      try {
        st = await api.llmStatus()
      } catch {
        await sleep(800)
        continue
      }
      if (signal.aborted) return { ready: false }
      if (st.state === 'ready') return { ready: true }
      if (st.state === 'loading') {
        await sleep(800)
        continue
      }
      // unloaded：加载失败则终态引导；否则确保触发一次显式加载后继续等
      if (st.error) {
        console.debug('[translate] llm load failed', st.error)
        return { ready: false, failMsg: `模型加载失败：${st.error.slice(0, 200)}，请前往设置查看` }
      }
      if (!loadTriggeredRef.current) {
        loadTriggeredRef.current = true
        try {
          const models = await api.llmModels()
          const dl = models.filter((m) => m.downloaded)
          if (dl.length === 0) return { ready: false, failMsg: '模型未下载，请前往设置 → LLM 模型管理下载' }
          await api.llmLoad(dl[0].id)
        } catch {
          /* 后端 ensure_loaded 已兜底触发，显式加载失败则继续轮询 */
        }
      }
      await sleep(800)
    }
    return { ready: false, failMsg: '模型仍在加载，请稍后重试' }
  }

  // ── 词翻译 SSE 请求（request.id 变化 / 重试时执行）──
  const runWordRequest = (req: NonNullable<TranslateRequest>) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setStatus('loading')
    ;(async () => {
      try {
        const gen = ssePost(
          '/translate/word',
          {
            paper_id: paperId,
            word: req.word,
            sentence: req.sentence,
            prev: req.prev,
            next: req.next,
          },
          { signal: ac.signal },
        )
        for await (const ev of gen as AsyncGenerator<TranslateEvent>) {
          if (ev.event === 'hit') {
            setHit({
              layer: ev.layer,
              translation: ev.data.translation,
              stage: ev.data.stage,
              badge: ev.data.badge,
              term: ev.data.term,
              pos: ev.data.pos ?? null,
              phonetic: ev.data.phonetic ?? null,
              gloss: ev.data.gloss ?? null,
            })
          } else if (ev.event === 'delta') {
            setStatus('streaming')
            setStreamText((t) => t + ev.text)
          } else if (ev.event === 'done') {
            setEngine(ev.engine || '')
            setStatus('done')
          } else if (ev.event === 'error') {
            console.debug('[translate] word error', ev.code, ev.detail)
            if (isLlmNotReady(ev.code) && autoRetriedRef.current < 2 && !ac.signal.aborted) {
              autoRetriedRef.current += 1
              setStatus('loading')
              setLlmHint('模型加载中…正在自动加载')
              void (async () => {
                const r = await waitLlmReady(ac.signal)
                if (ac.signal.aborted) return
                if (r.ready) runWordRequest(req)
                else if (r.failMsg) {
                  setErrorDetail(r.failMsg)
                  setStatus('error')
                }
              })()
              return
            }
            setErrorDetail(ERR_COPY[ev.code] ?? '服务暂不可用，可重试')
            setStatus('error')
          }
        }
      } catch (e) {
        if (ac.signal.aborted && !(e instanceof SseTimeoutError)) return
        if (!ac.signal.aborted) {
          // 看门狗掐断的静默流（loading 且无任何内容）：按未就绪走自动加载，不显示错误；
          // 已有内容则落 error 保留内容（保内容优先）
          if (statusRef.current === 'loading' && !streamTextRef.current && autoRetriedRef.current < 2) {
            autoRetriedRef.current += 1
            setLlmHint('模型加载中…正在自动加载')
            void (async () => {
              const r = await waitLlmReady(ac.signal)
              if (ac.signal.aborted) return
              if (r.ready) runWordRequest(req)
              else if (r.failMsg) {
                setErrorDetail(r.failMsg)
                setStatus('error')
              }
            })()
            return
          }
          setErrorDetail(e instanceof Error ? e.message : '连接中断')
          setStatus((s) => (s === 'done' ? s : 'error'))
        }
      }
    })()
  }

  // ── 主请求（词翻译 SSE / 词典直查）──
  useEffect(() => {
    if (!request) return
    autoRetriedRef.current = 0
    loadTriggeredRef.current = false
    setHit(null)
    setStreamText('')
    setEngine('')
    setSaved(false)
    setErrorDetail('')
    setSentenceMode(false)
    setSentenceText('')
    setSentenceStatus(null)
    setSentenceError('')
    setFixOpen(false)
    abortRef.current?.abort()
    sentenceAbortRef.current?.abort()

    if (request.mode === 'dict') {
      // 词典释义：不发 SSE，直查 dictionary
      setStatus('loading')
      api
        .dictionary(request.word.trim().split(/\s+/)[0] ?? '')
        .then((entry) => {
          setHit({ layer: 'dict', pos: entry.pos, phonetic: entry.phonetic, gloss: entry.translation })
          setStatus('done')
        })
        .catch(() => {
          setHit({ layer: 'dict' })
          setStatus('error')
          setErrorDetail('词典未收录')
        })
      return
    }
    runWordRequest(request)
    if (request.autoSentence) runSentence()
    return () => {
      abortRef.current?.abort()
      sentenceAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  // ── 句译（选句 >6 词自动；或卡片内“译全句”）──
  const runSentence = () => {
    if (!request) return
    setSentenceMode(true)
    setSentenceText('')
    setSentenceStatus('loading')
    setSentenceError('')
    sentenceAbortRef.current?.abort()
    const ac = new AbortController()
    sentenceAbortRef.current = ac
    ;(async () => {
      try {
        const gen = ssePost(
          '/translate/sentence',
          { paper_id: paperId, text: request.sentence, prev: request.prev, next: request.next },
          { signal: ac.signal },
        )
        for await (const ev of gen as AsyncGenerator<TranslateEvent>) {
          if (ev.event === 'hit') {
            setSentenceText(ev.data.translation ?? '')
            setSentenceStatus('done')
          } else if (ev.event === 'delta') {
            setSentenceStatus('streaming')
            setSentenceText((t) => t + ev.text)
          } else if (ev.event === 'done') {
            setSentenceStatus('done')
          } else if (ev.event === 'error') {
            console.debug('[translate] sentence error', ev.code, ev.detail)
            if (isLlmNotReady(ev.code) && autoRetriedRef.current < 2 && !ac.signal.aborted) {
              autoRetriedRef.current += 1
              setSentenceStatus('loading')
              void (async () => {
                const r = await waitLlmReady(ac.signal)
                if (ac.signal.aborted) return
                if (r.ready) runSentence()
                else if (r.failMsg) {
                  setSentenceError(r.failMsg)
                  setSentenceStatus('error')
                }
              })()
              return
            }
            setSentenceError(ERR_COPY[ev.code] ?? '服务暂不可用，可重试')
            setSentenceStatus('error')
          }
        }
      } catch {
        if (!ac.signal.aborted) {
          // 看门狗掐断的静默句译流：无内容才兜底自动加载，有内容落 error 保内容
          if (sentenceStatusRef.current === 'loading' && !sentenceTextRef.current && autoRetriedRef.current < 2) {
            autoRetriedRef.current += 1
            void (async () => {
              const r = await waitLlmReady(ac.signal)
              if (ac.signal.aborted) return
              if (r.ready) runSentence()
              else if (r.failMsg) {
                setSentenceError(r.failMsg)
                setSentenceStatus('error')
              }
            })()
            return
          }
          setSentenceStatus((s) => (s === 'done' ? s : 'error'))
        }
      }
    })()
  }

  if (!request) return null

  // ── 入生词库：lemma 归一 + 卡片当前译法 ──
  const addToWordbook = async () => {
    const word = request.word.trim().split(/\s+/)[0] ?? ''
    if (!word) return
    const exists = lemmaCandidates(word).some((c) => stageMap.has(c))
    const translation = extractTranslation(streamText, hit?.translation ?? '')
    try {
      await api.addWord({
        lemma: word.toLowerCase(),
        translation,
        paper_id: paperId,
        sentence: request.sentence,
        context: `${request.prev} ▸ ${request.next}`.trim(),
      })
      const words = await api.words({ q: word.toLowerCase() })
      const w = words.find((x) => x.lemma === word.toLowerCase())
      if (w) useWords.getState().bump(w)
      bumpHighlight()
      setSaved(true)
      onToast(exists ? `已更新「${word}」译法` : `已加入生词库：${word}`)
    } catch {
      onToast('入词库失败')
    }
  }

  // ── 修正译法 → 术语表 source=user（用户沉淀）──
  const submitFix = async () => {
    const term = request.word.trim()
    if (!term || !fixText.trim()) return
    try {
      await addGlossaryTerm(paperId, term, fixText.trim())
      bumpGlossary()
      setHit((h) => ({ ...(h ?? { layer: 'glossary' }), layer: 'glossary', badge: '本文术语', translation: fixText.trim() }))
      setFixOpen(false)
      onToast('已写入本文术语表（用户修正）')
    } catch {
      onToast('保存术语失败')
    }
  }

  const starKey = `pl_star_${paperId}`
  const starList = () => {
    try {
      return JSON.parse(localStorage.getItem(starKey) ?? '[]') as { word: string; translation: string }[]
    } catch {
      return []
    }
  }
  const starTranslation = () => {
    const translation = extractTranslation(streamText, hit?.translation ?? '')
    if (!translation) return
    const list = starList().filter((x) => x.word !== request.word)
    list.unshift({ word: request.word, translation })
    localStorage.setItem(starKey, JSON.stringify(list.slice(0, 200)))
    onToast('已收藏译法')
  }

  const cardX = dragPos ? dragPos.x : Math.min(Math.max(12, pos.x - 150), window.innerWidth - 330)
  const cardY = dragPos ? dragPos.y : pos.below ? pos.y : Math.max(60, pos.y - 40)

  return (
    <div
      className={`fade-in fixed z-[45] flex max-h-[70vh] w-[320px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel text-[13px] shadow-[var(--shadow-2)] ${pinned ? 'ring-1 ring-accent/30 shadow-md' : ''} ${isDragging ? 'select-none' : ''}`}
      style={{
        left: cardX,
        top: cardY,
        transition: !pinned && !isDragging && !dragPos ? 'left 120ms ease, top 120ms ease' : 'none',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 头部（可拖动） */}
      <div
        className={`flex min-w-0 items-center gap-2 border-b border-border bg-panel-soft px-3 py-2 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          const target = e.target as HTMLElement
          if (target.closest('button')) return
          e.preventDefault()
          e.stopPropagation()
          dragOffset.current = { x: e.clientX - cardX, y: e.clientY - cardY }
          setIsDragging(true)
          if (!pinned) setPinned(true)
          if (!dragPos) setDragPos({ x: cardX, y: cardY })
        }}
      >
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-semibold" title={request.word}>
          {request.word}
        </span>
        {pinned && <span className="shrink-0 text-[10px] text-accent">已钉住</span>}
        {hit?.phonetic && <span className="max-w-28 shrink-0 truncate text-[11px] text-text-faint">/{hit.phonetic}/</span>}
        {hit && (
          <span className={`badge shrink-0 ${hit.layer === 'glossary' ? 'badge-accent' : ''}`}>
            {hit.badge ?? LAYER_LABEL[hit.layer]}
          </span>
        )}
        {engine && engine.startsWith('llm') && status === 'done' && <span className="badge shrink-0">LLM</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            title="查词历史"
            className={`flex items-center rounded px-1.5 py-0.5 text-xs ${historyOpen ? 'bg-accent-soft text-accent' : 'text-text-faint hover:text-accent'}`}
            onClick={async () => {
              const next = !historyOpen
              setHistoryOpen(next)
              if (next && history === null) {
                try {
                  setHistory(await api.translateHistory(50))
                } catch {
                  setHistory([])
                }
              }
            }}
          >
            <IconHistory size={12} />
          </button>
          <button
            title={pinned ? '取消固定' : '钉住卡片'}
            className={`flex items-center rounded px-1.5 py-0.5 text-xs ${pinned ? 'bg-accent-soft text-accent' : 'text-text-faint hover:text-accent'}`}
            onClick={() => setPinned((p) => !p)}
          >
            <IconPin size={12} />
          </button>
          <button
            title="关闭"
            className="flex items-center rounded px-1.5 py-0.5 text-xs text-text-faint hover:text-danger"
            onClick={onClose}
          >
            <IconX size={11} />
          </button>
        </span>
      </div>

      {/* 查词历史下拉 */}
      {historyOpen && (
        <div className="max-h-44 overflow-y-auto border-b border-border bg-panel-soft px-2 py-1.5">
          {history === null ? (
            <p className="py-2 text-center text-[11px] text-text-faint">加载中…</p>
          ) : history.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-text-faint">暂无查词记录</p>
          ) : (
            history.map((it) => (
              <button
                key={it.id}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-accent-soft"
                onClick={() => {
                  const gloss = typeof it.result.translation === 'string' ? it.result.translation : String(it.result.gloss ?? '')
                  setHistoryOpen(false)
                  onToast(`「${it.word}」：${gloss.slice(0, 60)}`)
                }}
                title={String(it.result.translation ?? it.result.gloss ?? '')}
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={it.word}>
                  {it.word}
                </span>
                <span className="badge shrink-0">{it.mode === 'dict' ? '词典' : it.mode === 'sentence' ? '句译' : 'LLM'}</span>
                <span className="shrink-0 text-[10px] text-text-faint">
                  {new Date(it.created_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {/* hit 层：词性 + 基本义 / 直接译法 */}
        {hit && (
          <div className="mb-2">
            {hit.layer === 'wordbook' || hit.layer === 'glossary' || hit.layer === 'cache' ? (
              <div className="u-break rounded-md bg-accent-soft px-2.5 py-2">
                <div className="font-medium text-accent">{hit.translation || '（暂无译法）'}</div>
                {hit.stage != null && (
                  <div className="mt-0.5 text-[11px] text-text-faint">
                    生词阶段：{hit.stage === 0 ? '陌生' : hit.stage === 1 ? '学习中' : '已掌握'}
                  </div>
                )}
              </div>
            ) : (
              (hit.pos || hit.gloss) && (
                <div className="u-break text-xs leading-5 text-text-soft">
                  {hit.pos && <span className="mr-1.5 italic text-text-faint">{hit.pos}</span>}
                  <span className="whitespace-pre-wrap">{hit.gloss}</span>
                </div>
              )
            )}
          </div>
        )}

        {/* LLM 流式 */}
        {(streamText || status === 'loading') && (
          <div className="u-break whitespace-pre-wrap text-xs leading-relaxed">
            {streamText}
            {status === 'streaming' && <span className="typing-caret" />}
            {status === 'loading' && !streamText && (
              <span className="flex items-center gap-1.5 text-text-faint">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                {llmHint || '正在查询…'}
              </span>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="mt-1 flex items-center justify-between rounded-md bg-[rgba(181,72,60,.07)] px-2 py-1.5 text-[11px] text-danger">
            <span>{errorDetail || '出错了，已保留已收内容'}</span>
            <button
              className="btn px-2 py-0.5 text-[11px]"
              onClick={() => {
                if (!request) return
                if (request.mode === 'dict') {
                  setHit(null)
                  setStatus('loading')
                  setErrorDetail('')
                  api
                    .dictionary(request.word.trim().split(/\s+/)[0] ?? '')
                    .then((entry) => {
                      setHit({ layer: 'dict', pos: entry.pos, phonetic: entry.phonetic, gloss: entry.translation })
                      setStatus('done')
                    })
                    .catch(() => {
                      setHit({ layer: 'dict' })
                      setStatus('error')
                      setErrorDetail('词典未收录')
                    })
                } else {
                  setStreamText('')
                  setErrorDetail('')
                  runWordRequest(request)
                }
              }}
            >
              重试
            </button>
          </div>
        )}

        {/* 修正译法输入 */}
        {fixOpen && (
          <div className="mt-2 flex gap-1.5">
            <input
              className="input flex-1 py-1 text-xs"
              placeholder={`${request.word} → 中文译法`}
              value={fixText}
              autoFocus
              onChange={(e) => setFixText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitFix()}
            />
            <button className="btn btn-primary px-2.5 py-1 text-xs" onClick={submitFix}>
              存
            </button>
          </div>
        )}

        {/* 句译区 */}
        {sentenceMode && (
          <div className="mt-2 rounded-md bg-panel-soft p-2">
            <div className="mb-1 text-[10px] font-medium text-text-faint">整句翻译</div>
            <div className="u-break whitespace-pre-wrap text-xs leading-relaxed">
              {sentenceText}
              {sentenceStatus === 'streaming' && <span className="typing-caret" />}
              {sentenceStatus === 'loading' && !sentenceText && <span className="text-text-faint">翻译中…</span>}
              {sentenceStatus === 'error' && <span className="text-danger">{sentenceError || '句译失败，可重试'}</span>}
            </div>
            {sentenceStatus === 'error' && (
              <button className="btn mt-1 px-2 py-0.5 text-[11px]" onClick={runSentence}>
                重试句译
              </button>
            )}
          </div>
        )}

        {/* 原句上下文折叠 */}
        <details className="mt-2 text-[11px] text-text-faint">
          <summary className="cursor-pointer select-none">原句上下文</summary>
          <div className="u-break mt-1 border-l-2 border-border pl-2 leading-5">
            {request.prev && <div className="opacity-60">{request.prev}</div>}
            <div className="text-text-soft">{request.sentence}</div>
            {request.next && <div className="opacity-60">{request.next}</div>}
          </div>
        </details>
      </div>

      {/* 操作行 */}
      <div className="flex items-center gap-1.5 border-t border-border bg-panel-soft px-2.5 py-1.5">
        <button className="btn shrink-0 px-2 py-1 text-[11px]" onClick={addToWordbook} title="入生词库（附当前译法与原句）">
          {saved ? (
            <>
              <IconCheck size={11} /> 已入库
            </>
          ) : (
            <>
              <IconPlus size={11} /> 生词
            </>
          )}
        </button>
        <button className="btn shrink-0 px-2 py-1 text-[11px]" onClick={() => setFixOpen((v) => !v)} title="修正译法 → 本文术语表">
          <IconPencil size={11} /> 修正
        </button>
        <button className="btn shrink-0 px-2 py-1 text-[11px]" onClick={starTranslation} title="收藏译法">
          <IconStar size={11} /> 收藏
        </button>
        {!sentenceMode && (
          <button className="btn ml-auto px-2 py-1 text-[11px]" onClick={runSentence} title="翻译整句">
            译全句
          </button>
        )}
      </div>
    </div>
  )
}
