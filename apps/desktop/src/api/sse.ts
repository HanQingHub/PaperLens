// SSE 客户端：fetch ReadableStream 实现（支持 POST + Bearer 头 + 取消 + 心跳看门狗）。
// 帧读取与事件解析见 stream.ts（与 NDJSON 共用帧读取器，协议解析各自独立）。
import type { TranslateEvent } from './types'
import { BASE, getToken } from './client'
import { parseSseEvent, readFrames, type SseFrame } from './stream'

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

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  let lastEventAt = Date.now()
  const watchdogMs = opts.watchdogMs ?? 15000

  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > watchdogMs) controller.abort(new SseTimeoutError())
  }, 1000)

  try {
    for await (const raw of readFrames(res, '\n\n', controller.signal)) {
      lastEventAt = Date.now()
      const ev = toTranslateEvent(raw)
      if (ev) yield ev
    }
  } finally {
    clearInterval(watchdog)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** SSE 帧 → 翻译事件联合类型（hit 的 data 为强类型负载，不再透传 Record） */
function toTranslateEvent(raw: string): TranslateEvent | null {
  const frame = parseSseEvent(raw)
  if (!frame) return null
  switch (frame.event) {
    case 'hit': {
      const layers = ['wordbook', 'glossary', 'cache', 'ecdict'] as const
      const layer = layers.includes(frame.data.layer as never)
        ? (frame.data.layer as (typeof layers)[number])
        : 'ecdict'
      const d = frame.data as SseFrame['data']
      return {
        event: 'hit',
        layer,
        data: {
          translation: typeof d.translation === 'string' ? d.translation : undefined,
          stage: typeof d.stage === 'number' ? d.stage : undefined,
          badge: typeof d.badge === 'string' ? d.badge : undefined,
          term: typeof d.term === 'string' ? d.term : undefined,
          pos: typeof d.pos === 'string' ? d.pos : null,
          phonetic: typeof d.phonetic === 'string' ? d.phonetic : null,
          gloss: typeof d.gloss === 'string' ? d.gloss : null,
        },
      }
    }
    case 'delta':
      return { event: 'delta', text: (frame.data.text as string) ?? '' }
    case 'done':
      return { event: 'done', engine: (frame.data.engine as string) ?? '', cached: Boolean(frame.data.cached) }
    case 'error': {
      const codes = ['llm_loading_timeout', 'llm_timeout', 'internal', 'text_too_long'] as const
      const code = codes.includes(frame.data.code as never)
        ? (frame.data.code as (typeof codes)[number])
        : 'internal'
      return { event: 'error', code, detail: (frame.data.detail as string) ?? '' }
    }
    case 'ping':
      return { event: 'ping' }
    default:
      return null
  }
}