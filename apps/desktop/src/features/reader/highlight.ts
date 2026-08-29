// textLayer / OCR 层词级高亮几何计算
// 扫描 span 逐词建矩形，垂直钳制到所在 span 行盒，输出舞台坐标分桶
// （供 PageView 渲染 SVG 词带层）。
// v5：退役 CSS Custom Highlight API——其绘制几何 = Range 字形盒且不可控
// （字形盒 19.5 > 行距 19.2，相邻行色带重叠融合，见计划《阅读器高亮高度统一
// 与行间重叠修复落地计划》1.2），改由可控 SVG 叠加层承载。
// 文字层保持零污染：不向 textLayer 注入任何节点，span 保持单文本节点。
import { lookupHit } from './lemma'
import {
  fitRectEdgesToInk,
  fitRectVertical,
  separateVertically,
  stageHlName,
  type HlName,
  type InkMap,
  type LineBand,
  type StageBox,
} from '../../shared/highlightGeometry'


const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

export interface HighlightOptions {
  stageMap: Map<string, 0 | 1 | 2>
  enabled: boolean
  /** 高亮强度档位（来自 settings.highlight_style 1|2|3） */
  strength: 1 | 2 | 3
  /** 搜索命中词集合（小写原文） */
  searchTerms?: Set<string>
  /** 当前聚焦的搜索词（强调色） */
  currentTerm?: string | null
}

export interface WordBucket { name: HlName; rects: StageBox[] }

export interface ComputeContext {
  /** 舞台可视原点 X/Y、舞台布局宽与纵向拉伸比（PageView 实测传入） */
  stageLeft: number
  stageTop: number
  stageWidth: number
  stretch: number
  /** 行带（舞台坐标，已墨迹定位 + 高度封顶 + 分离）：词带/选区/批注统一的
   * 垂直基准——三类高亮同行同高，行间白隙由行带保证 */
  lineBands?: LineBand[]
  /** 页面 canvas 墨迹（文本型页才有）：词带按实际墨迹拟合，消除回退字体
   * 度量与 canvas 字形的基线/advance 错位（半字内切、垂直偏移） */
  ink?: InkMap
  /** canvas 像素 / 舞台 px */
  inkScale?: number
}

/**
 * 扫描容器内 pdfjs 文本 span / OCR 行，产出词高亮矩形分桶（舞台坐标）。
 * 纯计算无副作用，可在 idle 回调中调用。
 */
