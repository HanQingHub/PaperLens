/**
 * 层析 STRATA · 文库地形的纯函数层（无 React / DOM 依赖，供 NextTerrain 与单测共用）。
 * 编码规则：高度 = 批注数，顶面 = 阅读态，色带 = 项目。
 */
import type { Paper } from '../api/types'

export type ReadState = 'unread' | 'reading' | 'read'

export interface TerrainBlock {
  id: number
  col: number
  row: number
  /** 体块高度（px，未缩放） */
  h: number
  state: ReadState
  /** 项目色相 0–359 */
  hue: number
}

/** 超过该篇数自动降级为网格视图（3D 体块数量的性能上限） */
export const TERRAIN_MAX = 120
/** 网格步距与体块边长（px，未缩放） */
export const PITCH = 112
export const CELL = 92

const DAY_MS = 86_400_000

/** 列数：≤36 篇固定 6 列；更多时取 ceil(sqrt(n))，上限 11 */
export function terrainCols(n: number): number {
  if (n <= 36) return 6
  return Math.min(11, Math.ceil(Math.sqrt(n)))
}

/** 行数（至少 1 行，便于空态也有地面） */
export function terrainRows(n: number): number {
  return Math.max(1, Math.ceil(n / terrainCols(n)))
}

/** 高度：批注数映射，缺省 / 负数视为 0，上限 40 条 */
export function blockHeight(annotations: number | null | undefined): number {
  const n = typeof annotations === 'number' && Number.isFinite(annotations) ? annotations : 0
  return 8 + Math.min(Math.max(n, 0), 40) * 3
}

/** 阅读态三态：未打开 → unread；7 天内打开过 → reading；其余 → read */
export function readState(paper: Pick<Paper, 'open_count' | 'last_opened_at'>, now: number = Date.now()): ReadState {
  if (!paper.open_count) return 'unread'
  const t = paper.last_opened_at ? Date.parse(paper.last_opened_at) : Number.NaN
  return Number.isFinite(t) && now - t < 7 * DAY_MS ? 'reading' : 'read'
}

/** 项目色相：按 project_id 稳定散列（Knuth 乘法散列）；未分组固定 30 */
export function projectHue(projectId: number | null | undefined): number {
  if (projectId == null) return 30
  const x = Math.imul(projectId | 0, 2654435761) >>> 0
  return x % 360
}

/** 按传入顺序（即当前排序结果）铺格 */
export function layoutTerrain(papers: Paper[], now: number = Date.now()): TerrainBlock[] {
  const cols = terrainCols(papers.length)
  return papers.map((paper, index) => ({
    id: paper.id,
    col: index % cols,
    row: Math.floor(index / cols),
    h: blockHeight(paper.annotation_count),
    state: readState(paper, now),
    hue: projectHue(paper.project_id),
  }))
}

/** 字符串 → 32 位种子（论文徽记用，按 file_hash 稳定） */
export function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 可复现的伪随机序列（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const READ_STATE_LABEL: Record<ReadState, string> = { unread: '未读', reading: '在读', read: '读过' }
