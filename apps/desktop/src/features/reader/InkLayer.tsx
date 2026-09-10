// 画笔层：自由笔触（pen/highlighter）与图形（line/arrow/rect/ellipse）采集 + 渲染。
//  - 挂 PageView 舞台内，z-index 6（高于批注层 3-5）：激活时拦截指针（绘制模式），
//    未激活时 pointer-events:none 纯展示（不挡批注卡片/锚点交互）。
//  - 坐标：采集 client → 舞台局部（÷stretch，SelectionOverlay 同款）→ page 单位
//    （÷hiScale）；持久化为 page 单位，任意缩放下渲染只需 ×hiScale。
//  - 每笔一行 type='ink' 批注（anchor_json={tool,color,width,points}），撤回=删行。
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { createAnnotation } from '../../api/client'
import { parseAnnotation, useReader, type InkStroke } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'
import { MIN_POINT_DIST, arrowHeadD, isCommittableStroke, smoothPathD } from './inkStroke'

interface InkLayerProps {
  pageIndex: number
  /** 舞台几何（scale = hiScale，与 AnnotationOverlay 同源） */
  geom: { baseW: number; baseH: number; scale: number }
  stageW: number
  stageH: number
  /** 舞台容器引用（带 transform: scale(stretch)） */
  stageRef: React.RefObject<HTMLDivElement | null>
}

/** 单笔渲染（live 与已保存同口径：page 单位 × geom.scale → 舞台 px） */
function StrokeShape({ stroke, k }: { stroke: InkStroke; k: number }) {
  const { tool, color, width, points } = stroke
  const hl = tool === 'highlighter'
  const common = {
    stroke: color,
    strokeWidth: width * k,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
    opacity: hl ? 0.35 : 1,
    style: hl ? { mixBlendMode: 'multiply' as const } : undefined,
  }
  if (tool === 'pen' || tool === 'highlighter') {
    return <path d={smoothPathD(points, k)} {...common} />
  }
  const [a, b] = points
  if (!a || !b) return null
  if (tool === 'line') return <path d={`M ${a[0] * k} ${a[1] * k} L ${b[0] * k} ${b[1] * k}`} {...common} />
  if (tool === 'arrow') {
    return (
      <>
        <path d={`M ${a[0] * k} ${a[1] * k} L ${b[0] * k} ${b[1] * k}`} {...common} />
        <path d={arrowHeadD(a, b, width, k)} {...common} />
      </>
    )
  }
  const x = Math.min(a[0], b[0]) * k
  const y = Math.min(a[1], b[1]) * k
  const w = Math.abs(b[0] - a[0]) * k
  const h = Math.abs(b[1] - a[1]) * k
  if (tool === 'rect') return <rect x={x} y={y} width={w} height={h} rx={2} {...common} />
  return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
}

const InkLayer = memo(function InkLayer({ pageIndex, geom, stageW, stageH, stageRef }: InkLayerProps) {
  const ink = useReader((s) => s.ink)
  const annotations = useReader((s) => s.annotations)
  /** 绘制中的笔迹（page 单位；仅本组件消费，落库后清除） */
  const [live, setLive] = useState<InkStroke | null>(null)
  const drawingRef = useRef(false)

  const pageInks = useMemo(
    () => annotations.filter((a) => a.type === 'ink' && a.page_no === pageIndex + 1 && a.ink),
    [annotations, pageIndex],
  )

  /** client 坐标 → page 单位（÷stretch → ÷hiScale，缩放防抖期间实时换算） */
  const clientToPage = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const stageEl = stageRef.current
      if (!stageEl) return [0, 0]
      const sr = stageEl.getBoundingClientRect()
      const layoutW = stageEl.offsetWidth || sr.width
      const stretch = layoutW > 0 ? sr.width / layoutW : 1
      const sx = (clientX - sr.left) / (stretch || 1)
      const sy = (clientY - sr.top) / (stretch || 1)
      return [sx / geom.scale, sy / geom.scale]
    },
    [stageRef, geom.scale],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!ink.active || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = true
      setLive({ tool: ink.tool, color: ink.color, width: ink.width, points: [clientToPage(e.clientX, e.clientY)] })
    },
    [ink, clientToPage],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!drawingRef.current) return
      const p = clientToPage(e.clientX, e.clientY)
      setLive((cur) => {
        if (!cur) return cur
        if (cur.tool === 'pen' || cur.tool === 'highlighter') {
          const last = cur.points[cur.points.length - 1]
          if (last) {
            const d = Math.hypot(p[0] - last[0], p[1] - last[1])
            if (d < MIN_POINT_DIST) return cur
          }
          return { ...cur, points: [...cur.points, p] }
        }
        return { ...cur, points: [cur.points[0], p] }
      })
    },
    [clientToPage],
  )

  const onPointerUp = useCallback(
    async () => {
      if (!drawingRef.current) return
      drawingRef.current = false
      const stroke = live
      setLive(null)
      if (!stroke) return
      // 钳制到页内 + 有效性（freehand ≥2 点；图形零位移单击/误触丢弃）
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))
      const points = stroke.points.map(
        ([x, y]) => [clamp(x, geom.baseW), clamp(y, geom.baseH)] as [number, number],
      )
      if (!isCommittableStroke({ tool: stroke.tool, points })) return
      const paperId = useReader.getState().paper?.id
      if (!paperId) return
      try {
        const raw = await createAnnotation(paperId, {
          page_no: pageIndex + 1,
          type: 'ink',
          anchor_json: JSON.stringify({ tool: stroke.tool, color: stroke.color, width: stroke.width, points }),
        })
        useReader.getState().upsertAnnotation(parseAnnotation(raw))
        useReaderBus.getState().bumpAnnotations()
      } catch {
        toast('笔迹保存失败', 'error')
      }
    },
    [live, pageIndex, geom.baseW, geom.baseH],
  )

  return (
    <svg
      className={`ink-svg ${ink.active ? 'ink-active' : ''}`}
      width={stageW}
      height={stageH}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {pageInks.map((a) => (
        <StrokeShape key={`ink-${a.id}`} stroke={a.ink!} k={geom.scale} />
      ))}
      {live && <StrokeShape stroke={live} k={geom.scale} />}
    </svg>
  )
})

export default InkLayer
