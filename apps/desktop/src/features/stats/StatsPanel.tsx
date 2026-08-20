// 右面板·统计：今日/累计时长、streak、30 天热力图、7 天新增生词柱状图、复习完成率
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { StatsOverview } from '../../api/types'

function fmtDur(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

function heatLevel(seconds: number): 0 | 1 | 2 | 3 | 4 {
  if (seconds <= 0) return 0
  if (seconds < 1800) return 1
  if (seconds < 3600) return 2
  if (seconds < 7200) return 3
  return 4
}

function fmtDateCN(date: string) {
  const [, m, d] = date.split('-')
  return `${Number(m)}月${Number(d)}日`
}

export function StatsPanel() {
  const [stats, setStats] = useState<StatsOverview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : '统计加载失败'))
  }, [])

  if (error) return <div className="p-4 text-xs text-danger">{error}</div>
  if (!stats)
    return (
      <div className="flex justify-center p-8">
        <div className="spinner spinner-lg" />
      </div>
    )

  // 30 天热力图：按周（周一为首列）排布
  const cal = stats.calendar
  const first = cal.length > 0 ? new Date(`${cal[0].date}T00:00:00`) : new Date()
  const pad = (first.getDay() + 6) % 7 // 周一=0
  const cells: ({ date: string; seconds: number } | null)[] = [
    ...Array.from({ length: pad }, () => null),
    ...cal,
  ]
  const weeks: (typeof cells)[] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  const maxNew = Math.max(1, ...stats.words_new_7d.map((d) => d.count))
  const reviewRate =
    stats.review_due_today + stats.review_done_today > 0
      ? Math.round((stats.review_done_today / (stats.review_done_today + stats.review_due_today)) * 100)
      : null

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 时长大数字 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="panel pl-stat-card p-3 text-center">
          <div className="text-[11px] text-text-faint">今日阅读</div>
          <div className="pl-num mt-1 font-serif text-[22px] font-semibold text-accent">{fmtDur(stats.today_s)}</div>
        </div>
        <div className="panel pl-stat-card p-3 text-center">
          <div className="text-[11px] text-text-faint">累计阅读</div>
          <div className="pl-num mt-1 font-serif text-[22px] font-semibold">{fmtDur(stats.total_s)}</div>
        </div>
      </div>

      <div className="panel pl-stat-card flex items-center justify-between px-3 py-2.5">
        <span className="text-xs text-text-soft">连续阅读天数</span>
        <span className="font-medium">
          <b className="pl-num text-accent">{stats.streak}</b> 天 {stats.streak >= 3 && '🔥'}
        </span>
      </div>

      {/* 30 天热力图 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-text-soft">最近 30 天</span>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-faint">少</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <span key={l} className={`heat-cell h-2.5 w-2.5 ${l > 0 ? `heat-l${l}` : ''}`} />
            ))}
            <span className="text-[10px] text-text-faint">多</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {weeks.map((week, i) => (
            <div key={i} className="grid grid-cols-7 gap-1">
              {week.map((cell, j) =>
                cell ? (
                  <div
                    key={j}
                    className={`heat-cell ${heatLevel(cell.seconds) > 0 ? `heat-l${heatLevel(cell.seconds)}` : ''}`}
                    title={`${fmtDateCN(cell.date)} · ${fmtDur(cell.seconds)}`}
                  />
                ) : (
                  <div key={j} />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-text-faint">
          <span>一</span>
          <span>三</span>
          <span>五</span>
          <span>日</span>
        </div>
      </div>

      {/* 7 天新增生词 */}
      <div>
        <div className="mb-2 text-xs font-medium text-text-soft">近 7 天新增生词</div>
        <div className="flex h-16 items-end gap-1.5">
          {stats.words_new_7d.map((d) => (
            <div key={d.date} className="group flex flex-1 flex-col items-center gap-1" title={`${fmtDateCN(d.date)} · ${d.count} 词`}>
              <span className={`pl-num text-[9.5px] ${d.count > 0 ? 'text-accent' : 'text-text-faint'}`}>{d.count > 0 ? d.count : ''}</span>
              <div
                className="pl-bar-col w-full"
                style={{
                  height: d.count > 0 ? `${Math.max(12, (d.count / maxNew) * 100)}%` : 3,
                  background: d.count > 0 ? 'var(--accent)' : 'var(--border)',
                  opacity: d.count > 0 ? 0.55 + 0.45 * (d.count / maxNew) : 1,
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1.5">
          {stats.words_new_7d.map((d) => (
            <span key={d.date} className="flex-1 text-center text-[9.5px] text-text-faint">
              {Number(d.date.slice(8, 10))}
            </span>
          ))}
        </div>
      </div>

      {/* 复习完成率 */}
      <div className="panel pl-stat-card p-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-text-soft">今日复习完成率</span>
          <span className="pl-num font-medium">
            {reviewRate == null ? '今日暂无到期' : `${reviewRate}%（${stats.review_done_today}/${stats.review_done_today + stats.review_due_today}）`}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-bg-soft">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${reviewRate ?? 0}%`, background: 'var(--accent)' }}
          />
        </div>
      </div>
    </div>
  )
}
