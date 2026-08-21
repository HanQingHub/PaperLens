// 拖拽来源判定（纯函数）：按 dataTransfer.types 区分文件 / 卡片 / 无关拖拽
import { PAPER_DRAG_MIME } from './types'

export type DragKind = 'paper' | 'files' | null

export function dragKind(types: readonly string[]): DragKind {
  const list = Array.from(types).map(t => t.toLowerCase())
  if (list.includes('files')) return 'files'
  if (list.includes(PAPER_DRAG_MIME.toLowerCase())) return 'paper'
  return null
}
