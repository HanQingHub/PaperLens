// 画笔层：自由笔触（pen/highlighter）与图形（line/arrow/dblArrow/rect/ellipse/circle/
// tri/triRight/diamond/trapezoid）采集 + 渲染 + 橡皮擦。
//  - 挂 PageView 舞台内，z-index 6（高于批注层 3-5）：激活时拦截指针（绘制/擦除模式），
//    未激活时 pointer-events:none 纯展示（不挡批注卡片/锚点交互）。
//  - 坐标：采集 client → 舞台局部（÷stretch，SelectionOverlay 同款）→ page 单位
//    （÷hiScale）；持久化为 page 单位，任意缩放下渲染只需 ×hiScale。
//  - 每笔一行 type='ink' 批注（anchor_json={tool,color,width,points}），撤回=删行。
//  - 橡皮擦（eraser）：点按/拖过删除命中的整笔（行删除语义，与撤回同源），永不落库。
//  - 双指手势让渡：touch 绘制/擦除中第二指落下 → 取消当前手势（live 弃笔/擦除结算），
//    touch 冒泡到容器由 ReaderPage 捏合监听接管缩放；异类型指针（鼠标/触控笔）不受影响。
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { api, createAnnotation } from '../../api/client'
import { parseAnnotation, useReader, type InkStroke } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'
import { MIN_POINT_DIST, arrowHeadD, boxShapePolygons, eraserRadius, hitTestInkStroke, isCommittableStroke, smoothPathD } from './inkStroke'

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
  if (tool === 'dblArrow') {
    return (
      <>
        <path d={`M ${a[0] * k} ${a[1] * k} L ${b[0] * k} ${b[1] * k}`} {...common} />
        <path d={arrowHeadD(a, b, width, k)} {...common} />
        <path d={arrowHeadD(b, a, width, k)} {...common} />
      </>
    )
  }
  if (tool === 'circle') {
    // 直径两端点语义：a/b 为圆直径两端（圆规式拖拽）
    return (
      <circle
        cx={((a[0] + b[0]) / 2) * k}
        cy={((a[1] + b[1]) / 2) * k}
        r={(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) * k}
        {...common}
      />
    )
  }
  const x = Math.min(a[0], b[0]) * k
  const y = Math.min(a[1], b[1]) * k
  const w = Math.abs(b[0] - a[0]) * k
  const h = Math.abs(b[1] - a[1]) * k
  if (tool === 'rect') return <rect x={x} y={y} width={w} height={h} rx={2} {...common} />
  if (tool === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
  if (tool === 'tri' || tool === 'triRight' || tool === 'diamond' || tool === 'trapezoid') {
    const d = boxShapePolygons(tool, a, b)
      .map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px * k} ${py * k}`)
      .join(' ')
    return <path d={`${d} Z`} {...common} />
  }
  return null
}

const InkLayer = memo(function InkLayer({ pageIndex, geom, stageW, stageH, stageRef }: InkLayerProps) {
  const ink = useReader((s) => s.ink)
  const annotations = useReader((s) => s.annotations)
  /** 绘制中的笔迹（page 单位；仅本组件消费，落库后清除） */
  const [live, setLive] = useState<InkStroke | null>(null)
  const drawingRef = useRef(false)
  /** 当前活动指针（首指 pointerId）：触摸多指时第二指的 move/up 不污染笔画、
   *  不提前结算（触摸 pointer 有 implicit capture，仅 isPrimary 守卫挡不住后续事件） */
  const activePointerId = useRef<number | null>(null)
  /** 活动指针类型（touch/pen/mouse）：双指手势让渡仅对 touch→touch 生效。
   *  手势结束不复位——读取以 activePointerId 非空为前提，且每次新手势必然覆写 */
  const activePointerType = useRef<string | null>(null)
  /** 擦除手势进行中（eraser 工具落笔后至抬起） */
  const erasingRef = useRef(false)
  /** 已发删除请求、待服务端确认的批注 id（防拖擦重复发） */
  const deletingRef = useRef(new Set<number>())
  /** 在途删除 promise（抬笔时等待全部落定再 bump，避免 GET 重拉跑赢 DELETE 致已删笔复活） */
  const pendingDeletesRef = useRef<Promise<void>[]>([])
  /** 本次擦除手势计数（ok 含失败回补前的值；eraseAt 失败回写闭包捕获本对象，
   *  结算换代后旧对象仍归属本手势——抬笔时一次性 toast + bump） */
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
      const stats = eraseStatsRef.current
      for (const h of hits) {
        deletingRef.current.add(h.id)
        st.removeAnnotation(h.id)
        stats.ok += 1
        const p = api
          .deleteAnnotation(h.id)
          .then(
            () => {},
            () => {
              // 失败回写闭包捕获本手势的计数对象：结算把 ref 换代到新对象后，
              // 在途失败的回写仍落旧对象——await 后读旧对象不丢计数，也不污染后续手势
              stats.failed += 1
              stats.ok -= 1
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

  /** 擦除结算（抬笔与双指取消共用）：等在途 DELETE 全部落定再 bump，防已删笔复活。
   *  计数对象在 await 前换代（后续手势/笔画拿到的全新对象不受旧失败回写污染），
   *  本手势快照在 await 后读取（在途 DELETE 的失败回写落在本手势对象上，不丢）；
   *  重入（结算后再进）看到零计数即空转，幂等。 */
  const settleEraser = useCallback(async () => {
    erasingRef.current = false
    const stats = eraseStatsRef.current
    eraseStatsRef.current = { ok: 0, failed: 0 }
    const pending = pendingDeletesRef.current
    pendingDeletesRef.current = []
    if (pending.length) await Promise.allSettled(pending)
    if (stats.ok > 0 || stats.failed > 0) {
      if (stats.failed > 0) toast(`已擦除 ${stats.ok} 笔，${stats.failed} 笔失败，已与服务器对齐`, 'error')
      useReaderBus.getState().bumpAnnotations()
    }
  }, [])

  /** 双指手势让渡：第二根手指落下时取消进行中的笔画/擦除，手势交给容器捏合缩放
   *  （触屏绘图软件标准语义：单指画、双指起即弃笔转缩放）。绘制中的 live 笔迹
   *  未落库直接弃（无网络请求）；擦除走与抬笔相同的结算（在途 DELETE 落定再 bump）。 */
  const cancelActiveGesture = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const id = activePointerId.current
      activePointerId.current = null
      if (id !== null) {
        try {
          e.currentTarget.releasePointerCapture(id)
        } catch {
          /* 指针已消失：捕获随之中止，静默 */
        }
      }
      if (drawingRef.current) {
        drawingRef.current = false
        setLive(null)
      }
      if (erasingRef.current) void settleEraser()
    },
    [settleEraser],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // 双指手势让渡：活动指针存续期间收到同为 touch 的新 down → 取消当前手势。
      // 异类型（鼠标/触控笔绘制中手指落下）不取消，仅拦截。此块必须位于下方
      // isPrimary 守卫之前：第二根 touch 手指 isPrimary=false，会在下方守卫的
      // !e.isPrimary 处短路，放后面则取消路径永不可达。
      if (activePointerId.current !== null) {
        if (activePointerType.current === 'touch' && e.pointerType === 'touch') {
          cancelActiveGesture(e)
        }
        return
      }
      // isPrimary：触摸第二指（双指捏合/多指）不开启新笔画/擦除；后续事件由
      // activePointerId 过滤（见上注释）。活动指针存续期间（activePointerId 非
      // null）拦截一切后续 down——含异类型 primary（如鼠标绘制中落下的第一根
      // 手指，其 isPrimary=true 但属新手势，防止覆写 activePointerId 并重置 live）
      if (!ink.active || e.button !== 0 || !e.isPrimary || activePointerId.current !== null) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      activePointerId.current = e.pointerId
      activePointerType.current = e.pointerType
      if (ink.tool === 'eraser') {
        erasingRef.current = true
        eraseStatsRef.current = { ok: 0, failed: 0 }
        eraseAt(clientToPage(e.clientX, e.clientY))
        return
      }
      drawingRef.current = true
      setLive({ tool: ink.tool, color: ink.color, width: ink.width, points: [clientToPage(e.clientX, e.clientY)] })
    },
    [ink, clientToPage, eraseAt, cancelActiveGesture],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // 非活动指针（触摸第二指 move / 首指结算后的悬停）：不污染笔画、不误擦
      if (e.pointerId !== activePointerId.current) return
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
    async (e: React.PointerEvent<SVGSVGElement>) => {
      // 非活动指针（触摸第二指抬起）：不结算、不截断第一笔
      if (e.pointerId !== activePointerId.current) return
      activePointerId.current = null
      // 擦除结束结算：正常抬笔，或 Esc 中途退出后（erasing 已清，但有在途/已删计数仍需结算）
      const st = eraseStatsRef.current
      if (erasingRef.current || st.ok > 0 || st.failed > 0 || pendingDeletesRef.current.length > 0) {
        await settleEraser()
        return
      }
      if (!drawingRef.current) return
      drawingRef.current = false
      const stroke = live
      // 抬笔不清 live：保持笔迹可见直至落库替换，消除"清除→网络往返→重现"
      // 的落库空窗闪烁（频闪根因）
      if (!stroke) return
      // 钳制到页内 + 有效性（freehand ≥1 点：单击成点；图形零位移单击/误触丢弃）
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))
      const points = stroke.points.map(
        ([x, y]) => [clamp(x, geom.baseW), clamp(y, geom.baseH)] as [number, number],
      )
      if (!isCommittableStroke({ tool: stroke.tool, points })) {
        setLive(null)
        return
      }
      const paperId = useReader.getState().paper?.id
      if (!paperId) {
        setLive(null)
        return
      }
      try {
        const raw = await createAnnotation(paperId, {
          page_no: pageIndex + 1,
          type: 'ink',
          anchor_json: JSON.stringify({ tool: stroke.tool, color: stroke.color, width: stroke.width, points }),
        })
        // upsert 与清 live 同一微任务：React 19 自动批处理合并为一次 commit——
        // pageInks 新笔挂载与 live 卸载原子切换，零空窗零闪烁
        useReader.getState().upsertAnnotation(parseAnnotation(raw))
        setLive((cur) => (cur === stroke ? null : cur))
        useReaderBus.getState().bumpAnnotations()
      } catch {
        // 引用守卫：await 期间已落第二笔（live 引用已变）时不误清新笔
        setLive((cur) => (cur === stroke ? null : cur))
        toast('笔迹保存失败', 'error')
      }
    },
    [live, pageIndex, geom.baseW, geom.baseH, settleEraser],
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
