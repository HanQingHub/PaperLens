import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, saveBlobWithDialog } from '../api/client'
import type { Word } from '../api/types'
import { IconBook, IconCheck, IconPencil, IconSearch, IconSpeaker, IconTrash, IconX } from '../components/shared/Icon'
import { ConfirmModal } from '../features/shared/Modal'
import { toast } from '../features/shared/Toast'
import { filterWords, libraryStats, paginate, sortWords, type WordSortKey } from '../features/words/libraryData'
import { speak } from '../features/words/speech'
import { STAGE_LABELS } from '../features/words/stageLabels'
import { useWords } from '../stores/words'

const STAGES: (0 | 1 | 2)[] = [0, 1, 2]
const PAGE_SIZE = 50
const SORT_OPTIONS: { key: WordSortKey; label: string }[] = [
  { key: 'added', label: '最近添加' },
  { key: 'lemma', label: '字母顺序' },
  { key: 'due', label: '到期时间' },
  { key: 'reviews', label: '复习次数' },
]

type WordPatch = { stage?: 0 | 1 | 2; translation?: string; group_name?: string }

interface Props {
  groupFilter: string
  groups: { name: string; count: number }[]
  onGroupsChanged: () => void | Promise<void>
  dataVersion: number
}

function formatDue(value: string | null): string {
  if (!value) return '尚未安排复习'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '复习时间未知'
  return `复习于 ${date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}`
}

