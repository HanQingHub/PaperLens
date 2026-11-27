import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

/**
 * 层析切片：一篇论文被切成 7 层（摘要 / 公式 / 图 / 表 / 路由热图 / 生词 / 批注），沿 Z 轴叠放。
 * 用于启动屏、登录页、首启向导封面。3D 只作用于本组件自身容器；motion=false 时无入场与视差。
 */

const HEAT = Array.from({ length: 48 }, (_, i) => {
  const v = ((i * 37) % 53) / 53
  return 0.12 + v * v * 0.88
})

const PLATES: { k: string; body: ReactNode }[] = [
  {
    k: 'ABSTRACT',
    body: (
      <>
        <div className="pnx-sx-pl-lines"><i style={{ width: '92%' }} /><i style={{ width: '86%' }} /><i style={{ width: '95%' }} /><i style={{ width: '70%' }} /><i style={{ width: '88%' }} /><i style={{ width: '52%' }} /></div>
        <div className="pnx-sx-pl-cap">摘要 · 64k token / −41% 显存</div>
      </>
    ),
  },
  {
    k: 'EQ. (2)',
    body: (
      <>
        <div className="pnx-sx-pl-eq"><i>α</i><sub>ij</sub> = softmax<span className="pnx-sx-pl-paren">(</span><span className="pnx-sx-pl-frac"><span><i>q</i><sub>i</sub><i>k</i><sub>j</sub><sup>⊤</sup></span><span>√<i>d</i></span></span><span className="pnx-sx-pl-paren">)</span> · <i>m</i><sub>ij</sub></div>
        <div className="pnx-sx-pl-cap">层级路由掩码</div>
      </>
    ),
  },
  {
    k: 'FIG. 2',
    body: (
      <>
        <svg viewBox="0 0 240 110" className="pnx-sx-pl-svg" aria-hidden="true">
          <path d="M10 100H232M10 100V8" stroke="currentColor" strokeWidth="1" fill="none" />
          <path d="M10 84 50 75 90 60 130 51 170 34 210 22 232 18V34L210 38 170 48 130 65 90 72 50 85 10 92z" fill="var(--sx-accent)" opacity=".14" />
          <path d="M10 88 50 80 90 66 130 58 170 41 210 30 232 26" fill="none" stroke="var(--sx-accent)" strokeWidth="2.4" />
          <path d="M10 92 50 88 90 82 130 80 170 76 210 74 232 73" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="4 3" />
        </svg>
        <div className="pnx-sx-pl-cap">F1 随文档长度 · 4k→64k</div>
      </>
    ),
  },
  {
    k: 'TABLE 1',
    body: (
      <div className="pnx-sx-pl-table">
        <b>模型</b><b>4k</b><b>16k</b><b>64k</b>
        <span>Dense</span><span>71.2</span><span>66.0</span><span>—</span>
        <span>Longformer</span><span>70.4</span><span>67.9</span><span>61.3</span>
        <span className="acc">HSA</span><span className="acc">72.0</span><span className="acc">70.8</span><span className="acc">68.5</span>
      </div>
    ),
  },
  {
    k: 'ROUTING',
    body: (
      <>
        <div className="pnx-sx-pl-heat">{HEAT.map((o, i) => <i key={i} style={{ opacity: o }} />)}</div>
        <div className="pnx-sx-pl-cap">章节 × 段落 路由权重</div>
      </>
    ),
  },
  {
    k: 'LEXICON',
    body: (
      <div className="pnx-sx-pl-word"><b>sparsity</b><span>/ˈspɑːrsəti/</span><em>n. 稀疏性；非零元素所占比例很小的性质</em></div>
    ),
  },
  {
    k: 'NOTE · P.3',
    body: (
      <>
        <div className="pnx-sx-pl-note"><span>批注 04</span>路由温度 τ 的退火起点应与表 1 设置对照。</div>
        <div className="pnx-sx-pl-lines"><i style={{ width: '80%' }} /><i style={{ width: '64%' }} /></div>
      </>
    ),
  },
]

export default function NextStrataSlices({ size = 'lg', motion, parallax = false }: { size?: 'sm' | 'lg'; motion: boolean; parallax?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !motion || !parallax) return
    const host = wrap.closest<HTMLElement>('.pnx-root') ?? wrap
    let frame = 0
    let tx = 0
    let ty = 0
    const onMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      tx = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5
      ty = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        wrap.style.setProperty('--sx-px', `${(tx * 10).toFixed(2)}deg`)
        wrap.style.setProperty('--sx-py', `${(-ty * 6).toFixed(2)}deg`)
      })
    }
    host.addEventListener('pointermove', onMove)
    return () => {
      host.removeEventListener('pointermove', onMove)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [motion, parallax])

  return (
    <div ref={wrapRef} className={`pnx-sx-slices pnx-sx-slices-${size}${motion ? ' pnx-sx-slices-motion' : ' pnx-sx-flat'}`} aria-hidden="true">
      <div className="pnx-sx-slices-stack">
        {PLATES.map((plate, i) => (
          <div className="pnx-sx-plate" key={plate.k} style={{ '--i': i } as CSSProperties}>
            <div className="pnx-sx-plate-face">
              <div className="pnx-sx-plate-head"><span>L{String(i + 1).padStart(2, '0')}</span><span>{plate.k}</span></div>
              {plate.body}
            </div>
          </div>
        ))}
      </div>
      <div className="pnx-sx-slices-axis"><span>Z +7</span><span>Z 0</span></div>
    </div>
  )
}
