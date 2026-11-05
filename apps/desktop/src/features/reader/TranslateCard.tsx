// 翻译卡片：四层命中徽标 + LLM 流式打字机 + 整句模式 + 修正译法 + 入生词
import { useEffect, useMemo, useRef, useState } from 'react'
import { ssePost, SseTimeoutError } from '../../api/sse'
import { IconCheck, IconCopy, IconHistory, IconPencil, IconPin, IconPlus, IconStar, IconX } from '../../components/shared/Icon'
import { api, addGlossaryTerm } from '../../api/client'
import type { TranslateEvent } from '../../api/types'
import { useReaderBus } from '../../stores/readerBus'
import { useWords } from '../../stores/words'
import { useReader } from '../../stores/readerStore'
import { lemmaCandidates } from './lemma'
import { chunkForTranslation, parseWordSections, pickTranslation } from './translateView'

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
  /** dict = 仅词典释义；sentence = 整句/多句翻译（不出词卡）；word = 词卡 */
  mode: 'word' | 'dict' | 'sentence'
  /** 长选区：出卡后自动触发整句翻译（旧字段，保留兼容） */
  autoSentence?: boolean
  /** 跳过词库/术语表/缓存命中，强制 LLM 结合上下文重译（卡片"AI 重译"） */
  force?: boolean
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
  const [sentenceProgress, setSentenceProgress] = useState<{ done: number; total: number } | null>(null)
  const [fixOpen, setFixOpen] = useState(false)
  const [fixText, setFixText] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
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

  const isSentenceCard = request?.mode === 'sentence'
  const sections = useMemo(() => parseWordSections(streamText), [streamText])

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
    const waiting = request?.mode === 'sentence' ? sentenceStatus === 'loading' : status === 'loading'
    if (!waiting || !request || request.mode === 'dict') {
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
  }, [status, sentenceStatus, request])

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
    if (req.force) setHit(null)
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
            force: req.force ? 1 : 0,
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

  // ── 句译（整句卡片 / 卡片内“译全句”）：长文按句切段顺序翻译 ──
  const runSentence = (source?: string) => {
    if (!request) return
    const text = (source ?? request.sentence ?? '').trim()
    if (!text) return
    setSentenceMode(true)
    setSentenceText('')
    setSentenceStatus('loading')
    setSentenceError('')
    sentenceAbortRef.current?.abort()
    const ac = new AbortController()
    sentenceAbortRef.current = ac
    const chunks = chunkForTranslation(text)
    setSentenceProgress({ done: 0, total: chunks.length })
    ;(async () => {
      let acc = ''
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (ac.signal.aborted) return
          let piece = ''
          const gen = ssePost(
            '/translate/sentence',
            {
              paper_id: paperId,
              text: chunks[i],
              prev: i === 0 ? request.prev : '',
              next: i === chunks.length - 1 ? request.next : '',
            },
            { signal: ac.signal },
          )
          for await (const ev of gen as AsyncGenerator<TranslateEvent>) {
            if (ev.event === 'hit') {
              piece = ev.data.translation ?? ''
              setSentenceText(acc ? `${acc}\n${piece}` : piece)
            } else if (ev.event === 'delta') {
              piece += ev.text
              setSentenceStatus('streaming')
              setSentenceText(acc ? `${acc}\n${piece}` : piece)
            } else if (ev.event === 'done') {
              break
            } else if (ev.event === 'error') {
              console.debug('[translate] sentence error', ev.code, ev.detail)
              if (isLlmNotReady(ev.code) && autoRetriedRef.current < 2 && !ac.signal.aborted) {
                autoRetriedRef.current += 1
                setSentenceStatus('loading')
                void (async () => {
                  const r = await waitLlmReady(ac.signal)
                  if (ac.signal.aborted) return
                  if (r.ready) runSentence(text)
                  else if (r.failMsg) {
                    setSentenceError(r.failMsg)
                    setSentenceStatus('error')
                  }
                })()
                return
              }
              throw new Error(ERR_COPY[ev.code] ?? '服务暂不可用，可重试')
            }
          }
          if (!piece.trim()) throw new Error('模型暂无有效输出')
          acc = acc ? `${acc}\n${piece}` : piece
          setSentenceText(acc)
          setSentenceProgress({ done: i + 1, total: chunks.length })
        }
        setSentenceStatus('done')
        setSentenceProgress(null)
      } catch (e) {
        if (ac.signal.aborted) return
        // 看门狗掐断的静默句译流：无内容才兜底自动加载，有内容落 error 保内容
        if (!acc && sentenceStatusRef.current === 'loading' && autoRetriedRef.current < 2) {
          autoRetriedRef.current += 1
          void (async () => {
            const r = await waitLlmReady(ac.signal)
            if (ac.signal.aborted) return
            if (r.ready) runSentence(text)
            else if (r.failMsg) {
              setSentenceError(r.failMsg)
              setSentenceStatus('error')
            }
          })()
          return
        }
        setSentenceError(e instanceof Error && e.message ? e.message : '句译失败，可重试')
        setSentenceStatus('error')
      }
    })()
  }

  // ── 主请求（词翻译 SSE / 词典直查 / 整句翻译）──
  useEffect(() => {
    if (!request) return
    autoRetriedRef.current = 0
    loadTriggeredRef.current = false
    setHit(null)
    setStreamText('')
    setEngine('')
    setSaved(false)
    setCopied(false)
    setErrorDetail('')
    setSentenceMode(false)
    setSentenceText('')
    setSentenceStatus(null)
    setSentenceError('')
    setSentenceProgress(null)
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
    if (request.mode === 'sentence') {
      setStatus('done')
      runSentence()
      return () => {
        abortRef.current?.abort()
        sentenceAbortRef.current?.abort()
      }
    }
    runWordRequest(request)
    return () => {
      abortRef.current?.abort()
      sentenceAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  if (!request) return null

  // ── 入生词库：lemma 归一 + 卡片当前译法 ──
  const addToWordbook = async () => {
    const word = request.word.trim().split(/\s+/)[0] ?? ''
    if (!word) return
    const exists = lemmaCandidates(word).some((c) => stageMap.has(c))
    const translation = pickTranslation(streamText, hit?.translation ?? '')
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
    const translation = pickTranslation(streamText, hit?.translation ?? '')
    if (!translation) return
    const list = starList().filter((x) => x.word !== request.word)
    list.unshift({ word: request.word, translation })
    localStorage.setItem(starKey, JSON.stringify(list.slice(0, 200)))
    onToast('已收藏译法')
  }

  const copyText = async () => {
    const body = isSentenceCard ? sentenceText : sections.parsed ? [sections.gloss, sections.context].filter(Boolean).join('\n') : streamText
    if (!body.trim()) return
    try {
      await navigator.clipboard.writeText(body.trim())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
      onToast('已复制译文')
    } catch {
      onToast('复制失败')
    }
  }

  const cardW = isSentenceCard ? 380 : 320
  const cardX = dragPos
    ? dragPos.x
    : Math.max(12, Math.min(pos.x - (isSentenceCard ? 190 : 150), window.innerWidth - cardW - 12))
  const cardY = dragPos ? dragPos.y : pos.below ? pos.y : Math.max(60, pos.y - 40)
  const busy = isSentenceCard ? sentenceStatus === 'loading' || sentenceStatus === 'streaming' : status === 'loading' || status === 'streaming'

  return (
    <div
      className={`fade-in fixed z-[45] flex max-h-[72vh] ${isSentenceCard ? 'w-[380px]' : 'w-[320px]'} max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel text-[13px] shadow-[var(--shadow-2)] ${pinned ? 'ring-1 ring-accent/30 shadow-md' : ''} ${isDragging ? 'select-none' : ''}`}
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
        <span className="min-w-0 flex-1 truncate font-serif text-sm font-semibold" title={isSentenceCard ? request.sentence : request.word}>
          {isSentenceCard ? '整句翻译' : request.word}
        </span>
        {pinned && <span className="shrink-0 text-[10px] text-accent">已钉住</span>}
        {!isSentenceCard && hit?.phonetic && <span className="max-w-28 shrink-0 truncate text-[11px] text-text-faint">/{hit.phonetic}/</span>}
        {!isSentenceCard && hit && (
          <span className={`badge shrink-0 ${hit.layer === 'glossary' ? 'badge-accent' : ''}`}>
            {hit.badge ?? LAYER_LABEL[hit.layer]}
          </span>
        )}
        {!isSentenceCard && engine && engine.startsWith('llm') && status === 'done' && <span className="badge shrink-0">LLM</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            title="复制译文"
            className={`flex items-center rounded px-1.5 py-0.5 text-xs ${copied ? 'text-ok' : 'text-text-faint hover:text-accent'}`}
            onClick={copyText}
            disabled={busy && !streamText && !sentenceText}
          >
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </button>
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
                  onToast(`「${it.word}」：${gloss.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').slice(0, 60)}`)
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

      <div className="max-h-[calc(72vh-88px)] overflow-y-auto px-3 py-2">
        {/* ── 整句模式 ── */}
        {isSentenceCard && (
          <>
            <details className="mb-1.5 text-[11px] text-text-faint">
              <summary className="cursor-pointer select-none">原文（{request.sentence.length} 字符）</summary>
              <div className="u-break mt-1 max-h-28 overflow-y-auto border-l-2 border-border pl-2 leading-5 text-text-soft">
                {request.sentence}
              </div>
            </details>
            <div className="u-break whitespace-pre-wrap text-[13px] leading-relaxed">
              {sentenceText}
              {sentenceStatus === 'streaming' && <span className="typing-caret" />}
              {sentenceStatus === 'loading' && !sentenceText && (
                <span className="flex items-center gap-1.5 text-text-faint">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  {llmHint || '翻译中…'}
                </span>
              )}
            </div>
            {sentenceProgress && sentenceProgress.total > 1 && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-faint">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-border">
                  <span
                    className="block h-full rounded-full bg-accent transition-all duration-200"
                    style={{ width: `${Math.round((sentenceProgress.done / sentenceProgress.total) * 100)}%` }}
                  />
                </span>
                {sentenceProgress.done}/{sentenceProgress.total} 段
              </div>
            )}
            {sentenceStatus === 'error' && (
              <div
                className="mt-2 flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] text-danger"
                style={{ background: 'color-mix(in srgb, var(--danger) 7%, transparent)' }}
              >
                <span>{sentenceError || '句译失败，可重试'}</span>
                <button className="btn px-2 py-0.5 text-[11px]" onClick={() => runSentence()}>
                  重试
                </button>
              </div>
            )}
          </>
        )}

        {/* ── 词卡模式 ── */}
        {!isSentenceCard && (
          <>
            {/* hit 层：词性 + 基本义 / 直接译法 */}
            {hit && (
              <div className="mb-2">
                {hit.layer === 'wordbook' || hit.layer === 'glossary' || hit.layer === 'cache' ? (
                  <div className="u-break rounded-md bg-accent-soft px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 font-medium text-accent">
                        {parseWordSections(hit.translation ?? '').context || hit.translation || '（暂无译法）'}
                      </div>
                      <button
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-accent/80 hover:bg-panel hover:text-accent"
                        title="跳过词库/术语表/缓存，让模型结合当前句重新翻译"
                        onClick={() => runWordRequest({ ...request, force: true })}
                      >
                        AI 重译
                      </button>
                    </div>
                    {hit.stage != null && (
                      <div className="mt-0.5 text-[11px] text-text-faint">
                        生词阶段：{hit.stage === 0 ? '陌生' : hit.stage === 1 ? '学习中' : '已掌握'}
                      </div>
                    )}
                  </div>
                ) : (
                  // 仅"词典"模式（未走 LLM）直接铺释义；LLM 词卡模式下词典义收进折叠区，
                  // 避免长词条（harness 8 个义项）把语境译法挤到卡片折叠线以下
                  hit.layer === 'dict' && (hit.pos || hit.gloss) && (
                    <div className="u-break text-xs leading-5 text-text-soft">
                      {hit.pos && <span className="mr-1.5 italic text-text-faint">{hit.pos}</span>}
                      <span className="whitespace-pre-wrap">{hit.gloss}</span>
                    </div>
                  )
                )}
              </div>
            )}

            {/* LLM 三分区（流式中逐段成形；解析不到分区时原样展示） */}
            {(streamText || status === 'loading') && (
              <div className="text-xs leading-relaxed">
                {sections.parsed ? (
                  <div className="space-y-1.5">
                    {sections.gloss && (
                      <div className="u-break whitespace-pre-wrap text-text-soft">
                        <span className="mr-1 text-[10px] text-text-faint">基本义</span>
                        {sections.pos && <span className="mr-1 italic text-text-faint">{sections.pos}</span>}
                        {sections.gloss}
                      </div>
                    )}
                    {sections.context && (
                      <div className="u-break rounded-md bg-accent-soft px-2 py-1.5">
                        <span className="mr-1.5 text-[10px] text-accent/70">文中意</span>
                        <span className="font-medium text-accent">{sections.context}</span>
                      </div>
                    )}
                    {sections.extra.map((x, i) => (
                      <div key={i} className="u-break text-[11px] text-text-faint">{x}</div>
                    ))}
                    {status === 'streaming' && <span className="typing-caret" />}
                  </div>
                ) : (
                  <div className="u-break whitespace-pre-wrap">
                    {streamText}
                    {status === 'streaming' && <span className="typing-caret" />}
                  </div>
                )}
                {status === 'loading' && !streamText && (
                  <span className="flex items-center gap-1.5 text-text-faint">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                    {llmHint || '正在查询…'}
                  </span>
                )}
              </div>
            )}

            {status === 'error' && (
              <div
                className="mt-1 flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger"
                style={{ background: 'color-mix(in srgb, var(--danger) 7%, transparent)' }}
              >
                <span className="min-w-0 flex-1 break-words leading-4">{errorDetail || '出错了，已保留已收内容'}</span>
                <button
                  className="btn shrink-0 px-2 py-0.5 text-[11px]"
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

            {/* 句译区（词卡内“译全句”） */}
            {sentenceMode && (
              <div className="mt-2 rounded-md bg-panel-soft p-2">
                <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-text-faint">
                  <span>整句翻译</span>
                  {sentenceProgress && sentenceProgress.total > 1 && (
                    <span>{sentenceProgress.done}/{sentenceProgress.total} 段</span>
                  )}
                </div>
                <div className="u-break whitespace-pre-wrap text-xs leading-relaxed">
                  {sentenceText}
                  {sentenceStatus === 'streaming' && <span className="typing-caret" />}
                  {sentenceStatus === 'loading' && !sentenceText && <span className="text-text-faint">翻译中…</span>}
                  {sentenceStatus === 'error' && <span className="text-danger">{sentenceError || '句译失败，可重试'}</span>}
                </div>
                {sentenceStatus === 'error' && (
                  <button className="btn mt-1 px-2 py-0.5 text-[11px]" onClick={() => runSentence()}>
                    重试句译
                  </button>
                )}
              </div>
            )}

            {/* 词典释义（补充信息，默认折叠） */}
            {hit?.layer === 'ecdict' && hit.gloss && (
              <details className="mt-2 text-[11px] text-text-faint">
                <summary className="cursor-pointer select-none">
                  词典释义{hit.pos ? ` · ${hit.pos}` : ''}
                </summary>
                <div className="u-break mt-1 whitespace-pre-wrap border-l-2 border-border pl-2 leading-5">
                  {hit.gloss}
                </div>
              </details>
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
          </>
        )}
      </div>

      {/* 操作行 */}
      <div className="flex items-center gap-1.5 border-t border-border bg-panel-soft px-2.5 py-1.5">
        {isSentenceCard ? (
          <>
            <button className="btn shrink-0 px-2 py-1 text-[11px]" onClick={copyText} disabled={!sentenceText}>
              <IconCopy size={11} /> 复制译文
            </button>
            <span className="ml-auto text-[10px] text-text-faint">
              {sentenceStatus === 'done' ? '已完成' : busy ? '翻译中…' : ''}
            </span>
          </>
        ) : (
          <>
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
              <button className="btn ml-auto px-2 py-1 text-[11px]" onClick={() => runSentence()} title="翻译整句">
                译全句
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
