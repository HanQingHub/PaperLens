import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Paper } from '../api/types'
import { PITCH, READ_STATE_LABEL, layoutTerrain, terrainCols, terrainRows } from './terrain'

/**
 * 层析 STRATA · 文库地形视图（只读视图：拖拽整理与拖放上传在网格视图进行）。
 * 3D 只作用于 .pnx-sx-ter 自身；位置/高度全部写入 CSS 变量，排序/过滤变化由 transform 过渡完成，体块不重挂载。
 */

const CAMS = {
  iso: { rx: 56, rz: 36, label: '斜轴' },
  low: { rx: 66, rz: 22, label: '低角' },
  top: { rx: 24, rz: 10, label: '俯瞰' },
} as const
type CamKey = keyof typeof CAMS | 'free'

interface Props {
  papers: Paper[]
  selected: Set<number>
  currentId: number | null
  motion: boolean
  onPick: (id: number) => void
  onHover: (id: number | null) => void
  onToggleSelect: (id: number) => void
  onOpen: (id: number, face: HTMLElement | null) => void
}

export default function NextTerrain({ papers, selected, currentId, motion, onPick, onHover, onToggleSelect, onOpen }: Props) {
  const blocks = useMemo(() => layoutTerrain(papers), [papers])
  const cols = terrainCols(papers.length)
  const rows = terrainRows(papers.length)
  const stageRef = useRef<HTMLElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.8)
  const [cam, setCam] = useState<{ rx: number; rz: number; key: CamKey }>({ rx: CAMS.iso.rx, rz: CAMS.iso.rz, key: 'iso' })
  const [intro, setIntro] = useState<'flat' | 'rise' | 'done'>(motion ? 'flat' : 'done')
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; rx: number; rz: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  const hud = papers.find((p) => p.id === currentId)

  // 入场：平铺 → 抬升到机位，体块按对角线依次升起（setTimeout 推进，不依赖 rAF，避免后台节流卡住）
  useEffect(() => {
    if (!motion) { setIntro('done'); return }
    const t1 = window.setTimeout(() => setIntro('rise'), 40)
    const t2 = window.setTimeout(() => setIntro('done'), 1200)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [motion])

  // 缩放适配舞台
  useEffect(() => {
    const view = viewRef.current
    if (!view || typeof ResizeObserver === 'undefined') return
    const fit = () => {
      const r = view.getBoundingClientRect()
      const planeW = cols * PITCH
      const planeH = rows * PITCH
      const sc = Math.min(r.width / (planeW * 1.42), r.height / (planeH * 0.98 + 40))
      setScale(Math.max(0.32, Math.min(1.05, sc)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(view)
    return () => ro.disconnect()
  }, [cols, rows])

  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current) }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    dragRef.current = { x: event.clientX, y: event.clientY, rx: cam.rx, rz: cam.rz, moved: false }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return
    if (!d.moved) {
      d.moved = true
      setDragging(true)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setCam({ rx: Math.round(Math.max(18, Math.min(72, d.rx - dy * 0.25))), rz: Math.round(Math.max(6, Math.min(84, d.rz + dx * 0.3))), key: 'free' })
    })
  }
  const endDrag = () => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.moved) {
      suppressClick.current = true
      window.setTimeout(() => { suppressClick.current = false }, 0)
    }
    setDragging(false)
  }

  const faceOf = (id: number) => stageRef.current?.querySelector<HTMLElement>(`.pnx-sx-blk[data-id="${id}"] .pnx-sx-blk-top`) ?? null

  const onBlockKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number, id: number) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (currentId === id) onOpen(id, faceOf(id))
      else onPick(id)
      return
    }
    if (event.key === ' ') { event.preventDefault(); onToggleSelect(id); return }
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols } as Record<string, number | undefined>)[event.key]
    if (step == null) return
    event.preventDefault()
    const next = Math.max(0, Math.min(papers.length - 1, index + step))
    const target = papers[next]
    if (!target) return
    stageRef.current?.querySelector<HTMLButtonElement>(`.pnx-sx-blk[data-id="${target.id}"]`)?.focus()
    onPick(target.id)
  }

  const rx = intro === 'flat' ? 0 : cam.rx
  const rz = intro === 'flat' ? 0 : cam.rz
  const terStyle = { '--sx-sc': scale.toFixed(3), '--sx-rx': `${rx}deg`, '--sx-rz': `${rz}deg`, width: cols * PITCH - (PITCH - 92), height: rows * PITCH - (PITCH - 92) } as CSSProperties

  return (
    <section ref={stageRef} className={`pnx-sx-stage${dragging ? ' is-dragging' : ''}${intro !== 'done' ? ` is-intro is-${intro}` : ''}${motion ? '' : ' is-still'}`} aria-label="文库地形视图">
      <div className="pnx-sx-hud" aria-hidden>
        <span>{hud ? `${String(papers.indexOf(hud) + 1).padStart(2, '0')} · ${hud.title}` : `STRATA FIELD · ${cols} × ${rows}`}</span>
        <span>{papers.length} 篇 · {selected.size ? `${selected.size} 已选` : '点击查看 · 双击进入阅读台'}</span>
      </div>
      <div
        ref={viewRef}
        className="pnx-sx-view"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { if (!dragRef.current) onHover(null) }}
        onClickCapture={(event) => { if (suppressClick.current) { event.stopPropagation(); event.preventDefault() } }}
      >
        <div className="pnx-sx-ter" style={terStyle}>
          <div className="pnx-sx-floor" aria-hidden>
            <div className="pnx-sx-ring" />
          </div>
          {blocks.map((b, index) => {
            const paper = papers[index]
            const isCur = currentId === b.id
            const isSel = selected.has(b.id)
            const style = {
              '--x': `${b.col * PITCH}px`,
              '--y': `${b.row * PITCH}px`,
              '--h': `${b.h}px`,
              '--hue': b.hue,
              '--d': `${(b.col + b.row) * 34}ms`,
              '--p': `${Math.min(100, Math.round(((paper.open_count || 0) / 6) * 100))}%`,
            } as CSSProperties
            return (
              <button
                key={b.id}
                type="button"
                data-id={b.id}
                data-state={b.state}
                className={`pnx-sx-blk${isCur ? ' is-current' : ''}${isSel ? ' is-selected' : ''}${paper.is_favorite ? ' is-star' : ''}`}
                style={style}
                aria-pressed={isCur}
                aria-label={`${paper.title}，${paper.authors || '作者未知'}${paper.year ? `，${paper.year}` : ''}，${READ_STATE_LABEL[b.state]}，${paper.annotation_count ?? 0} 条批注`}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey || event.shiftKey) { onToggleSelect(b.id); onPick(b.id); return }
                  onPick(b.id)
                }}
                onDoubleClick={() => onOpen(b.id, faceOf(b.id))}
                onKeyDown={(event) => onBlockKey(event, index, b.id)}
                onPointerEnter={() => { if (!dragRef.current) onHover(b.id) }}
                onFocus={() => onHover(b.id)}
                onBlur={() => onHover(null)}
              >
                <span className="pnx-sx-blk-sh" aria-hidden />
                <span className="pnx-sx-blk-e" aria-hidden />
                <span className="pnx-sx-blk-s" aria-hidden />
                <span className="pnx-sx-blk-top" aria-hidden>
                  <span className="pnx-sx-blk-band" />
                  <span className="pnx-sx-blk-num">{String(index + 1).padStart(2, '0')}</span>
                  <span className="pnx-sx-blk-meta">{paper.file_type === 'markdown' ? 'MD' : `${paper.page_count}p`}</span>
                  <span className="pnx-sx-blk-chk">✓</span>
                </span>
                <span className="pnx-sx-blk-tag" aria-hidden><b>{paper.year ?? '—'}</b><span>{paper.title.length > 14 ? `${paper.title.slice(0, 14)}…` : paper.title}</span></span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="pnx-sx-cams" role="group" aria-label="视角">
        <span>视角</span>
        {(Object.keys(CAMS) as (keyof typeof CAMS)[]).map((key) => (
          <button key={key} type="button" className={cam.key === key ? 'is-active' : ''} aria-pressed={cam.key === key} onClick={() => setCam({ rx: CAMS[key].rx, rz: CAMS[key].rz, key })}>{CAMS[key].label}</button>
        ))}
        <small>拖拽旋转</small>
      </div>
      <div className="pnx-sx-legend" aria-hidden>
        <span><i className="lg-h" />高度 = 批注数</span>
        <span><i className="lg-t" />顶面 = 阅读状态</span>
        <span><i className="lg-b" />色带 = 项目</span>
      </div>
    </section>
  )
}