export function computeWordHighlights(
  container: HTMLElement,
  ctx: ComputeContext,
  opts: HighlightOptions,
): WordBucket[] {
  // 清理历史版本注入的 <i> 碎片（v4 前遗留防御）
  container.querySelectorAll('i[class^="hl-stage-"], i.search-hit, i.search-hit-current')
    .forEach(el => el.replaceWith(el.textContent!))

  if (!opts.enabled && !opts.searchTerms?.size) return []

  const spans = container.querySelectorAll<HTMLElement>(
    '.textLayer > span, .ocr-block, .ocr-line',
  )
  const invStretch = 1 / (ctx.stretch > 0 ? ctx.stretch : 1)
  const toStageX = (v: number) => (v - ctx.stageLeft) * invStretch
  const toStageY = (v: number) => (v - ctx.stageTop) * invStretch

  const buckets = new Map<HlName, StageBox[]>()
  const push = (name: HlName, r: StageBox) => {
    const arr = buckets.get(name)
    if (arr) arr.push(r)
    else buckets.set(name, [r])
  }

  for (const span of spans) {
    if (span.classList.contains('endOfContent')) continue
    if (!span.dataset.orig) span.dataset.orig = span.textContent ?? ''
    const text = span.dataset.orig
    if (!/[A-Za-z]/.test(text)) continue
    // 保证 span 下只有一个 Text 节点（Range 需要）；清除历史 <i> 后可能有多子节点
    if (span.childNodes.length !== 1 || span.firstChild?.nodeType !== Node.TEXT_NODE) {
      span.textContent = text
    }
    const tn = span.firstChild as Text | null
    if (!tn) continue

    // 行盒基准：span 自身可视盒 → 舞台坐标（词带垂直区间的钳制目标）
    const sb = span.getBoundingClientRect()
    const bandTop = toStageY(sb.top)
    const bandBottom = toStageY(sb.bottom)

    WORD_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WORD_RE.exec(text)) !== null) {
      const w = m[0]
      const lower = w.toLowerCase()
      let name: HlName | '' = ''
      if (opts.enabled) {
        const hit = lookupHit(w, opts.stageMap)
        // stage 2 为下划线态，不分强度；stage 0/1 按 highlight_style 选桶
        if (hit) name = hit.stage === 2 ? 'hl-stage-2' : stageHlName(hit.stage, opts.strength)
      }
      if (!name && opts.searchTerms?.has(lower)) {
        name = lower === opts.currentTerm ? 'search-hit-current' : 'search-hit'
      }
      if (!name) continue
      const r = new Range()
      r.setStart(tn, m.index)
      r.setEnd(tn, m.index + w.length)
      const rb = r.getBoundingClientRect() // 可视 px（含 stretch/scaleX）
      if (rb.width < 1 || rb.height < 1) continue
      const rawBox: StageBox = {
        left: toStageX(rb.left),
        top: toStageY(rb.top),
        width: (rb.right - rb.left) * invStretch,
        height: (rb.bottom - rb.top) * invStretch,
      }
      // 垂直：统一到行带框架，按块内字符墨迹取高（上界=字符最高墨迹，下界=最低
      // 墨迹，降部可伸入行带下方 8% 行距余量）；无行带数据时回退 span 行盒
      const vBands = ctx.lineBands && ctx.lineBands.length ? ctx.lineBands : [{ top: bandTop, bottom: bandBottom }]
      const box = fitRectVertical(ctx.ink, rawBox, vBands, ctx.inkScale ?? 0)
      // 水平：canvas 墨迹缘吸附（切进外扩 / 盖空白内收，防误吸邻词）；无墨迹回退 padX 外扩
      if (ctx.ink && ctx.inkScale) {
        push(name, fitRectEdgesToInk(ctx.ink, box, box.height, ctx.inkScale))
        continue
      }
      const padX = Math.min(box.height * 0.1, 4)
      const leftRaw = box.left - padX
      const rightRaw = box.left + box.width + padX
      const left = Math.max(0, Math.min(leftRaw, ctx.stageWidth - 1))
      const width = Math.max(1, Math.min(rightRaw, ctx.stageWidth) - left)
      push(name, { left, top: box.top, width, height: box.height })
    }
  }

  return [...buckets.entries()].map(([name, rects]) => {
    const merged = mergeWordRects(rects)
    // 防御性兜底：正常路径词带已钳到行带（行带两两分离）；此处拦截透传矩形
    // （如与所有 band 无交集的异常几何）跨行相接时的双涂层暗缝
    const separated = separateVertically(merged.map((r) => ({ ...r, bottom: r.top + r.height })))
    return {
      name,
      rects: separated.map(({ left, top, width, bottom }) => ({ left, top, width, height: bottom - top })),
    }
  })
}

/**
 * 词带水平外扩 + 桶内同行合并。
 * 外扩：textLayer 的字符 advance 来自 CSS 回退字体测量（pdf.js 仅用 scaleX 保证
 * 整串总宽与 canvas 字形一致），词内首尾字符的墨迹可越出 Range 边界半格——
 * 两侧各留行盒高的 10%（≤4 stage px）防止切进字形。
 * 合并：外扩后交叠/贴边的同行同色带并成单矩形，避免半透明 α 双涂层暗缝。
 */
function mergeWordRects(rects: StageBox[]): StageBox[] {
  const rows = new Map<string, StageBox[]>()
  for (const r of rects) {
    const key = `${Math.round(r.top * 2)}:${Math.round(r.height * 2)}`
    const arr = rows.get(key)
    if (arr) arr.push(r)
    else rows.set(key, [r])
  }
  const out: StageBox[] = []
  for (const row of rows.values()) {
    row.sort((a, b) => a.left - b.left)
    const merged: StageBox[] = []
    for (const r of row) {
      const last = merged[merged.length - 1]
      // 仅合并交叠/贴边（缝隙 ≤0.2px）的相邻带；
      // 隔空格（~3px）或隔普通词的不合并，保留逐词边界
      if (last && r.left <= last.left + last.width + 0.2) {
        const right = Math.max(last.left + last.width, r.left + r.width)
        last.width = right - last.left
      } else {
        merged.push({ ...r })
      }
    }
    out.push(...merged)
  }
  return out
}
