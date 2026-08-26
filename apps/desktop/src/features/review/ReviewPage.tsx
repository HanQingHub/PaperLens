// 全屏生词复习页（替代右侧栏小面板）—— 大卡片 + 分组侧栏 + 统计
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Word, DictionaryEntry } from '../../api/types'
import { useUi } from '../../stores/ui'
import { toast } from '../shared/Toast'
import { STAGE_LABELS } from '../words/stageLabels'

export default function ReviewPage() {
  const [queue, setQueue] = useState<Word[]>([])
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [dict, setDict] = useState<DictionaryEntry | null>(null)
  const [stats, setStats] = useState<{ done: number; due: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const { closePanel } = useUi()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [words, s, g] = await Promise.all([
        api.words({ due: 1, group: groupFilter === '__none' ? '' : groupFilter || undefined }),
        api.stats(),
        api.wordGroups(),
      ])
      setQueue(words)
      setStats({ done: s.review_done_today, due: s.review_due_today })
      setGroups(g)
      setIdx(0)
      setRevealed(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : '复习队列加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [groupFilter])

  useEffect(() => {
    load()
    closePanel()
  }, [load, closePanel])

  const current = queue[idx] as Word | undefined

  useEffect(() => {
    setDict(null)
    setRevealed(false)
    if (!current) return
    let cancelled = false
    api.dictionary(current.lemma).then((d) => {
      if (!cancelled) setDict(d)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [current])

  const answer = async (q: 2 | 3 | 5) => {
    if (!current || reviewing) return
    setReviewing(true)
    try {
      await api.reviewWord(current.id, q)
      if (idx + 1 >= queue.length) {
        toast('今日复习完成 🎉', 'ok')
        load()
      } else {
        setIdx((i) => i + 1)
        setRevealed(false)
        setDict(null)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '提交失败', 'error')
    } finally {
      setReviewing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="spinner spinner-lg" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* 左侧分组侧栏 */}
      <div className="w-48 shrink-0 border-r border-border bg-panel p-4">
        <h3 className="mb-3 text-xs font-medium text-text-soft">按分组复习</h3>
        <div className="flex flex-col gap-1">
          <button
            className={`rounded-md px-3 py-1.5 text-left text-sm ${groupFilter === '' ? 'bg-accent text-white' : 'hover:bg-bg-soft'}`}
            onClick={() => setGroupFilter('')}
          >
            全部分组
          </button>
          <button
            className={`rounded-md px-3 py-1.5 text-left text-sm ${groupFilter === '__none' ? 'bg-accent text-white' : 'hover:bg-bg-soft'}`}
            onClick={() => setGroupFilter('__none')}
          >
            未分组
          </button>
          {groups.map((g) => (
            <button
              key={g.name}
              className={`flex justify-between rounded-md px-3 py-1.5 text-left text-sm ${groupFilter === g.name ? 'bg-accent text-white' : 'hover:bg-bg-soft'}`}
              onClick={() => setGroupFilter(g.name)}
            >
              <span>{g.name}</span>
              <span className="text-xs opacity-70">{g.count}</span>
            </button>
          ))}
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <div className="text-xs text-text-faint">
            <div>今日到期 <b className="text-accent">{stats?.due ?? 0}</b> 个</div>
            <div>已复习 <b className="text-accent">{stats?.done ?? 0}</b> 个</div>
            {groupFilter && <div className="mt-1 text-[11px]">当前组 {queue.length} 个待复习</div>}
          </div>
        </div>
      </div>

      {/* 主卡片区 */}
      <div className="flex flex-1 flex-col items-center justify-center p-8 bg-bg-soft">
        {!current ? (
          <div className="text-center">
            <p className="text-lg font-medium">今日复习完成 🎉</p>
            <p className="mt-2 text-sm text-text-faint">当前分组没有到期的生词，去读一篇论文吧</p>
            <button className="btn btn-primary mt-4" onClick={load}>刷新</button>
          </div>
        ) : (
          <div className="w-full max-w-[640px] rounded-xl border border-border bg-panel p-8 shadow-lg">
            <div className="mb-6 text-center">
              <h2 className="font-serif text-3xl font-bold">{current.lemma}</h2>
              {dict?.phonetic && <p className="mt-1 text-sm text-text-faint">/{dict.phonetic}/</p>}
              <span className="mt-2 inline-block rounded-full bg-bg-soft px-2 py-0.5 text-xs text-text-faint">
                {STAGE_LABELS[current.stage as 0|1|2]} · {current.group_name ?? '未分组'}
              </span>
            </div>

            {!revealed ? (
              <div className="text-center">
                <button className="btn btn-primary px-6 py-2" onClick={() => setRevealed(true)}>
                  显示释义
                </button>
                <p className="mt-3 text-xs text-text-faint">回想一下，然后点击查看</p>
              </div>
            ) : (
              <>
                <div className="rounded-lg bg-accent-soft p-4 mb-4">
                  <p className="font-medium text-accent">{current.translation || dict?.translation || '暂无释义'}</p>
                  {current.translation && dict?.translation && current.translation !== dict.translation && (
                    <p className="mt-1 text-xs text-text-faint">词典: {dict.translation}</p>
                  )}
                </div>
                {dict?.pos && <p className="text-xs text-text-faint mb-2">{dict.pos}</p>}
                <div className="flex gap-2 justify-center">
                  <button className="btn flex-1 bg-red-50 text-red-600 hover:bg-red-100" onClick={() => answer(2)} disabled={reviewing}>
                    忘了
                  </button>
                  <button className="btn flex-1 bg-yellow-50 text-yellow-700 hover:bg-yellow-100" onClick={() => answer(3)} disabled={reviewing}>
                    模糊
                  </button>
                  <button className="btn flex-1 bg-green-50 text-green-700 hover:bg-green-100" onClick={() => answer(5)} disabled={reviewing}>
                    记得
                  </button>
                </div>
                <div className="mt-4 flex justify-center gap-2 text-xs text-text-faint">
                  <span>{idx + 1} / {queue.length}</span>
                  <span>·</span>
                  <button className="hover:text-accent" onClick={() => setRevealed(false)}>隐藏</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
