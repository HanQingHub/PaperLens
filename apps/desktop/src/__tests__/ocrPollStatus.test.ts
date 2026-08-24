// B5：OCR 轮询状态映射白名单测试
import { describe, expect, it } from 'vitest'
import { mapOcrPollStatus } from '../features/reader/constants'

describe('mapOcrPollStatus', () => {
  it('running/pending 继续轮询', () => {
    expect(mapOcrPollStatus('running')).toEqual({ ui: 'running', keepPolling: true })
    expect(mapOcrPollStatus('pending')).toEqual({ ui: 'pending', keepPolling: true })
  })

  it('done/failed 终态停止轮询', () => {
    expect(mapOcrPollStatus('done')).toEqual({ ui: 'done', keepPolling: false })
    expect(mapOcrPollStatus('failed')).toEqual({ ui: 'failed', keepPolling: false })
  })

  it('none（取消后）与未知状态停止轮询且回 none', () => {
    expect(mapOcrPollStatus('none')).toEqual({ ui: 'none', keepPolling: false })
    expect(mapOcrPollStatus('whatever')).toEqual({ ui: 'none', keepPolling: false })
  })
})
