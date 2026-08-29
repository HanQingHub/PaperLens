// 生词复习大界面：左栏标签切换（复习 / 词库）+ 分组侧栏，主区为复习卡片或词库视图
// 复习快捷键：空格 显示释义 · 1/2/3 忘了/模糊/记得 · Esc 隐藏
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Word, DictionaryEntry } from '../../api/types'
import { useUi } from '../../stores/ui'
import { useWords } from '../../stores/words'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import { STAGE_LABELS } from '../words/stageLabels'
import WordLibrary from '../words/WordLibrary'
import { speak } from '../words/speech'

const STAGES: (0 | 1 | 2)[] = [0, 1, 2]

export default function ReviewPage() {
  const reviewTab = useUi((s) => s.reviewTab)
  const openReview = useUi((s) => s.openReview)
  const bumpWord = useWords((s) => s.bump)
  const removeWord = useWords((s) => s.remove)
  const [queue, setQueue] = useState<Word[]>([])
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [dict, setDict] = useState<DictionaryEntry | null>(null)
  const [stats, setStats] = useState<{ done: number; due: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<Word | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  const [deleteGroupBusy, setDeleteGroupBusy] = useState(false)
  const [libStats, setLibStats] = useState<{ total: number; learning: number; mastered: number } | null>(null)
  /** 复习页删组后 +1：服务端把组内词置为未分组，词库视图据此重拉词表 */
  const [dataVersion, setDataVersion] = useState(0)

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

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.wordGroups())
    } catch {
      /* 静默 */
    }
  }, [])

  // 队列加载：挂载 / 复习标签下分组筛选变化 / 词库切回复习（词库内改阶段、删除后队列不陈旧）；词库标签不拉队列
  useEffect(() => {
    if (reviewTab !== 'review') return
    load()
  }, [load, reviewTab])

  // 词库全量分桶统计（完成态/空态展示用；队列空了才拉，避免每次复习多一个请求）
  useEffect(() => {
    if (queue.length > 0) return
    let cancelled = false
    api
      .words()
      .then((all) => {
        if (cancelled) return
        setLibStats({
          total: all.length,
          learning: all.filter((w) => w.stage === 1).length,
          mastered: all.filter((w) => w.stage === 2).length,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [queue.length])

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
      const r = await api.reviewWord(current.id, q)
      // 复习结果回写词库 stageMap：正文高亮立即反映新掌握状态（B1 联动）
      if (r.word) bumpWord(r.word)
      setStats((s) => (s ? { ...s, done: s.done + 1 } : s))
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

  const createGroup = async () => {
    const n = draft.trim()
    if (!n) return toast('请输入分组名', 'error')
    if (n.length > 20) return toast('名称最长20字', 'error')
    if (groups.some((g) => g.name === n)) return toast('已存在', 'error')
    try {
      await api.createWordGroup(n)
      toast(`分组「${n}」已创建`, 'ok')
      setCreating(false)
      setDraft('')
      loadGroups()
      if (reviewTab === 'review') setGroupFilter(n) // 词库标签下不切筛选，避免列表被过滤到空新组
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建失败', 'error')
    }
  }

  const confirmDeleteGroup = async () => {
    if (!deletingGroup) return
    setDeleteGroupBusy(true)
    try {
      await api.deleteWordGroup(deletingGroup)
      toast(`分组「${deletingGroup}」已删除`, 'ok')
      if (groupFilter === deletingGroup) setGroupFilter('')
      loadGroups()
      setDataVersion((v) => v + 1) // 组内词已被置为未分组，词库视图重拉
      setDeletingGroup(null)
    } catch {
      toast('分组删除失败', 'error')
    } finally {
      setDeleteGroupBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.deleteWord(deleting.id)
      removeWord(deleting.id)
      toast(`已删除「${deleting.lemma}」`, 'ok')
      setDeleting(null)
      load()
    } catch {
      toast('删除失败', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  // 键盘快捷键：空格翻面 / 1·2·3 评分 / Esc 隐藏（确认弹窗打开或词库标签时全部失效，
  // 词库标签下队列表仍驻内存，避免对不可见卡片产生真实复习记录）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (reviewTab !== 'review') return
      if (deleting != null || deletingGroup != null) return // 确认弹窗打开时快捷键全部失效（含 Esc，避免双动作）
      if (e.key === ' ') {
        if (current && !revealed) {
          e.preventDefault()
          setRevealed(true)
        }
        return
      }
      if (e.key === 'Escape') {
        if (revealed) setRevealed(false)
        return
      }
      if (!revealed || reviewing || !current) return
      if (e.key === '1') answer(2)
      else if (e.key === '2') answer(3)
      else if (e.key === '3') answer(5)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, revealed, reviewing, deleting, deletingGroup, reviewTab])

  if (loading && reviewTab === 'review') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="spinner spinner-lg" />
      </div>
    )
  }

  // 掌握建议：interval≥21 且 stage=1（后端无复习历史明细，据此近似判定）
  const suggestMaster =
    current != null && current.stage === 1 && current.interval_days >= 21 && current.review_count >= 2

  return (
    <div className="flex h-full">
      {/* 左侧栏：标签切换 + 分组（复习队列与词库筛选共用） */}
      <div className="w-48 shrink-0 border-r border-border bg-panel p-4">
        <div className="mb-4 flex rounded-lg bg-bg-soft p-0.5 text-xs">
          <button
            className={`flex-1 rounded-md py-1 transition-all ${
              reviewTab === 'review' ? 'bg-accent text-white' : 'text-text-faint hover:text-text-soft'
            }`}
            onClick={() => openReview('review')}
          >
            复习
          </button>
          <button
            className={`flex-1 rounded-md py-1 transition-all ${
              reviewTab === 'library' ? 'bg-accent text-white' : 'text-text-faint hover:text-text-soft'
            }`}
            onClick={() => openReview('library')}
          >
            词库
          </button>
        </div>
        <h3 className="mb-3 text-xs font-medium text-text-soft">
          {reviewTab === 'review' ? '按分组复习' : '按分组筛选'}
        </h3>
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
            <div key={g.name} className="group/grp relative">
              <button
                className={`flex w-full justify-between rounded-md px-3 py-1.5 text-left text-sm ${groupFilter === g.name ? 'bg-accent text-white' : 'hover:bg-bg-soft'}`}
                onClick={() => setGroupFilter(g.name)}
              >
                <span className="truncate">{g.name}</span>
                <span className={`ml-1 shrink-0 text-xs ${groupFilter === g.name ? 'opacity-70' : 'text-text-faint'}`}>{g.count}</span>
              </button>
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] text-text-faint opacity-0 transition-all hover:text-danger focus-visible:opacity-100 group-hover/grp:opacity-100"
                title={`删除分组「${g.name}」（组内 ${g.count} 个生词将变为未分组）`}
                onClick={() => setDeletingGroup(g.name)}
              >
                ✕
              </button>
            </div>
          ))}
          {creating ? (
            <div className="mt-1 flex flex-col gap-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="分组名（≤20字）"
                maxLength={20}
                className="input h-7 px-2 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setCreating(false)
                  if (e.key === 'Enter') createGroup()
                }}
              />
              <div className="flex gap-1">
                <button className="btn btn-primary h-7 flex-1 px-2 text-[11px]" onClick={createGroup}>
                  创建
                </button>
                <button className="btn btn-ghost h-7 px-2 text-[11px]" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              className="mt-1 rounded-md border border-dashed border-border px-3 py-1.5 text-left text-[11px] text-accent transition-colors hover:border-accent"
              onClick={() => setCreating(true)}
            >
              ＋ 新建分组
            </button>
          )}
        </div>
        {reviewTab === 'review' && (
          <div className="mt-6 border-t border-border pt-4">
            <div className="text-xs text-text-faint">
              <div>今日到期 <b className="text-accent">{stats?.due ?? 0}</b> 个</div>
              <div>已复习 <b className="text-accent">{stats?.done ?? 0}</b> 个</div>
              {groupFilter && <div className="mt-1 text-[11px]">当前组 {queue.length} 个待复习</div>}
            </div>
          </div>
        )}
      </div>

      {/* 主区：复习卡片（背景透明，透出 AppShell 层 Waves 波纹）或词库视图 */}
      {reviewTab === 'review' ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8">
          {!current ? (
            <div className="w-full max-w-[420px] rounded-xl border border-border bg-panel p-8 text-center shadow-lg">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--ok)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <p className="text-lg font-medium">{queue.length === 0 ? '当前分组没有到期生词' : '今日复习完成 🎉'}</p>
              <p className="mt-2 text-sm text-text-faint">
                今日已复习 <b className="text-accent">{stats?.done ?? 0}</b> 词 · 剩余到期 <b className="text-accent">{stats?.due ?? 0}</b> 词
              </p>
              {libStats && (
                <p className="mt-1 text-xs text-text-faint">
                  词库共 {libStats.total} 词 · 学习中 {libStats.learning} · 已掌握 {libStats.mastered}
                </p>
              )}
              <div className="mt-5 flex items-center justify-center gap-2">
                <button className="btn btn-primary px-4" onClick={load}>
                  刷新队列
                </button>
                <button className="btn px-4" onClick={() => openReview('library')}>
                  打开词库
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-[640px] rounded-xl border border-border bg-panel p-8 shadow-lg">
              <div className="mb-6 text-center">
                <div className="flex items-center justify-center gap-2">
                  <h2 className="font-serif text-3xl font-bold">{current.lemma}</h2>
                  <button
                    className="text-base text-text-faint transition-all hover:text-accent"
                    title="发音"
                    onClick={(e) => {
                      speak(current.lemma)
                      e.currentTarget.blur()
                    }}
                  >
                    🔊
                  </button>
                </div>
                {dict?.phonetic && <p className="mt-1 text-sm text-text-faint">/{dict.phonetic}/</p>}
                <div className="mt-3 flex items-center justify-center gap-1.5">
                  {STAGES.map((s) => (
                    <button
                      key={s}
                      className={`badge cursor-pointer ${current.stage === s ? 'badge-accent' : ''}`}
                      onClick={() => setStage(s)}
                      title="手动调整阶段"
                    >
                      {STAGE_LABELS[s]}
                    </button>
                  ))}
                  <span className="ml-2 rounded-full bg-bg-soft px-2 py-0.5 text-xs text-text-faint">
                    {current.group_name ?? '未分组'}
                  </span>
                </div>
              </div>

              {!revealed ? (
                <div className="text-center">
                  <button className="btn btn-primary px-6 py-2" onClick={() => setRevealed(true)} title="空格">
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
                  <div className="mb-4 flex justify-center gap-3 text-xs text-text-faint">
                    <span>复习 {current.review_count} 次</span>
                    <span>间隔 {Math.round(current.interval_days)} 天</span>
                    <span>难度 EF {current.ease.toFixed(2)}</span>
                  </div>
                  {suggestMaster && (
                    <div className="mb-4 flex items-center justify-between rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">
                      <span>连续答「记得」且间隔已达 21 天，建议标记已掌握</span>
                      <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => setStage(2)}>
                        标记
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2 justify-center">
                    <button className="btn flex-1 bg-red-50 text-red-600 hover:bg-red-100" onClick={() => answer(2)} disabled={reviewing} title="快捷键 1">
                      忘了
                    </button>
                    <button className="btn flex-1 bg-yellow-50 text-yellow-700 hover:bg-yellow-100" onClick={() => answer(3)} disabled={reviewing} title="快捷键 2">
                      模糊
                    </button>
                    <button className="btn flex-1 bg-green-50 text-green-700 hover:bg-green-100" onClick={() => answer(5)} disabled={reviewing} title="快捷键 3">
                      记得
                    </button>
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-3 text-xs text-text-faint">
                    <span>{idx + 1} / {queue.length}</span>
                    <span>·</span>
                    <button className="hover:text-accent" onClick={() => setRevealed(false)}>隐藏</button>
                    <span>·</span>
                    <button className="hover:text-accent" onClick={() => openReview('library')}>在词库中管理</button>
                    <span>·</span>
                    <button
                      className="hover:text-danger"
                      title="从词库删除该生词"
                      onClick={() => setDeleting(current)}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <WordLibrary
          groupFilter={groupFilter}
          groups={groups}
          onGroupsChanged={loadGroups}
          dataVersion={dataVersion}
        />
      )}

      <ConfirmModal
        open={deleting != null}
        title="删除生词"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      >
        <p className="text-xs text-text-soft">
          删除「{deleting?.lemma}」？复习记录与例句将一并清除，正文高亮同步消失。
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={deletingGroup != null}
        title="删除分组"
        danger
        busy={deleteGroupBusy}
        onClose={() => setDeletingGroup(null)}
        onConfirm={confirmDeleteGroup}
      >
        <p className="text-xs text-text-soft">
          删除分组「{deletingGroup}」？组内生词将全部变为未分组，生词本身不会被删除。
        </p>
      </ConfirmModal>
    </div>
  )
}
