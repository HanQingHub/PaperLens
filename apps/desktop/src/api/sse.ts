// SSE 客户端：fetch ReadableStream 实现（支持 POST + Bearer 头 + 取消 + 心跳看门狗）
import type { TranslateEvent } from './types'
import { getToken } from './client'

export interface SseOptions {
  /** 15s 无任何事件视为死链，抛 SseTimeoutError */
  watchdogMs?: number
  signal?: AbortSignal
}

export class SseTimeoutError extends Error {
  constructor() {
    super('SSE_WATCHDOG')
  }
}

/**
 * 发起 SSE POST 请求，异步迭代事件。
 * ping 事件被静默吞掉；error 事件不抛出而是 yield（由 UI 决定保留已收内容）。
 */
export async function* ssePost(
  path: string,
  body: Record<string, unknown>,
  opts: SseOptions = {},
): AsyncGenerator<TranslateEvent, void, unknown> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `HTTP ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastEventAt = Date.now()
  const watchdogMs = opts.watchdogMs ?? 15000

  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > watchdogMs) controller.abort(new SseTimeoutError())
  }, 1000)

  const touch = () => {
    lastEventAt = Date.now()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      touch()
      buf += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const ev = parseEvent(raw)
        if (ev) yield ev
      }
    }
  } finally {
    clearInterval(watchdog)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

function parseEvent(raw: string): TranslateEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue // 注释/心跳
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (event === 'message' && dataLines.length === 0) return null
  const dataStr = dataLines.join('\n')
  let data: Record<string, unknown> = {}
  try {
    data = dataStr ? JSON.parse(dataStr) : {}
  } catch {
    data = { text: dataStr }
  }
  switch (event) {
    case 'hit': {
      const layers = ['wordbook', 'glossary', 'cache', 'ecdict'] as const
      const layer = layers.includes(data.layer as never) ? (data.layer as (typeof layers)[number]) : 'ecdict'
      return { event: 'hit', layer, data }
    }
    case 'delta':
      return { event: 'delta', text: (data.text as string) ?? '' }
    case 'done':
      return { event: 'done', engine: (data.engine as string) ?? '', cached: Boolean(data.cached) }
    case 'error': {
      const codes = ['llm_loading_timeout', 'llm_timeout', 'internal', 'text_too_long'] as const
      const code = codes.includes(data.code as never) ? (data.code as (typeof codes)[number]) : 'internal'
      return { event: 'error', code, detail: (data.detail as string) ?? '' }
    }
    case 'ping':
      return { event: 'ping' }
    default:
      return null
  }
}
