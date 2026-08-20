// 文库拖拽共享常量与类型（PaperCard 仅引用类型，保持 dnd/ 不依赖组件）
import type { DragEvent } from 'react'

/** 卡片拖拽自定义 MIME（dataTransfer 判定来源用） */
export const PAPER_DRAG_MIME = 'application/x-paperlens-paper'
/** 项目条目拖拽自定义 MIME（ProjectRail 内部排序用） */
export const PROJECT_DRAG_MIME = 'application/x-paperlens-project'

/** 分组键：project_id；null = 未分组 */
export type GroupKey = number | null

/** 注入 PaperCard 根节点的拖拽 props（useLibraryDnd 生成） */
export interface CardDragProps {
  draggable: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
}
