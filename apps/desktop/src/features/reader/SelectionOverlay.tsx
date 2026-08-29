// 选区 Live 视觉兜底（零 DOM 污染方案 4.4）
// ::selection 透明化后，拖拽划词的实时蓝块由本层渲染：
//  - selectionchange + rAF 节流（每帧最多一次合并计算）
//  - 挂在舞台内（受 transform: scale(stretch) 影响），geom 与 AnnotationOverlay 同口径
//  - 优先显示落库 selection.rects（mouseup 后），拖拽中显示 liveRects
import { memo, useEffect, useRef, useState } from 'react'
import { useReader } from '../../stores/readerStore'
import { clientRectsInPage, mergeClientRects } from '../../shared/coords'
import { fitRectEdgesToInk, fitRectVertical, type InkMap, type LineBand } from '../../shared/highlightGeometry'

interface SelectionOverlayProps {
  pageIndex: number
  /** 舞台几何（scale = hiScale，与 AnnotationOverlay 同源） */
  geom: { baseW: number; baseH: number; scale: number }
  /** 舞台布局宽高 = baseW/baseH × hiScale */
  stageW: number
  stageH: number
  /** 页容器引用（.page-wrapper，用于跨页过滤） */
  pageRef: React.RefObject<HTMLDivElement | null>
  /** 舞台容器引用（带 transform: scale(stretch)，供可视→舞台坐标换算） */
  stageRef: React.RefObject<HTMLDivElement | null>
  /** 行盒 bands（舞台坐标）：矩形渲染前钳制，与词带/批注等高 */
  lineBands: LineBand[]
  /** 页面 canvas 墨迹：矩形左右缘吸附真实字形边界（Range 几何含 advance
   * 漂移）；无墨迹（OCR 页等）→ 跳过 */
  ink?: InkMap
  /** canvas 像素 / 舞台 px */
  inkScale?: number
}

/** 可视 CSS px → 舞台局部 px：减舞台可视原点后除以 stretch */
function toStage(clientVal: number, origin: number, stretch: number) {
  return (clientVal - origin) / stretch
}

const SelectionOverlay = memo(function SelectionOverlay({
  pageIndex, geom, stageW, stageH, pageRef, stageRef, lineBands, ink, inkScale,
}: SelectionOverlayProps) {
  const selection = useReader((s) => s.selection)
  type Box = { left: number; top: number; width: number; height: number }
  const [liveRects, setLiveRects] = useState<Box[]>([])

  /** 垂直=块内字符墨迹（行带框架内）+ 左右缘吸附字形；无墨迹时吸附行带 */
  const finishBox = (b: Box): Box => {
    const c = fitRectVertical(ink, b, lineBands, inkScale ?? 0)
    return ink && inkScale ? fitRectEdgesToInk(ink, c, c.height, inkScale) : c
  }

  const rafRef = useRef(0)
  useEffect(() => {
    const onSelectionChange = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        const sel = window.getSelection()
        // N16：空态返回同一引用，避免连续模式下 N-1 个非命中页每帧重渲染
        const empty = (prev: Box[]) => (prev.length === 0 ? prev : [])
        if (!sel || sel.isCollapsed) { setLiveRects(empty); return }
        // 只处理锚点在本页的选区（早退在 getBoundingClientRect 之前，昂贵计算仅 1 页执行）
        const node = sel.anchorNode
        const el = node instanceof Element ? node : node?.parentElement
        const wrapper = el?.closest('.page-wrapper') as HTMLElement | null
        if (!wrapper || Number(wrapper.dataset.pageIndex) !== pageIndex) {
          setLiveRects(empty)
          return
        }
        const range = sel.getRangeAt(0)
        const pageBox = pageRef.current?.getBoundingClientRect()
        const stageEl = stageRef.current
        if (!pageBox || !stageEl) return

        // N6：getClientRects() 是可视 CSS px（已含 stretch），SVG rect 的 x/y
        // 是舞台局部 px，必须除以 stretch。stretch 实测：可视宽 ÷ 布局宽。
        const stageRect = stageEl.getBoundingClientRect()
        const layoutW = stageEl.offsetWidth || stageRect.width
        const stretch = layoutW > 0 ? stageRect.width / layoutW : 1

        const raw = clientRectsInPage(range.getClientRects(), pageBox)
        const merged = mergeClientRects(raw, 1.0, Math.max(geom.scale * stretch, 0.01))
        // 钳制到行盒 band：与词带/批注等高，消除字形盒 > 行距的行间重叠
        setLiveRects(merged.map((r) => finishBox({
          left: toStage(r.left, stageRect.left, stretch),
          top: toStage(r.top, stageRect.top, stretch),
          width: r.width / stretch,
          height: r.height / stretch,
        })))
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      cancelAnimationFrame(rafRef.current)
    }
    // lineBands/ink 变化重挂监听：拖拽中下一次 selectionchange 即以新闭包重算；
    // mouseup 后走落库路径（渲染期钳制），无需在此补算 liveRects
  }, [pageIndex, pageRef, stageRef, geom.scale, lineBands, ink, inkScale])

  // 落库选区（mouseup 后）优先：pdfRect × hiScale 直接得舞台局部坐标，不需除 stretch；
  // 渲染前同样钳制 + 吸附
  const rects = selection?.pageIndex === pageIndex
    ? (selection.rects?.map(r => finishBox({
        left: r[0] * geom.scale,
        top: (geom.baseH - r[3]) * geom.scale,
        width: (r[2] - r[0]) * geom.scale,
        height: (r[3] - r[1]) * geom.scale,
      })) ?? [])
    : liveRects

  if (!rects.length) return null

  return (
    <svg className="anno-rect-svg" width={stageW} height={stageH} style={{ pointerEvents: 'none' }}>
      {rects.map((r, i) => (
        <rect
          key={`sel-${i}`}
          x={r.left} y={r.top} width={r.width} height={r.height}
          rx={2}
          fill="rgba(51,101,138,.35)"
        />
      ))}
    </svg>
  )
})

export default SelectionOverlay
