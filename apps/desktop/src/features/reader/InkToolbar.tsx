// 画笔浮动工具条：6 绘制工具 + 橡皮擦 + 6 色 + 3 档粗细（粗细档复用为擦除半径）+ 撤回 + 清除本页 + 退出。
// 撤回 = 删除最近一笔 ink 批注（max(id)）；清除本页 = 删除当前页全部 ink；橡皮擦 = 点按/拖过删除命中的整笔。
// 键盘：Ctrl+Z 撤回 / Esc 退出（input/textarea 聚焦时不抢占）。
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { useReader, type InkTool } from '../../stores/readerStore'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'

const I = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const TOOLS: { key: InkTool; icon: string; title: string }[] = [
  { key: 'pen', icon: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', title: '画笔' },
  { key: 'highlighter', icon: 'M9 11l-6 6v3h9l3-3 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z', title: '荧光笔' },
  { key: 'line', icon: 'M5 19L19 5', title: '直线' },
  { key: 'arrow', icon: 'M5 19L19 5 M9 5h10v10', title: '箭头' },
  { key: 'rect', icon: 'M5 5h14v14H5z', title: '矩形' },
  { key: 'ellipse', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', title: '椭圆' },
  {
    key: 'eraser',
    icon: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21 M22 21H7 M5 11l9 9',
    title: '橡皮擦（点按/拖过删除整笔）',
  },
]

const COLORS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#2a2f36']
const WIDTHS = [1.5, 3, 5]

export default function InkToolbar() {
  const ink = useReader((s) => s.ink)
  const setInk = useReader((s) => s.setInk)
  const annotations = useReader((s) => s.annotations)
  const currentPage = useReader((s) => s.currentPage)
  const [busy, setBusy] = useState(false)

  const inkAnnos = useMemo(() => annotations.filter((a) => a.type === 'ink'), [annotations])
  const pageInkCount = useMemo(
    () => inkAnnos.filter((a) => a.page_no === currentPage).length,
    [inkAnnos, currentPage],
  )

  const undo = async () => {
    if (busy || !inkAnnos.length) return
    const last = inkAnnos.reduce((m, a) => (a.id > m.id ? a : m))
    setBusy(true)
    try {
      await api.deleteAnnotation(last.id)
      useReader.getState().removeAnnotation(last.id)
      useReaderBus.getState().bumpAnnotations()
    } catch {
      toast('撤回失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const clearPage = async () => {
    if (busy || !pageInkCount) return
    const doomed = inkAnnos.filter((a) => a.page_no === currentPage)
    setBusy(true)
    try {
      const results = await Promise.allSettled(doomed.map((a) => api.deleteAnnotation(a.id)))
      // 只从 store 移除删除成功的笔（失败的保留，重开文档与服务器一致）
      const doomedIds = new Set(doomed.map((a) => a.id))
      const failedIds = new Set(
        doomed.filter((_, i) => results[i].status === 'rejected').map((a) => a.id),
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

  // 键盘：Ctrl+Z 撤回 / Esc 退出（输入控件聚焦时不抢占）
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
        st.setInk({ active: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // undo 经 inkAnnos 闭包捕获最新列表：依赖 busy/inkAnnos 变化重挂
  })

  const btn = (on: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
      on ? 'bg-accent-soft text-accent' : 'text-text-soft hover:bg-bg-soft hover:text-text'
    }`

  return (
    <div className="glass fade-in absolute left-1/2 top-12 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border px-2 py-1.5 shadow-[var(--shadow-2)]">
      {TOOLS.map((t) => (
        <button key={t.key} className={btn(ink.tool === t.key)} title={t.title} onClick={() => setInk({ tool: t.key })}>
          <I d={t.icon} />
        </button>
      ))}

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
