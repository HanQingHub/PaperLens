// 阅读器渲染/交互常量（分散魔法数字集中管理）

/** Ctrl+滚轮缩放的指数步长（每 1 deltaY 单位） */
export const ZOOM_STEP_RATIO = 1.0016
/** 缩放防抖时长：renderScale 提交前页面位图整体拉伸，超时后才高清重渲染 */
export const RENDER_DEBOUNCE_MS = 180
/** 阅读进度保存节流间隔 */
export const PROGRESS_SAVE_THROTTLE_MS = 2000
/** OCR 逐行字号系数：fontSize = 行框高 × 此值。
 * M3 ground-truth 实测（LoRA 论文 3 页 273 匹配行，真实字号/OCR 检测框高）
 * 中位数 0.8611（p25-p75: 0.83~0.96），校准脚本 .opencode/ocr_calib/calibrate.py */
export const OCR_LINE_HEIGHT_RATIO = 0.86
/** OCR 行字号保底比例：fontSize ≥ 行框高 × 此值（防极端异常框） */
export const OCR_LINE_FONT_FLOOR = 0.5

export interface OcrPollDecision {
  ui: 'running' | 'pending' | 'done' | 'failed' | 'none'
  keepPolling: boolean
}

/** OCR 轮询状态映射：白名单之外（none/未知）一律停止轮询——
 * 取消排队后服务端回到 none，若误映射为 pending 会永久空转。 */
export function mapOcrPollStatus(status: string): OcrPollDecision {
  switch (status) {
    case 'running':
      return { ui: 'running', keepPolling: true }
    case 'pending':
      return { ui: 'pending', keepPolling: true }
    case 'done':
      return { ui: 'done', keepPolling: false }
    case 'failed':
      return { ui: 'failed', keepPolling: false }
    default:
      return { ui: 'none', keepPolling: false }
  }
}