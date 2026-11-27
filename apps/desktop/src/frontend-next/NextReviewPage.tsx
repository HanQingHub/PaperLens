import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../api/client'
import type { DictionaryEntry, Word } from '../api/types'
import { IconBook, IconCheck, IconPlus, IconSpeaker, IconSpark, IconTrash, IconX } from '../components/shared/Icon'
import { ConfirmModal } from '../features/shared/Modal'
import { toast } from '../features/shared/Toast'
import { STAGE_LABELS } from '../features/words/stageLabels'
import { speak } from '../features/words/speech'
import { useUi, type ReviewTab } from '../stores/ui'
import { useWords } from '../stores/words'
import NextWordLibrary from './NextWordLibrary'
import './NextReviewPage.css'

const STAGES: (0 | 1 | 2)[] = [0, 1, 2]

function isTextInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(element && (
    element.tagName === 'INPUT'
    || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT'
    || element.isContentEditable
  ))
}

export default function NextReviewPage() {
  const reviewTab = useUi((state) => state.reviewTab)
  const openReview = useUi((state) => state.openReview)
  const bumpWord = useWords((state) => state.bump)
  const removeWord = useWords((state) => state.remove)
  const tabsId = useId()
  const queueRequest = useRef(0)
  const groupsRequest = useRef(0)
  const answerLock = useRef(false)
  const stageLock = useRef(false)
  const createLock = useRef(false)

  const [queue, setQueue] = useState<Word[]>([])
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [dict, setDict] = useState<DictionaryEntry | null>(null)
  const [stats, setStats] = useState<{ done: number; due: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [stageBusy, setStageBusy] = useState(false)
  const [groupFilter, setGroupFilter] = useState('')
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<Word | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  const [deleteGroupBusy, setDeleteGroupBusy] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)

  const loadGroups = useCallback(async () => {
    const request = ++groupsRequest.current
    try {
      const result = await api.wordGroups()
      if (request === groupsRequest.current) setGroups(result)
    } catch (reason) {
      if (request === groupsRequest.current) {
        toast(reason instanceof Error ? reason.message : '分组加载失败', 'error')
      }
    }
  }, [])

  const loadQueue = useCallback(async () => {
    const request = ++queueRequest.current
    setLoading(true)
    try {
      const [words, overview] = await Promise.all([
        api.words({ due: 1, group: groupFilter === '__none' ? '' : groupFilter || undefined }),
        api.stats(),
      ])
      if (request !== queueRequest.current) return
      setQueue(words)
      setStats({ done: overview.review_done_today, due: overview.review_due_today })
      setIndex(0)
      setRevealed(false)
    } catch (reason) {
      if (request === queueRequest.current) {
        toast(reason instanceof Error ? reason.message : '复习队列加载失败', 'error')
      }
    } finally {
      if (request === queueRequest.current) setLoading(false)
    }
  }, [groupFilter])

  useEffect(() => {
    void loadGroups()
    return () => {
      groupsRequest.current += 1
    }
  }, [loadGroups])

  useEffect(() => {
    if (reviewTab !== 'review') return
    void loadQueue()
    return () => {
      queueRequest.current += 1
    }
  }, [loadQueue, reviewTab])

  const current = queue[index] as Word | undefined
  const currentId = current?.id
  const currentLemma = current?.lemma

  useEffect(() => {
    setDict(null)
    setRevealed(false)
    if (!currentLemma) return
    let cancelled = false
    api.dictionary(currentLemma)
      .then((entry) => {
        if (!cancelled) setDict(entry)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentId, currentLemma])

  const answer = useCallback(async (quality: 2 | 3 | 5) => {
    if (!current || reviewing || stageBusy || answerLock.current) return
    answerLock.current = true
    setReviewing(true)
    try {
      const result = await api.reviewWord(current.id, quality)
      if (result.word) bumpWord(result.word)
      setStats((value) => value ? {
        done: value.done + 1,
        due: Math.max(0, value.due - 1),
      } : value)
      if (index + 1 >= queue.length) {
        setQueue([])
        setIndex(0)
        setRevealed(false)
        toast('这组生词已复习完成', 'ok')
        void loadQueue()
      } else {
        setIndex((value) => value + 1)
        setRevealed(false)
      }
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '复习结果提交失败', 'error')
    } finally {
      answerLock.current = false
      setReviewing(false)
    }
  }, [bumpWord, current, index, loadQueue, queue.length, reviewing, stageBusy])

  const setStage = async (stage: 0 | 1 | 2) => {
    if (!current || stageBusy || reviewing || stageLock.current || current.stage === stage) return
    stageLock.current = true
    setStageBusy(true)
    try {
      const updated = await api.updateWord(current.id, { stage })
      bumpWord(updated)
      if (stage === 2) {
        const nextQueue = queue.filter((word) => word.id !== current.id)
        if (index >= nextQueue.length) {
          setQueue([])
          setIndex(0)
        } else {
          setQueue(nextQueue)
          setIndex(index)
        }
        setStats((value) => value ? { ...value, due: Math.max(0, value.due - 1) } : value)
        setRevealed(false)
      } else {
        setQueue((words) => words.map((word) => word.id === current.id ? updated : word))
      }
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '阶段更新失败', 'error')
    } finally {
      stageLock.current = false
      setStageBusy(false)
    }
  }

  const createGroup = async () => {
    if (createLock.current) return
    const name = draft.trim()
    if (!name) {
      toast('请输入分组名', 'error')
      return
    }
    if (name.length > 20) {
      toast('分组名最长 20 字', 'error')
      return
    }
    if (groups.some((group) => group.name === name)) {
      toast('这个分组已经存在', 'error')
      return
    }
    createLock.current = true
    setCreateBusy(true)
    try {
      await api.createWordGroup(name)
      await loadGroups()
      toast(`已创建分组「${name}」`, 'ok')
      setCreating(false)
      setDraft('')
      if (reviewTab === 'review') setGroupFilter(name)
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '分组创建失败', 'error')
    } finally {
      createLock.current = false
      setCreateBusy(false)
    }
  }

  const confirmDeleteGroup = async () => {
    if (!deletingGroup || deleteGroupBusy) return
    setDeleteGroupBusy(true)
    try {
      await api.deleteWordGroup(deletingGroup)
      toast(`已删除分组「${deletingGroup}」`, 'ok')
      if (groupFilter === deletingGroup) setGroupFilter('')
      else if (reviewTab === 'review') void loadQueue()
      setDeletingGroup(null)
      setDataVersion((value) => value + 1)
      await loadGroups()
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '分组删除失败', 'error')
    } finally {
      setDeleteGroupBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.deleteWord(deleting.id)
      removeWord(deleting.id)
      toast(`已删除「${deleting.lemma}」`, 'ok')
      setDeleting(null)
      await Promise.all([loadQueue(), loadGroups()])
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '生词删除失败', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (reviewTab !== 'review' || deleting || deletingGroup || isTextInput(event.target)) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      if (event.key === 'Escape') {
        if (revealed) setRevealed(false)
        return
      }
      if (event.key === ' ') {
        const element = event.target as HTMLElement | null
        if (element?.closest('button, a, [role="button"]')) return
        if (current && !revealed) {
          event.preventDefault()
          setRevealed(true)
        }
        return
      }
      if (!revealed || reviewing || !current) return
      if (event.key === '1') void answer(2)
      else if (event.key === '2') void answer(3)
      else if (event.key === '3') void answer(5)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [answer, current, deleting, deletingGroup, revealed, reviewTab, reviewing])

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next: ReviewTab = event.key === 'Home'
      ? 'review'
      : event.key === 'End'
        ? 'library'
        : reviewTab === 'review' ? 'library' : 'review'
    openReview(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-review-tab="${next}"]`)?.focus()
  }

  const suggestMaster = current?.stage === 1 && current.interval_days >= 21 && current.review_count >= 2

  return (
    <div className="pnx-root pnx-review-page">
      <aside className="pnx-review-sidebar" aria-label="复习与分组导航">
        <div className="pnx-review-brand">
          <span className="pnx-review-brand-mark" aria-hidden><IconBook size={19} /></span>
          <div><strong>生词复习</strong><small>把生词读成熟悉</small></div>
        </div>

        <div className="pnx-review-tabs" role="tablist" aria-label="生词功能" onKeyDown={onTabKeyDown}>
          {(['review', 'library'] as const).map((tab) => (
            <button
              key={tab}
              id={`${tabsId}-${tab}-tab`}
              type="button"
              role="tab"
              data-review-tab={tab}
              aria-selected={reviewTab === tab}
              aria-controls={`${tabsId}-${tab}-panel`}
              tabIndex={reviewTab === tab ? 0 : -1}
              className={reviewTab === tab ? 'pnx-is-active' : ''}
              onClick={() => openReview(tab)}
            >
              {tab === 'review' ? '复习' : '词库'}
            </button>
          ))}
        </div>

        <div className="pnx-group-heading">
          <span>{reviewTab === 'review' ? '复习范围' : '分组筛选'}</span>
          <span>{groups.length} 组</span>
        </div>
        <nav className="pnx-group-list" aria-label="生词分组">
          <button type="button" className={groupFilter === '' ? 'pnx-is-active' : ''} aria-pressed={groupFilter === ''} onClick={() => setGroupFilter('')}>
            <span>全部分组</span><IconBook size={13} />
          </button>
          <button type="button" className={groupFilter === '__none' ? 'pnx-is-active' : ''} aria-pressed={groupFilter === '__none'} onClick={() => setGroupFilter('__none')}>
            <span>未分组</span><span aria-hidden>—</span>
          </button>
          {groups.map((group) => (
            <div className="pnx-group-item" key={group.name}>
              <button type="button" className={groupFilter === group.name ? 'pnx-is-active' : ''} aria-pressed={groupFilter === group.name} onClick={() => setGroupFilter(group.name)}>
                <span title={group.name}>{group.name}</span><small>{group.count}</small>
              </button>
              <button
                type="button"
                className="pnx-group-delete"
                aria-label={`删除分组「${group.name}」`}
                title={`删除分组「${group.name}」，组内生词将变为未分组`}
                onClick={() => setDeletingGroup(group.name)}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </nav>

        {creating ? (
          <form className="pnx-group-create" onSubmit={(event) => { event.preventDefault(); void createGroup() }}>
            <label htmlFor={`${tabsId}-group-name`}>新分组名称</label>
            <input
              id={`${tabsId}-group-name`}
              value={draft}
              maxLength={20}
              autoFocus
              placeholder="最多 20 字"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setCreating(false)
                  setDraft('')
                }
              }}
            />
            <div>
              <button type="submit" className="pnx-rv-button pnx-rv-button-primary" disabled={createBusy}>{createBusy ? '创建中…' : '创建'}</button>
              <button type="button" className="pnx-rv-button" disabled={createBusy} onClick={() => { setCreating(false); setDraft('') }}>取消</button>
            </div>
          </form>
        ) : (
          <button type="button" className="pnx-new-group" onClick={() => setCreating(true)}><IconPlus size={14} />新建分组</button>
        )}

        <div className="pnx-sidebar-foot">
          {reviewTab === 'review' ? (
            <>
              <div><span>今日到期</span><strong>{stats?.due ?? 0}</strong></div>
              <div><span>今日完成</span><strong>{stats?.done ?? 0}</strong></div>
              {groupFilter && <small>当前范围有 {queue.length} 个待复习</small>}
            </>
          ) : (
            <small>分组筛选会同步到复习队列</small>
          )}
        </div>
      </aside>

      {reviewTab === 'review' ? (
        <main
          id={`${tabsId}-review-panel`}
          className="pnx-review-workspace"
          role="tabpanel"
          aria-labelledby={`${tabsId}-review-tab`}
        >
          <header className="pnx-review-heading">
            <div><span className="pnx-rv-eyebrow">每日复习</span><h1>今天，再记住一点。</h1></div>
            <p>先回想，再看答案<br />让记忆多停留一会儿</p>
          </header>

          <div className="pnx-review-stage">
            {loading ? (
              <div className="pnx-review-loading" role="status"><span aria-hidden /><p>正在整理今日生词…</p></div>
            ) : !current ? (
              <section className="pnx-review-empty">
                <span className="pnx-empty-mark" aria-hidden><IconCheck size={26} /></span>
                <span className="pnx-rv-eyebrow">稍事休息</span>
                <h2>{queue.length === 0 ? '当前范围没有到期生词' : '本轮复习完成'}</h2>
                <p>今日已完成 <strong>{stats?.done ?? 0}</strong> 词，仍有 <strong>{stats?.due ?? 0}</strong> 词到期。</p>
                <div>
                  <button type="button" className="pnx-rv-button pnx-rv-button-primary" onClick={() => void loadQueue()}>刷新队列</button>
                  <button type="button" className="pnx-rv-button" onClick={() => openReview('library')}>整理词库</button>
                </div>
              </section>
            ) : (
              <article className={`pnx-review-card${revealed ? ' pnx-is-revealed' : ''}`} aria-live="polite">
                <div className="pnx-card-topline">
                  <span>今日词卡 · {index + 1} / {queue.length}</span>
                  <span>{current.group_name || '未分组'}</span>
                </div>
                <div className="pnx-word-heading">
                  <div>
                    <h2 title={current.lemma}>{current.lemma}</h2>
                    <p>{dict?.phonetic ? `/${dict.phonetic}/` : '先试着回想它的意思'}</p>
                  </div>
                  <button type="button" className="pnx-pronounce" aria-label={`朗读${current.lemma}`} title="发音" onClick={() => speak(current.lemma)}><IconSpeaker size={20} /></button>
                </div>

                <div className="pnx-stage-picker" role="group" aria-label="手动调整掌握阶段">
                  {STAGES.map((stage) => (
                    <button
                      key={stage}
                      type="button"
                      disabled={stageBusy || reviewing}
                      aria-pressed={current.stage === stage}
                      className={current.stage === stage ? 'pnx-is-active' : ''}
                      onClick={() => void setStage(stage)}
                    >
                      {STAGE_LABELS[stage]}
                    </button>
                  ))}
                </div>

                {!revealed ? (
                  <div className="pnx-concealed">
                    <p>答案先藏在纸背，给自己一点时间。</p>
                    <button type="button" className="pnx-rv-button pnx-rv-button-primary pnx-reveal-button" onClick={() => setRevealed(true)}>显示释义 <kbd>空格</kbd></button>
                  </div>
                ) : (
                  <div className="pnx-answer">
                    <section className="pnx-translation" aria-label="单词释义">
                      <span>释义</span>
                      <p>{current.translation || dict?.translation || '暂无释义，可在词库中补充'}</p>
                      {current.translation && dict?.translation && current.translation !== dict.translation && (
                        <small>词典参考：{dict.translation}</small>
                      )}
                      {dict?.pos && <small>词性：{dict.pos}</small>}
                    </section>
                    <div className="pnx-memory-meta">
                      <span>复习 {current.review_count} 次</span>
                      <span>间隔 {Math.round(current.interval_days)} 天</span>
                      <span>难度 {current.ease.toFixed(2)}</span>
                    </div>
                    {suggestMaster && (
                      <div className="pnx-master-hint">
                        <IconSpark size={15} /><span>间隔已达 21 天，可以试着标记为已掌握。</span>
                        <button type="button" disabled={stageBusy || reviewing} onClick={() => void setStage(2)}>标记掌握</button>
                      </div>
                    )}
                    <div className="pnx-answer-actions" role="group" aria-label="这次记得怎么样">
                      <button type="button" className="pnx-answer-forgot" disabled={reviewing || stageBusy} onClick={(event) => { event.currentTarget.blur(); void answer(2) }}><span>忘了</span><kbd>1</kbd></button>
                      <button type="button" className="pnx-answer-vague" disabled={reviewing || stageBusy} onClick={(event) => { event.currentTarget.blur(); void answer(3) }}><span>模糊</span><kbd>2</kbd></button>
                      <button type="button" className="pnx-answer-known" disabled={reviewing || stageBusy} onClick={(event) => { event.currentTarget.blur(); void answer(5) }}><span>记得</span><kbd>3</kbd></button>
                    </div>
                    <footer className="pnx-card-footer">
                      <button type="button" onClick={() => setRevealed(false)}>隐藏释义 <kbd>Esc</kbd></button>
                      <button type="button" onClick={() => openReview('library')}>在词库中管理</button>
                      <button type="button" className="pnx-rv-danger" disabled={reviewing || stageBusy} onClick={() => setDeleting(current)}><IconTrash size={12} />删除</button>
                    </footer>
                  </div>
                )}
              </article>
            )}
          </div>
          <footer className="pnx-review-shortcuts"><span><kbd>空格</kbd> 显示释义</span><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 评价记忆</span><span><kbd>Esc</kbd> 隐藏</span></footer>
        </main>
      ) : (
        <main
          id={`${tabsId}-library-panel`}
          className="pnx-library-workspace"
          role="tabpanel"
          aria-labelledby={`${tabsId}-library-tab`}
        >
          <NextWordLibrary
            groupFilter={groupFilter}
            groups={groups}
            onGroupsChanged={loadGroups}
            dataVersion={dataVersion}
          />
        </main>
      )}

      <ConfirmModal
        open={deleting !== null}
        title="删除生词"
        confirmText="删除"
        danger
        busy={deleteBusy}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p className="pnx-modal-copy">删除「{deleting?.lemma}」？复习记录与例句将一并清除，正文高亮也会消失。</p>
      </ConfirmModal>
      <ConfirmModal
        open={deletingGroup !== null}
        title="删除分组"
        confirmText="删除分组"
        danger
        busy={deleteGroupBusy}
        onClose={() => setDeletingGroup(null)}
        onConfirm={() => void confirmDeleteGroup()}
      >
        <p className="pnx-modal-copy">删除「{deletingGroup}」？组内生词会变为未分组，生词本身不会被删除。</p>
      </ConfirmModal>
    </div>
  )
}
