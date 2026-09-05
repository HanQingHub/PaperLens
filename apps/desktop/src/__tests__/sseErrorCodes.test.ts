// @vitest-environment jsdom
// SSE 错误码透出：8 码直透（未知码仍 internal），供翻译卡自动重试分支消费
import { describe, expect, it } from 'vitest'
import { toTranslateEvent } from '../api/sse'

const frame = (code: string) => `event: error\ndata: {"code":"${code}","detail":"d"}`

describe('toTranslateEvent error codes', () => {
  it.each([
    'llm_loading_timeout',
    'llm_timeout',
    'llm_empty',
    'interrupted',
    'word_invalid',
    'text_invalid',
    'internal',
    'text_too_long',
  ])('透出 %s', (code) => {
    const ev = toTranslateEvent(frame(code))
    expect(ev).toMatchObject({ event: 'error', code })
  })

  it('未知码塌陷为 internal', () => {
    expect(toTranslateEvent(frame('nope'))).toMatchObject({ event: 'error', code: 'internal' })
  })
})
