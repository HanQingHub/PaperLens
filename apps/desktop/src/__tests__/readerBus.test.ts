// 画笔在途操作注册表测试：撤回/清除执行前的前置等待语义（竞态修复回归）。
import { describe, expect, it } from 'vitest'
import { settleInkOps, trackInkOp } from '../stores/readerBus'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('trackInkOp/settleInkOps', () => {
  it('无在途操作：settle 立即返回', async () => {
    await expect(settleInkOps()).resolves.toBeUndefined()
  })

  it('未落定的在途操作阻塞 settle，落定后放行', async () => {
    const d = deferred()
    trackInkOp(d.promise)
    let settled = false
    const s = settleInkOps().then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    d.resolve()
    await s
    expect(settled).toBe(true)
  })

  it('settle 等待期间新注册的操作（连笔）也被等待', async () => {
    const d1 = deferred()
    const d2 = deferred()
    trackInkOp(d1.promise)
    const order: string[] = []
    const s = settleInkOps().then(() => {
      order.push('settled')
    })
    // d1 落定的同一微任务里注册并落定 d2（模拟连笔追加）
    void d1.promise.then(() => {
      trackInkOp(d2.promise)
      d2.resolve()
      order.push('d2')
    })
    d1.resolve()
    await s
    expect(order).toEqual(['d2', 'settled'])
  })

  it('trackInkOp 透传结果与异常；异常落定后注册表清理', async () => {
    await expect(trackInkOp(Promise.resolve(7))).resolves.toBe(7)
    await expect(trackInkOp(Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(settleInkOps()).resolves.toBeUndefined()
  })
})
