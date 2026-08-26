// 右面板·生词复习（SM-2 间隔重复）
// 注：后端 GET /api/words?due=1 暂不返回 occurrence（原句语境），
//     背面展示词典释义 + 词库存译法；掌握建议基于 interval_days≥21 且 stage=1。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { DictionaryEntry, Word } from '../../api/types'
import { useUi } from '../../stores/ui'
import { useWords } from '../../stores/words'
import { toast } from '../shared/Toast'

const STAGES = [
  { v: 0, label: '陌生', cls: 'hl-stage-0' },
  { v: 1, label: '学习中', cls: 'hl-stage-1' },
  { v: 2, label: '已掌握', cls: 'hl-stage-2' },
] as const

export function ReviewPanel() {
  const openPanel = useUi((s) => s.openPanel)
  const bumpWord = useWords((s) => s.bump)
  const [queue, setQueue] = useState<Word[]>([])
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [dict, setDict] = useState<DictionaryEntry | null>(null)
  const [stats, setStats] = useState<{ done: number; due: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [words, s, g] = await Promise.all([
        api.words({ due: 1, group: groupFilter || undefined }),
        api.stats(),
        api.wordGroups(),
      ])
      setQueue(words)
      setStats({ done: s.review_done_today, due: s.review_due_today })
      setGroups(g)
    } catch (e) {
      toast(e instanceof Error ? e.message : '复习队列加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [groupFilter])

  useEffect(() => {
    load()
  }, [load])

  const current = queue[idx] as Word | undefined

  // 查词典取音标/释义
  useEffect(() => {
    setDict(null)
    setRevealed(false)
    if (!current) return
    let cancelled = false
    api
      .dictionary(current.lemma)
      .then((d) => {
        if (!cancelled) setDict(d)
      })
      .catch(() => {
        /* 无词条 */
      })
    return () => {
      cancelled = true
    }
  }, [current])

  const answer = async (q: 2 | 3 | 5) => {
    if (!current || reviewing) return
    setReviewing(true)
    try {
      const r = await api.reviewWord(current.id, q)
      // 复习结果回写词库 stageMap：正文高亮立即反映新掌握状态（B1 联动）
      if (r.word) bumpWord(r.word)
      setStats((s) => (s ? { ...s, done: s.done + 1 } : s))
      setIdx((i) => i + 1)
    } catch (e) {
      toast(e instanceof Error ? e.message : '复习结果保存失败', 'error')
    } finally {
      setReviewing(false)
    }
  }

  const setStage = async (stage: 0 | 1 | 2) => {
    if (!current) return
    try {
      const w = await api.updateWord(current.id, { stage })
      bumpWord(w)
      setQueue((list) => list.map((x) => (x.id === current.id ? w : x)))
      if (stage === 2) setIdx((i) => i + 1) // 已掌握移出队列
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新失败', 'error')
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center p-8">
        <div className="spinner spinner-lg" />
      </div>
    )
  }

  const finished = idx >= queue.length
  const suggestMaster =
    current != null && current.stage === 1 && current.interval_days >= 21 && current.review_count >= 2

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* 头部统计 */}
      <div className="flex items-center justify-between text-xs text-text-soft">
        <span>
          今日到期 <b className="pl-num text-accent">{stats?.due ?? 0}</b> 个 · 已复习 <b className="pl-num text-accent">{stats?.done ?? 0}</b> 个
          {groupFilter && <span className="text-text-faint">（按组「{groupFilter}」出题 {queue.length} 个）</span>}
        </span>
        <span className="flex items-center gap-1">
          <select
            className="input w-auto! py-0.5 text-[11px]"
            value={groupFilter}
            title="按分组复习"
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="">全部分组</option>
            {groups.map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
          <button className="btn btn-ghost px-1.5 py-0.5 text-xs" title="管理生词库" onClick={() => openPanel('words')}>
            词库
          </button>
          <button className="btn btn-ghost px-1.5 py-0.5 text-xs" onClick={load} title="刷新队列">
            ↻
          </button>
        </span>
      </div>

      {finished ? (
        <div className="fade-in flex flex-col items-center gap-3 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--ok)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium">今日复习完成 🎉</p>
            <p className="mt-1 text-xs text-text-faint">
              {stats && stats.due > 0
                ? `完成率 ${Math.round((stats.done / Math.max(stats.done + stats.due, 1)) * 100)}%（今日已复习 ${stats.done} 词）`
                : '当前没有到期的生词，去读一篇论文吧'}
            </p>
          </div>
          <button className="btn" onClick={load}>
            再刷一遍队列
          </button>
        </div>
      ) : (
        current && (
          <div className="panel pl-review-inner p-4" key={current.id}>
            {/* 正面：大词 + 音标 */}
            <div className="text-center">
              <div className="font-serif text-3xl font-semibold tracking-wide">{current.lemma}</div>
              {dict?.phonetic && <div className="mt-1 text-xs text-text-faint">/{dict.phonetic}/</div>}
              <div className="mt-2 flex items-center justify-center gap-1.5">
                {STAGES.map((s) => (
                  <button
                    key={s.v}
                    className={`badge cursor-pointer ${current.stage === s.v ? 'badge-accent' : ''}`}
                    onClick={() => setStage(s.v)}
                    title="手动调整阶段"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 背面：释义 + 译法 */}
            {revealed ? (
              <div className="pl-reveal mt-4 border-t border-border pt-3">
                {dict?.translation ? (
                  <div className="text-[13px] leading-6">
                    {dict.translation.split('\n').slice(0, 4).map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                ) : current.translation ? (
                  <div className="text-[13px] leading-6">{current.translation}</div>
                ) : (
                  <div className="text-xs text-text-faint">词典暂无该词释义</div>
                )}
                {dict?.pos && <div className="mt-1.5 text-[11px] text-text-faint">{dict.pos}</div>}
                <div className="mt-2 flex gap-3 text-[11px] text-text-faint">
                  <span>复习 {current.review_count} 次</span>
                  <span>间隔 {Math.round(current.interval_days)} 天</span>
                  <span>难度 EF {current.ease.toFixed(2)}</span>
                </div>
                {/* 掌握建议：interval≥21 且 stage=1（后端无复习历史明细，据此近似判定） */}
                {suggestMaster && (
                  <div className="mt-3 flex items-center justify-between rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">
                    <span>连续答「记得」且间隔已达 21 天，建议标记已掌握</span>
                    <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => setStage(2)}>
                      标记
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button className="btn mt-4 w-full justify-center" onClick={() => setRevealed(true)}>
                显示答案
              </button>
            )}

            {/* 三按钮 SM-2 q */}
            {revealed && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button className="btn pl-rev-btn pl-rev-forgot" onClick={() => answer(2)} disabled={reviewing}>
                  忘了
                </button>
                <button className="btn pl-rev-btn pl-rev-fuzzy" onClick={() => answer(3)} disabled={reviewing}>
                  模糊
                </button>
                <button className="btn pl-rev-btn pl-rev-remember" onClick={() => answer(5)} disabled={reviewing}>
                  记得
                </button>
              </div>
            )}

            <div className="mt-2 text-center text-[11px] text-text-faint">
              {idx + 1} / {queue.length}
            </div>
          </div>
        )
      )}
    </div>
  )
}
