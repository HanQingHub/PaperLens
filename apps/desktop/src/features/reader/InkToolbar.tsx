// 画笔浮动工具条：自由笔触（画笔/荧光笔）+ 图形选择面板（入口按钮 1 个，鼠标悬浮/
// 触摸点按展开 21 种图形）+ 橡皮擦 + 6 色 + 3 档粗细（粗细档复用为擦除半径）+ 撤回 + 清除本页 + 退出。
// 撤回 = 删除最近一笔 ink 批注（max(id)），执行前等在途笔迹操作（落库 POST/擦除 DELETE）
// 落定再按最新 store 计算目标，404（笔迹已不存在）按已删除处理；清除本页 = 删除当前页全部 ink，口径同；
// 橡皮擦 = 点按/拖过删除命中的整笔。
// 键盘：Ctrl+Z 撤回 / Esc 退出（图形面板开着先关面板；input/textarea 聚焦时不抢占）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useReader, type InkTool } from '../../stores/readerStore'
import { settleInkOps, useReaderBus } from '../../stores/readerBus'
import { outlinePathD } from './inkStroke'
import { toast } from '../shared/Toast'

const I = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

// 自由笔触平铺（图形收敛进 SHAPE_ITEMS 面板：行内单入口，紧跟自由笔触，橡皮擦随其后）
const TOOL_ITEMS: { key: InkTool; icon: string; title: string }[] = [
  { key: 'pen', icon: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', title: '画笔' },
  { key: 'highlighter', icon: 'M9 11l-6 6v3h9l3-3 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z', title: '荧光笔' },
]

const ERASER_ITEM = {
  key: 'eraser' as InkTool,
  icon: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21 M22 21H7 M5 11l9 9',
  title: '橡皮擦（点按/拖过删除整笔）',
}

// 图形面板目录（21 种）：既有工具沿用图标 path；折线族由 outlinePathD 以固定包围盒
// 生成——面板图标与实际落笔几何同源，所见即所得
const SHAPE_ITEMS: { key: InkTool; icon: string; title: string }[] = [
  { key: 'line', icon: 'M5 19L19 5', title: '直线' },
  { key: 'arrow', icon: 'M5 19L19 5 M9 5h10v10', title: '箭头' },
  { key: 'dblArrow', icon: 'M5 19L19 5 M9 5h10v10 M15 19H5v-10', title: '双向箭头' },
  { key: 'rect', icon: 'M5 5h14v14H5z', title: '矩形' },
  { key: 'roundRect', icon: outlinePathD('roundRect', [5, 6], [19, 18], 1), title: '圆角矩形' },
  { key: 'ellipse', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', title: '椭圆' },
  { key: 'circle', icon: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', title: '圆（拖出直径两端点）' },
  { key: 'tri', icon: 'M12 5l9 14H3z', title: '三角形' },
  { key: 'triRight', icon: 'M5 5v14h14z', title: '直角三角形' },
  { key: 'diamond', icon: 'M12 3l9 9-9 9-9-9z', title: '菱形' },
  { key: 'trapezoid', icon: 'M8 6h8l4 12H4z', title: '梯形' },
  { key: 'parallelogram', icon: outlinePathD('parallelogram', [5, 6], [19, 18], 1), title: '平行四边形' },
  { key: 'pentagon', icon: outlinePathD('pentagon', [5, 6], [19, 18], 1), title: '五边形' },
  { key: 'hexagon', icon: outlinePathD('hexagon', [5, 6], [19, 18], 1), title: '六边形' },
  { key: 'octagon', icon: outlinePathD('octagon', [5, 6], [19, 18], 1), title: '八边形' },
  { key: 'star', icon: outlinePathD('star', [5, 6], [19, 18], 1), title: '五角星' },
  { key: 'heart', icon: outlinePathD('heart', [5, 6], [19, 18], 1), title: '心形' },
  { key: 'cross', icon: outlinePathD('cross', [5, 6], [19, 18], 1), title: '十字' },
  { key: 'cylinder', icon: outlinePathD('cylinder', [5, 6], [19, 18], 1), title: '圆柱' },
  { key: 'semicircle', icon: outlinePathD('semicircle', [5, 6], [19, 18], 1), title: '半圆' },
  { key: 'arc', icon: outlinePathD('arc', [5, 6], [19, 18], 1), title: '弧线' },
]

/** 入口按钮在未选中图形工具时显示的通用图标（方 + 圆组合） */
const SHAPES_ICON = 'M4 5h7v7H4z M13 13h7v7h-7z M16.5 4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z'

const COLORS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#2a2f36']
const WIDTHS = [1.5, 3, 5]

export default function InkToolbar() {
  const ink = useReader((s) => s.ink)
  const setInk = useReader((s) => s.setInk)
  const annotations = useReader((s) => s.annotations)
  const currentPage = useReader((s) => s.currentPage)
  const [busy, setBusy] = useState(false)
  const [shapeOpen, setShapeOpen] = useState(false)
  const shapeWrapRef = useRef<HTMLDivElement>(null)

  const inkAnnos = useMemo(() => annotations.filter((a) => a.type === 'ink'), [annotations])
  const pageInkCount = useMemo(
    () => inkAnnos.filter((a) => a.page_no === currentPage).length,
    [inkAnnos, currentPage],
  )
  const currentShape = SHAPE_ITEMS.find((s) => s.key === ink.tool)

  const undo = async () => {
    if (busy) return
    setBusy(true)
    try {
      // 在途笔迹 POST/擦除 DELETE 先落定：否则按 store 快照取 max(id) 会错删上一笔、
      // 漏掉刚画仍在途的笔
      await settleInkOps()
      const inkAnnos = useReader.getState().annotations.filter((a) => a.type === 'ink')
      if (!inkAnnos.length) return
      const last = inkAnnos.reduce((m, a) => (a.id > m.id ? a : m))
      try {
        await api.deleteAnnotation(last.id)
      } catch (e) {
        // 404 = 笔迹已不存在（复活对齐前的残留/重复撤回）：按已删除处理；
        // 其余失败保留笔迹
        if (!(e instanceof ApiError && e.status === 404)) {
          toast('撤回失败', 'error')
          return
        }
      }
      useReader.getState().removeAnnotation(last.id)
      useReaderBus.getState().bumpAnnotations()
    } finally {
      setBusy(false)
    }
  }

  const clearPage = async () => {
    if (busy) return
    setBusy(true)
    try {
      // 在途笔迹操作先落定（同 undo）：清除后新笔落库不残留
      await settleInkOps()
      const st = useReader.getState()
      const page = st.currentPage
      const doomed = st.annotations.filter((a) => a.type === 'ink' && a.page_no === page)
      if (!doomed.length) return
      const results = await Promise.allSettled(doomed.map((a) => api.deleteAnnotation(a.id)))
      // 只从 store 移除删除成功的笔（404 = 已不存在，按成功处理；其余失败的保留，
      // 重开文档与服务器一致）
      const doomedIds = new Set(doomed.map((a) => a.id))
      const failedIds = new Set(
        doomed
          .filter((_, i) => {
            const r = results[i]
            return r.status === 'rejected' && !(r.reason instanceof ApiError && r.reason.status === 404)
          })
          .map((a) => a.id),
      )
      useReader
        .getState()
        .setAnnotations(
          useReader.getState().annotations.filter((a) => !doomedIds.has(a.id) || failedIds.has(a.id)),
        )
      useReaderBus.getState().bumpAnnotations()
      const failed = failedIds.size
      toast(failed ? `已清除 ${doomed.length - failed} 笔，${failed} 笔删除失败` : `已清除本页 ${doomed.length} 笔`, failed ? 'error' : 'ok')
    } finally {
      setBusy(false)
    }
  }

  // 图形面板外点关闭：capture 相位——画布 pointerdown 被 InkLayer stopPropagation
  // 截断冒泡（React 19 root 容器派发），capture 监听不受影响；关面板与起笔互不干扰
  useEffect(() => {
    if (!shapeOpen) return
    const onDoc = (e: PointerEvent) => {
      if (shapeWrapRef.current && !shapeWrapRef.current.contains(e.target as Node)) setShapeOpen(false)
    }
    document.addEventListener('pointerdown', onDoc, { capture: true })
    return () => document.removeEventListener('pointerdown', onDoc, { capture: true })
  }, [shapeOpen])

  // 键盘：Ctrl+Z 撤回 / Esc 关面板或退出（输入控件聚焦时不抢占）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useReader.getState()
      if (!st.ink.active) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undo()
      } else if (e.key === 'Escape') {
        if (shapeOpen) setShapeOpen(false)
        else st.setInk({ active: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // undo 闭包依赖 busy（批注列表经 getState() 现读）；shapeOpen 供 Esc 分支——
    // 无依赖数组每渲染重挂，捕获恒新
  })

  const btn = (on: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
      on ? 'bg-accent-soft text-accent' : 'text-text-soft hover:bg-bg-soft hover:text-text'
    }`

  return (
    <div className="glass fade-in absolute left-1/2 top-12 z-30 flex max-w-[calc(100vw-2.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border border-border px-2 py-1.5 shadow-[var(--shadow-2)]">
      {TOOL_ITEMS.map((t) => (
        <button key={t.key} className={btn(ink.tool === t.key)} title={t.title} onClick={() => setInk({ tool: t.key })}>
          <I d={t.icon} />
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-border-strong" />

      {/* 图形入口：鼠标悬浮展开（触控笔同鼠标）、触摸点按开合；面板项触摸命中区 36px */}
      <div
        ref={shapeWrapRef}
        className="relative"
        onPointerEnter={(e) => {
          if (e.pointerType !== 'touch') setShapeOpen(true)
        }}
        onPointerLeave={(e) => {
          // 触摸 tap 后隐式释放会以 pointerType='touch' 触发 leave——守卫防误关
          if (e.pointerType !== 'touch') setShapeOpen(false)
        }}
      >
        <button
          className={btn(currentShape != null)}
          title={currentShape ? `图形（当前：${currentShape.title}）` : '图形'}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') setShapeOpen((v) => !v)
            else setShapeOpen(true)
          }}
        >
          <I d={currentShape ? currentShape.icon : SHAPES_ICON} />
        </button>
        {shapeOpen && (
          <div className="glass fade-in absolute left-1/2 top-full z-40 mt-2 grid w-[248px] -translate-x-1/2 grid-cols-5 gap-1 rounded-xl border border-border p-2 shadow-[var(--shadow-2)]">
            {SHAPE_ITEMS.map((s) => (
              <button
                key={s.key}
                className={`flex h-9 items-center justify-center rounded-md transition-colors ${
                  ink.tool === s.key ? 'bg-accent-soft text-accent' : 'text-text-soft hover:bg-bg-soft hover:text-text'
                }`}
                title={s.title}
                onClick={() => {
                  setInk({ tool: s.key })
                  setShapeOpen(false)
                }}
              >
                <I d={s.icon} size={20} />
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="mx-1 h-4 w-px bg-border-strong" />

      <button className={btn(ink.tool === ERASER_ITEM.key)} title={ERASER_ITEM.title} onClick={() => setInk({ tool: ERASER_ITEM.key })}>
        <I d={ERASER_ITEM.icon} />
      </button>

      <span className="mx-1 h-4 w-px bg-border-strong" />

      {COLORS.map((c) => (
        <button
          key={c}
          className={`h-5 w-5 rounded-full border-2 transition-transform ${ink.color === c ? 'scale-110 border-accent' : 'border-transparent hover:scale-110'}`}
          style={{ background: c }}
          title="笔迹颜色"
          onClick={() => setInk({ color: c })}
        />
      ))}

      <span className="mx-1 h-4 w-px bg-border-strong" />

      {WIDTHS.map((w, i) => (
        <button
          key={w}
          className={`${btn(ink.width === w)} h-7 w-7`}
          title={`粗细：${['细', '中', '粗'][i]}`}
          onClick={() => setInk({ width: w })}
        >
          <span className="rounded-full" style={{ width: 4 + i * 4, height: 4 + i * 4, background: ink.color }} />
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-border-strong" />

      <button className={`${btn(false)} ${!inkAnnos.length || busy ? 'opacity-40' : ''}`} title="撤回最近一笔 (Ctrl+Z)" disabled={!inkAnnos.length || busy} onClick={undo}>
        <I d="M3 7v6h6 M21 17a9 9 0 0 0-15-6.7L3 13" />
      </button>
      <button
        className={`${btn(false)} ${!pageInkCount || busy ? 'opacity-40' : ''}`}
        title={`清除本页笔迹（当前 ${pageInkCount} 笔）`}
        disabled={!pageInkCount || busy}
        onClick={clearPage}
      >
        <I d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6" />
      </button>

      <span className="mx-1 h-4 w-px bg-border-strong" />

      <button className={btn(false)} title="退出绘制 (Esc)" onClick={() => setInk({ active: false })}>
        <I d="M18 6L6 18 M6 6l12 12" />
      </button>
    </div>
  )
}
