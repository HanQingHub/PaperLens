// 画笔层：自由笔触（pen/highlighter）与图形（line/arrow/rect/ellipse）采集 + 渲染 + 橡皮擦。
//  - 挂 PageView 舞台内，z-index 6（高于批注层 3-5）：激活时拦截指针（绘制/擦除模式），
//    未激活时 pointer-events:none 纯展示（不挡批注卡片/锚点交互）。
//  - 坐标：采集 client → 舞台局部（÷stretch，SelectionOverlay 同款）→ page 单位
//    （÷hiScale）；持久化为 page 单位，任意缩放下渲染只需 ×hiScale。
//  - 每笔一行 type='ink' 批注（anchor_json={tool,color,width,points}），撤回=删行。
//  - 橡皮擦（eraser）：点按/拖过删除命中的整笔（行删除语义，与撤回同源），永不落库。
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { api, createAnnotation } from '../../api/client'
import { parseAnnotation, useReader, type InkStroke } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'
import { MIN_POINT_DIST, arrowHeadD, eraserRadius, hitTestInkStroke, isCommittableStroke, smoothPathD } from './inkStroke'

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
  if (tool === 'eraser') return null // 擦除态永不落库，防御性兜底
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
  /** 擦除手势进行中（eraser 工具落笔后至抬起） */
  const erasingRef = useRef(false)
  /** 已发删除请求、待服务端确认的批注 id（防拖擦重复发） */
  const deletingRef = useRef(new Set<number>())
  /** 在途删除 promise（抬笔时等待全部落定再 bump，避免 GET 重拉跑赢 DELETE 致已删笔复活） */
  const pendingDeletesRef = useRef<Promise<void>[]>([])
  /** 本次擦除手势计数（ok 含失败回补前的值；抬笔时一次性 toast + bump） */
  const eraseStatsRef = useRef({ ok: 0, failed: 0 })

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

  /** 橡皮擦：删除落点半径内的本页整笔（乐观移除 + 服务端删除；抬笔时等在途删除落定后一次重拉对齐） */
  const eraseAt = useCallback(
    (pt: [number, number]) => {
      const radius = eraserRadius(ink.width)
      const hits = pageInks.filter(
        (a) => a.ink && !deletingRef.current.has(a.id) && hitTestInkStroke(a.ink, pt, radius),
      )
      if (!hits.length) return
      const st = useReader.getState()
      for (const h of hits) {
        deletingRef.current.add(h.id)
        st.removeAnnotation(h.id)
        eraseStatsRef.current.ok += 1
        const p = api
          .deleteAnnotation(h.id)
          .then(
            () => {},
            () => {
              eraseStatsRef.current.failed += 1
              eraseStatsRef.current.ok -= 1
            },
          )
          .finally(() => {
            deletingRef.current.delete(h.id)
          })
        pendingDeletesRef.current.push(p)
      }
    },
    [ink.width, pageInks],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!ink.active || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      if (ink.tool === 'eraser') {
        erasingRef.current = true
        eraseStatsRef.current = { ok: 0, failed: 0 }
        eraseAt(clientToPage(e.clientX, e.clientY))
        return
      }
      drawingRef.current = true
      setLive({ tool: ink.tool, color: ink.color, width: ink.width, points: [clientToPage(e.clientX, e.clientY)] })
    },
    [ink, clientToPage, eraseAt],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (erasingRef.current) {
        // Esc 中途退出绘制后停止擦除（抬笔时仍按正常结束结算在途删除）
        if (!useReader.getState().ink.active) {
          erasingRef.current = false
          return
        }
        eraseAt(clientToPage(e.clientX, e.clientY))
        return
      }
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
    [clientToPage, eraseAt],
  )

  const onPointerUp = useCallback(
    async () => {
      // 擦除结束结算：正常抬笔，或 Esc 中途退出后（erasing 已清，但有在途/已删计数仍需结算）
      const st = eraseStatsRef.current
      if (erasingRef.current || st.ok > 0 || st.failed > 0 || pendingDeletesRef.current.length > 0) {
        erasingRef.current = false
        // 等在途 DELETE 全部落定再 bump：否则全量 GET 可能读到删除前快照致已删笔复活
        const pending = pendingDeletesRef.current
        pendingDeletesRef.current = []
        if (pending.length) await Promise.allSettled(pending)
        const { ok, failed } = eraseStatsRef.current
        eraseStatsRef.current = { ok: 0, failed: 0 }
        if (ok > 0 || failed > 0) {
          if (failed > 0) toast(`已擦除 ${ok} 笔，${failed} 笔失败，已与服务器对齐`, 'error')
          useReaderBus.getState().bumpAnnotations()
        }
        return
      }
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
      className={`ink-svg ${ink.active ? 'ink-active' : ''} ${ink.active && ink.tool === 'eraser' ? 'ink-eraser' : ''}`}
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
