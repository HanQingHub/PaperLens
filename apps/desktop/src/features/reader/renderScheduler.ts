// PDF 页渲染调度器 + 位图 LRU 缓存
// 解决问题：滚动时 renderRange 内多页同时挂载并同步发起 canvas 渲染，主线程被
// pdfjs 渲染分片抢占导致滚动掉帧；回滚时已卸载页的位图被销毁，需整页重绘白屏。
// 方案：
//  1. scheduleRender —— 全局并发上限（2），按优先级（距视口中心页数）排序，可取消；
//     任务在 rAF 中启动，避免与滚动/输入争用同一帧。
//  2. stashPageBitmap / takePageBitmap —— 页面卸载或重渲染前把已绘制的 canvas
//     异步转为 ImageBitmap 存入 LRU（约 12 页），重新挂载时先贴缓存位图再高清重渲染，
//     消除回滚白闪。

type RenderJob = () => Promise<void>

interface RenderTask {
  job: RenderJob
  priority: number
  cancelled: boolean
}

const MAX_CONCURRENT = 2
const queue: RenderTask[] = []
let running = 0

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const t = queue.shift()!
    if (t.cancelled) continue
    running++
    requestAnimationFrame(() => {
      if (t.cancelled) {
        running--
        pump()
        return
      }
      t.job()
        .catch(() => {})
        .finally(() => {
          running--
          pump()
        })
    })
  }
}

/**
 * 提交一个页面渲染任务。返回句柄的 cancel() 可在任务未开始前将其移除；
 * 任务开始后的中断由调用方在 job 内部通过自身 cancelled 标志完成。
 */
export function scheduleRender(job: RenderJob, priority = 0) {
  const task: RenderTask = { job, priority, cancelled: false }
  queue.push(task)
  queue.sort((a, b) => a.priority - b.priority)
  pump()
  return {
    cancel() {
      task.cancelled = true
      const i = queue.indexOf(task)
      if (i >= 0) queue.splice(i, 1)
    },
  }
}

// ── 位图 LRU ──────────────────────────────────────────────
const MAX_BITMAPS = 12
const bitmapCache = new Map<number, ImageBitmap>()

/** 卸载前缓存页位图（异步转 bitmap，fire-and-forget） */
export function stashPageBitmap(pageIndex: number, canvas: HTMLCanvasElement) {
  if (!canvas.width || !canvas.height) return
  createImageBitmap(canvas)
    .then((bmp) => {
      const old = bitmapCache.get(pageIndex)
      if (old) old.close()
      bitmapCache.set(pageIndex, bmp)
      // LRU：超出容量时淘汰最久未使用的条目
      while (bitmapCache.size > MAX_BITMAPS) {
        const oldest = bitmapCache.keys().next().value
        if (oldest === undefined) break
        bitmapCache.get(oldest)?.close()
        bitmapCache.delete(oldest)
      }
    })
    .catch(() => {})
}

/** 取出缓存位图（不删除，重复挂载仍可命中） */
export function takePageBitmap(pageIndex: number): ImageBitmap | null {
  const bmp = bitmapCache.get(pageIndex)
  if (!bmp) return null
  // 触及刷新 LRU 顺序
  bitmapCache.delete(pageIndex)
  bitmapCache.set(pageIndex, bmp)
  return bmp
}

/** 文档切换时清空缓存 */
export function clearPageBitmaps() {
  for (const bmp of bitmapCache.values()) bmp.close()
  bitmapCache.clear()
}