export default function NextWordLibrary({ groupFilter, groups, onGroupsChanged, dataVersion }: Props) {
  const bump = useWords((state) => state.bump)
  const removeWord = useWords((state) => state.remove)
  const loadRequest = useRef(0)
  const pendingRef = useRef<Set<number>>(new Set())
  const [all, setAll] = useState<Word[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [stageFilter, setStageFilter] = useState<0 | 1 | 2 | null>(null)
  const [sortKey, setSortKey] = useState<WordSortKey>('added')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState<Word | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'anki' | null>(null)

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    try {
      const words = await api.words()
      if (request === loadRequest.current) setAll(words)
    } catch (reason) {
      if (request === loadRequest.current) {
        toast(reason instanceof Error ? reason.message : '生词加载失败', 'error')
      }
    } finally {
      if (request === loadRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      loadRequest.current += 1
    }
  }, [dataVersion, load])

  const group = groupFilter === '' ? null : groupFilter === '__none' ? '' : groupFilter
  const filtered = useMemo(() => filterWords(all, { q: query, stage: stageFilter, group }), [all, group, query, stageFilter])
  const sorted = useMemo(() => sortWords(filtered, sortKey), [filtered, sortKey])
  const pagination = useMemo(() => paginate(sorted, page, PAGE_SIZE), [page, sorted])
  const stats = useMemo(() => libraryStats(all, new Date()), [all])
  const currentPage = Math.min(page, pagination.pages)
  const pageIds = useMemo(() => new Set(pagination.rows.map((word) => word.id)), [pagination.rows])
  const allPageSelected = pagination.rows.length > 0 && pagination.rows.every((word) => selected.has(word.id))
  const maxForecast = Math.max(1, ...stats.forecast.map((item) => item.count))

  useEffect(() => {
    setPage(1)
  }, [groupFilter, query, sortKey, stageFilter])

  useEffect(() => {
    if (page > pagination.pages) setPage(pagination.pages)
  }, [page, pagination.pages])

  useEffect(() => {
    const existing = new Set(all.map((word) => word.id))
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => existing.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [all])

  const patchLocal = (updated: Word) => {
    setAll((words) => words.map((word) => word.id === updated.id ? updated : word))
  }

  const saveWord = async (word: Word, patch: WordPatch, errorMessage: string): Promise<Word | null> => {
    if (pendingIds.has(word.id) || pendingRef.current.has(word.id)) return null
    pendingRef.current.add(word.id)
    setPendingIds((ids) => new Set(ids).add(word.id))
    try {
      const updated = await api.updateWord(word.id, patch)
      patchLocal(updated)
      bump(updated)
      if (patch.group_name !== undefined) await onGroupsChanged()
      return updated
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : errorMessage, 'error')
      return null
    } finally {
      pendingRef.current.delete(word.id)
      setPendingIds((ids) => {
        const next = new Set(ids)
        next.delete(word.id)
        return next
      })
    }
  }

  const saveEdit = async (word: Word) => {
    const translation = editText.trim()
    if (translation === (word.translation ?? '')) {
      setEditingId(null)
      return
    }
    const updated = await saveWord(word, { translation }, '释义保存失败')
    if (updated) setEditingId(null)
  }

  const toggleSelect = (id: number) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectPage = () => {
    setSelected((previous) => {
      const next = new Set(previous)
      for (const id of pageIds) {
        if (allPageSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.deleteWord(deleting.id)
      setAll((words) => words.filter((word) => word.id !== deleting.id))
      setSelected((ids) => {
        const next = new Set(ids)
        next.delete(deleting.id)
        return next
      })
      removeWord(deleting.id)
      toast(`已删除「${deleting.lemma}」`, 'ok')
      setDeleting(null)
      await onGroupsChanged()
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '生词删除失败', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const bulkStage = async (stage: 0 | 1 | 2) => {
    if (batchBusy || selected.size === 0) return
    const ids = [...selected]
    let completed = 0
    let failed = false
    setBatchBusy(true)
    try {
      for (const id of ids) {
        try {
          const updated = await api.updateWord(id, { stage })
          patchLocal(updated)
          bump(updated)
          completed += 1
        } catch {
          failed = true
          break
        }
      }
      setSelected(new Set())
      await load()
      if (failed) toast(`已更新 ${completed} 项，其余操作已停止`, 'error')
      else toast(`已将 ${completed} 个生词设为「${STAGE_LABELS[stage]}」`, 'ok')
    } finally {
      setBatchBusy(false)
    }
  }

  const confirmBatchDelete = async () => {
    if (batchBusy || selected.size === 0) return
    const ids = [...selected]
    let completed = 0
    let failed = false
    setBatchBusy(true)
    try {
      for (const id of ids) {
        try {
          await api.deleteWord(id)
          removeWord(id)
          completed += 1
        } catch {
          failed = true
          break
        }
      }
      setBatchDeleting(false)
      setSelected(new Set())
      await Promise.all([load(), onGroupsChanged()])
      if (failed) toast(`已删除 ${completed} 项，其余操作已停止`, 'error')
      else toast(`已删除 ${completed} 个生词`, 'ok')
    } finally {
      setBatchBusy(false)
    }
  }

  const doExport = async (format: 'csv' | 'anki') => {
    if (exporting) return
    setExporting(format)
    try {
      const blob = await api.wordsExportUrl(format)
      const saved = await saveBlobWithDialog(blob, format === 'csv' ? 'words.csv' : 'words_anki.txt')
      if (saved) toast(format === 'csv' ? 'CSV 已导出' : 'Anki 文件已导出', 'ok')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '导出失败', 'error')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="pnx-library">
      <header className="pnx-library-heading">
        <div><span className="pnx-rv-eyebrow">我的词库</span><h1>把生词，收进书房。</h1><p>搜索、整理，也为下一次复习做好准备。</p></div>
        <div className="pnx-export-actions" role="group" aria-label="导出词库">
          <button type="button" className="pnx-rv-button" disabled={exporting !== null} onClick={() => void doExport('csv')}>{exporting === 'csv' ? '导出中…' : '导出 CSV'}</button>
          <button type="button" className="pnx-rv-button" disabled={exporting !== null} onClick={() => void doExport('anki')}>{exporting === 'anki' ? '导出中…' : '导出 Anki'}</button>
        </div>
      </header>

      <section className="pnx-library-overview" aria-label="词库概览">
        <div className="pnx-overview-stages">
          {([null, ...STAGES] as const).map((stage) => {
            const count = stage === null ? stats.total : stage === 0 ? stats.stage0 : stage === 1 ? stats.stage1 : stats.stage2
            return (
              <button
                type="button"
                key={stage ?? 'all'}
                aria-pressed={stageFilter === stage}
                className={stageFilter === stage ? 'pnx-is-active' : ''}
                onClick={() => setStageFilter(stage)}
              >
                <span>{stage === null ? '全部生词' : STAGE_LABELS[stage]}</span>
                <strong>{count}</strong>
                <small>{stage === null ? '完整词库' : stage === 2 ? '已经熟悉' : '继续积累'}</small>
              </button>
            )
          })}
          <div className="pnx-overview-due"><span>今日到期</span><strong>{stats.dueToday}</strong><small>等待复习</small></div>
        </div>
        <div className="pnx-forecast" role="group" aria-label="未来七天到期生词统计">
          <div><span>未来 7 天</span><small>到期预览</small></div>
          <div className="pnx-forecast-bars">
            {stats.forecast.map((item, index) => (
              <div key={item.date} title={`${item.date}，到期 ${item.count} 个`} aria-label={`${item.date}，到期 ${item.count} 个`}>
                <span>{item.count || ''}</span>
                <i style={{ height: item.count ? Math.max(5, Math.round(42 * item.count / maxForecast)) : 3 }} />
                <small>{index === 0 ? '今天' : item.date.slice(5).replace('-', '/')}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pnx-library-tools" aria-label="搜索与排序">
        <div className="pnx-library-search">
          <IconSearch size={16} />
          <input type="search" aria-label="搜索单词或释义" value={query} placeholder="搜索单词或释义…" onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => setQuery('')}><IconX size={13} /></button>}
        </div>
        <label className="pnx-sort-select"><span>排序</span>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as WordSortKey)}>
            {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
        <span className="pnx-result-count" aria-live="polite">筛选出 {sorted.length} 词</span>
      </section>

      <div className="pnx-list-toolbar">
        <label className="pnx-page-check"><input type="checkbox" checked={allPageSelected} disabled={batchBusy || pagination.rows.length === 0} onChange={toggleSelectPage} />全选本页</label>
        <span>每页 {PAGE_SIZE} 条{groupFilter && ` · ${groupFilter === '__none' ? '未分组' : groupFilter}`}</span>
        {(query || stageFilter !== null) && <button type="button" onClick={() => { setQuery(''); setStageFilter(null) }}>清除搜索与阶段筛选</button>}
        {loading && all.length > 0 && <span role="status">正在刷新…</span>}
      </div>

      {selected.size > 0 && (
        <section className="pnx-batch-bar" aria-label="批量操作">
          <strong>已选 {selected.size} 项</strong>
          <span className="pnx-batch-divider" aria-hidden />
          <span>设为</span>
          {STAGES.map((stage) => <button type="button" key={stage} disabled={batchBusy} onClick={() => void bulkStage(stage)}>{STAGE_LABELS[stage]}</button>)}
          <span className="pnx-batch-divider" aria-hidden />
          <button type="button" className="pnx-rv-danger" disabled={batchBusy} onClick={() => setBatchDeleting(true)}><IconTrash size={13} />批量删除</button>
          <button type="button" className="pnx-batch-cancel" disabled={batchBusy} onClick={() => setSelected(new Set())}>{batchBusy ? '处理中…' : '取消选择'}</button>
        </section>
      )}

      {loading && all.length === 0 ? (
        <div className="pnx-library-loading" role="status"><span aria-hidden /><p>正在翻开词库…</p></div>
      ) : pagination.rows.length === 0 ? (
        <section className="pnx-library-empty">
          <IconBook size={28} />
          <h2>{query || stageFilter !== null || groupFilter ? '没有找到匹配的生词' : '词库还是空的'}</h2>
          <p>{query || stageFilter !== null || groupFilter ? '换个关键词或调整左侧分组、上方阶段筛选。' : '阅读时收藏的生词，会安静地出现在这里。'}</p>
        </section>
      ) : (
        <div className="pnx-word-list" role="list" aria-label="生词列表">
          {pagination.rows.map((word) => {
            const pending = pendingIds.has(word.id)
            const groupMissing = word.group_name && !groups.some((item) => item.name === word.group_name)
            return (
              <article className={`pnx-word-row${selected.has(word.id) ? ' pnx-is-selected' : ''}`} key={word.id} role="listitem">
                <div className="pnx-word-main">
                  <label className="pnx-row-check"><input type="checkbox" checked={selected.has(word.id)} disabled={batchBusy} onChange={() => toggleSelect(word.id)} /><span className="pnx-rv-sr-only">选择 {word.lemma}</span></label>
                  <div className="pnx-word-name"><strong title={word.lemma}>{word.lemma}</strong><small>{STAGE_LABELS[word.stage]}</small></div>
                  <div className="pnx-row-stages" role="group" aria-label={`调整${word.lemma}的阶段`}>
                    {STAGES.map((stage) => (
                      <button type="button" key={stage} disabled={pending || batchBusy} aria-pressed={word.stage === stage} className={word.stage === stage ? 'pnx-is-active' : ''} title={STAGE_LABELS[stage]} onClick={() => void saveWord(word, { stage }, '阶段更新失败')}>{STAGE_LABELS[stage]}</button>
                    ))}
                  </div>
                  <label className="pnx-row-group"><span className="pnx-rv-sr-only">设置 {word.lemma} 的分组</span>
                    <select value={word.group_name ?? ''} disabled={pending || batchBusy} onChange={(event) => void saveWord(word, { group_name: event.target.value }, '分组更新失败')}>
                      <option value="">未分组</option>
                      {groupMissing && <option value={word.group_name ?? ''}>{word.group_name}</option>}
                      {groups.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                  <div className="pnx-row-actions">
                    <button type="button" aria-label={`朗读${word.lemma}`} title="发音" onClick={() => speak(word.lemma)}><IconSpeaker size={15} /></button>
                    <button type="button" aria-label={`编辑${word.lemma}的释义`} title="编辑释义" onClick={() => { setEditingId(word.id); setEditText(word.translation ?? '') }}><IconPencil size={14} /></button>
                    <button type="button" className="pnx-rv-danger" aria-label={`删除${word.lemma}`} title="删除生词" disabled={pending || batchBusy} onClick={() => setDeleting(word)}><IconTrash size={14} /></button>
                  </div>
                </div>

                {editingId === word.id ? (
                  <div className="pnx-translation-edit">
                    <label><span className="pnx-rv-sr-only">编辑 {word.lemma} 的释义</span>
                      <textarea
                        autoFocus
                        rows={2}
                        value={editText}
                        disabled={pending}
                        placeholder="写下中文释义，Ctrl+Enter 保存，Esc 取消"
                        onChange={(event) => setEditText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setEditingId(null)
                          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault()
                            void saveEdit(word)
                          }
                        }}
                      />
                    </label>
                    <div>
                      <button type="button" className="pnx-rv-button pnx-rv-button-primary" disabled={pending} onClick={() => void saveEdit(word)}><IconCheck size={13} />{pending ? '保存中…' : '保存'}</button>
                      <button type="button" className="pnx-rv-button" disabled={pending} onClick={() => setEditingId(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="pnx-row-translation" title="点击编辑释义" onClick={() => { setEditingId(word.id); setEditText(word.translation ?? '') }}>
                    {word.translation || '点击补充释义…'}
                  </button>
                )}
                <footer className="pnx-row-meta"><span>{formatDue(word.due_at)}</span><span>已复习 {word.review_count} 次</span>{word.occurrence_count !== undefined && <span>出现 {word.occurrence_count} 次</span>}<span>间隔 {Math.round(word.interval_days)} 天</span></footer>
              </article>
            )
          })}
        </div>
      )}

      {sorted.length > 0 && (
        <nav className="pnx-pagination" aria-label="词库分页">
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span>第 <strong>{currentPage}</strong> / {pagination.pages} 页</span>
          <button type="button" disabled={currentPage >= pagination.pages} onClick={() => setPage((value) => Math.min(pagination.pages, value + 1))}>下一页</button>
        </nav>
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
        open={batchDeleting}
        title="批量删除生词"
        confirmText="全部删除"
        danger
        busy={batchBusy}
        onClose={() => setBatchDeleting(false)}
        onConfirm={() => void confirmBatchDelete()}
      >
        <p className="pnx-modal-copy">删除选中的 {selected.size} 个生词？此操作无法撤销，复习记录与例句也会一并清除。</p>
      </ConfirmModal>
    </div>
  )
}
