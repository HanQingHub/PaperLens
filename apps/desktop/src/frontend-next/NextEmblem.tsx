import type { ReactNode } from 'react'
import { rng, seedOf } from './terrain'

/**
 * 论文徽记：按 file_hash 种子生成的构成主义纹章（同一套几何语法：圆 / 斜杠 / 方块 / 三角 / 柱）。
 * 只用 currentColor 与 --sx-* 变量着色，深浅主题自动适配；纯展示、无交互。
 */
export default function NextEmblem({ seedText, hue, label, size = 120 }: { seedText: string; hue: number; label?: string; size?: number }) {
  const seed = seedOf(seedText)
  const r = rng(seed)
  const kind = seed % 4
  const c = `hsl(${hue} 62% 48%)`
  const ink = 'var(--sx-ink)'
  const a = 20 + Math.floor(r() * 40)
  const grid: string[] = []
  for (let g = 15; g < 120; g += 15) grid.push(`M${g} 0V120M0 ${g}H120`)
  let body: ReactNode
  if (kind === 0) {
    body = (
      <>
        <circle cx={Math.round(40 + r() * 40)} cy={58} r={Math.round(26 + r() * 14)} fill={c} />
        <path d={`M8 ${Math.round(90 - a / 3)}L112 ${Math.round(36 + a / 4)}`} stroke={ink} strokeWidth={7} />
        <rect x={70} y={70} width={34} height={34} fill={ink} />
      </>
    )
  } else if (kind === 1) {
    body = (
      <>
        <rect x={14} y={14} width={Math.round(50 + r() * 30)} height={22} fill={ink} />
        <path d={`M14 106L106 ${Math.round(20 + r() * 30)}V106z`} fill={c} />
        <circle cx={34} cy={74} r={12} fill="none" stroke={ink} strokeWidth={5} />
      </>
    )
  } else if (kind === 2) {
    const bars = [0, 1, 2, 3, 4].map((b) => {
      const h = Math.round(18 + r() * 78)
      return <rect key={b} x={14 + b * 19} y={106 - h} width={13} height={h} fill={b === 2 ? c : ink} />
    })
    body = (
      <>
        {bars}
        <path d="M8 30L112 18" stroke={c} strokeWidth={4} />
      </>
    )
  } else {
    body = (
      <>
        <path d="M60 10L110 100H10z" fill={c} />
        <circle cx={60} cy={72} r={Math.round(14 + r() * 8)} fill={ink} />
        <path d={`M0 ${30 + a}H120`} stroke={ink} strokeWidth={3} />
      </>
    )
  }
  return (
    <svg className="pnx-sx-emblem-svg" width={size} height={size} viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <rect width={120} height={120} fill="var(--sx-emblem-bg)" />
      <path d={grid.join('')} stroke="var(--sx-line)" strokeWidth={0.6} fill="none" />
      {body}
      {label && <text x={8} y={114} fontSize={9} fontFamily="var(--sx-mono)" fill={ink}>{label}</text>}
    </svg>
  )
}
