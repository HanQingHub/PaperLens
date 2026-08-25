// 文库卡片 hover 预载：mouseenter 后预取论文元数据，点击进阅读器时零等待。
// 只预载元数据（不预取 PDF/token——token 一次性语义，预取即消耗）。
import { api } from '../../api/client'
import type { Paper } from '../../api/types'

const TTL_MS = 5000
const cache = new Map<number, { paper: Promise<Paper>; at: number }>()

export function prefetchPaper(pid: number) {
  const hit = cache.get(pid)
  if (hit && Date.now() - hit.at < TTL_MS) return
  cache.set(pid, { paper: api.paper(pid), at: Date.now() })
  for (const [k, v] of cache) {
    if (Date.now() - v.at >= TTL_MS) cache.delete(k)
  }
}

/** ReaderPage 加载入口：命中预载则零 RTT，未命中回退直接请求 */
export async function loadPaperCached(pid: number): Promise<Paper> {
  const hit = cache.get(pid)
  cache.delete(pid)
  if (hit && Date.now() - hit.at < TTL_MS) {
    const p = await hit.paper.catch(() => null)
    if (p) return p
  }
  return api.paper(pid)
}
