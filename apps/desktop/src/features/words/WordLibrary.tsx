// 词库视图（复习大界面 · 词库标签）：概览统计 + 搜索/排序/筛选 + 批量操作 + 行内编辑 + 分页 + 导出
// 数据双写：列表行以 api.words() 全量响应为本地源；写操作成功后同步本地行并调 useWords.bump/remove
// （正文高亮 stageMap 即时跟随）；组计数变化经 onGroupsChanged 回传复习页左栏
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, saveBlobWithDialog } from '../../api/client'
import { useWords } from '../../stores/words'
import type { Word } from '../../api/types'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import Dropdown, { menuPanelClass } from '../shared/Dropdown'
import { STAGE_LABELS } from './stageLabels'
import { filterWords, libraryStats, paginate, sortWords, type WordSortKey } from './libraryData'
import { speak } from './speech'

const STAGES: (0 | 1 | 2)[] = [0, 1, 2]
const PAGE_SIZE = 50
const SORT_OPTIONS: { key: WordSortKey; label: string }[] = [
  { key: 'added', label: '按添加时间' },
  { key: 'lemma', label: '按字母序' },
  { key: 'due', label: '按到期时间' },
  { key: 'reviews', label: '按复习次数' },
]

interface Props {
  /** ''=全部 / '__none'=未分组 / 组名（与复习页左栏共用一份状态） */
  groupFilter: string
  groups: { name: string; count: number }[]
  onGroupsChanged: () => void
  /** 复习页删组后 +1，触发词表重拉（组内词的分组已被服务端清空） */
  dataVersion: number
}

/** 分组输入 + 自绘建议列表（替代原生 datalist 系统弹层）；点选建议的行为由调用方决定 */
function GroupCombo({
  groups,
  value,
  onChange,
  onPick,
  onSubmit,
  onCancel,
  widthClass,
  placeholder,
  autoFocus,
}: {
  groups: { name: string; count: number }[]
  value: string
  onChange: (v: string) => void
  /** 行内编辑 = 直接提交该分组；批量栏 = 回填输入框再统一移动 */
  onPick: (name: string) => void
  onSubmit: () => void
  onCancel: () => void
  widthClass: string
  placeholder: string
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // 外点/Esc 关闭（ref 含输入框 + 面板，输入框内点击不误关；Esc 交由编辑态取消语义）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const kw = value.trim().toLowerCase()
  const hits = kw === '' ? groups : groups.filter((g) => g.name.toLowerCase().includes(kw))
  return (
    <div ref={rootRef} className={`relative ${widthClass}`}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        maxLength={20}
        className="input h-6 px-1.5 text-[11px]"
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') onSubmit()
        }}
      />
      <div className={menuPanelClass(open, 'left-0 top-full mt-1 w-full min-w-[124px]')}>
        {hits.map((g) => (
          <button
            key={g.name}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[11px] text-text transition-colors hover:bg-bg-soft"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick(g.name)
              setOpen(false)
            }}
          >
            <span className="min-w-0 truncate">{g.name}</span>
            <span className="shrink-0 text-text-faint">{g.count}</span>
          </button>
        ))}
        {hits.length === 0 && (
          <span className="block px-2.5 py-1.5 text-[11px] text-text-faint">回车创建新分组「{value.trim()}」</span>
        )}
      </div>
    </div>
  )
}

export default function WordLibrary({ groupFilter, groups, onGroupsChanged, dataVersion }: Props) {
  const bump = useWords((s) => s.bump)
  const removeWord = useWords((s) => s.remove)
  const [all, setAll] = useState<Word[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [stageFilter, setStageFilter] = useState<0 | 1 | 2 | null>(null)
  const [sortKey, setSortKey] = useState<WordSortKey>('added')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [editingGroup, setEditingGroup] = useState<number | null>(null)
  const [draftGroup, setDraftGroup] = useState('')
  const [deleting, setDeleting] = useState<Word | null>(null)
  const [busy, setBusy] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchGroup, setBatchGroup] = useState('')

  const load = useCallback(async () => {
    try {
      setAll(await api.words())
    } catch {
      toast('生词加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, dataVersion])

  // groupFilter 编码映射：''→null(全部)、'__none'→''(未分组)、组名原样
  const group = groupFilter === '' ? null : groupFilter === '__none' ? '' : groupFilter

  const filtered = useMemo(() => filterWords(all, { q, stage: stageFilter, group }), [all, q, stageFilter, group])
  const sorted = useMemo(() => sortWords(filtered, sortKey), [filtered, sortKey])
  const { rows, pages } = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page])
  const stats = useMemo(() => libraryStats(all, new Date()), [all])

  // 筛选/排序/分组变更回到第 1 页，防越界空页
  useEffect(() => {
    setPage(1)
  }, [q, stageFilter, sortKey, groupFilter])

  const pageIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])
  const allPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const toggleSelectPage = () => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (allPageSelected) {
        for (const id of pageIds) n.delete(id)
      } else {
        for (const id of pageIds) n.add(id)
      }
      return n
    })
  }

  const patchLocal = (w: Word) => setAll((ws) => ws.map((x) => (x.id === w.id ? w : x)))

  const saveEdit = async (w: Word) => {
    const text = editText.trim()
    if (text === (w.translation ?? '')) {
      setEditingId(null)
      return
    }
    try {
      const updated = await api.updateWord(w.id, { translation: text })
      patchLocal(updated)
      bump(updated)
      setEditingId(null)
    } catch {
      toast('释义保存失败', 'error')
    }
  }

  const setStage = async (w: Word, stage: 0 | 1 | 2) => {
    if (w.stage === stage) return
    try {
      const updated = await api.updateWord(w.id, { stage })
      patchLocal(updated)
      bump(updated)
    } catch {
      toast('状态更新失败', 'error')
    }
  }

  const moveWordToGroup = async (w: Word, name: string) => {
    const n = name.trim().slice(0, 20)
    if (!n) {
      toast('请输入分组名', 'error')
      return
    }
    if ((w.group_name ?? '') === n) return
    try {
      const updated = await api.updateWord(w.id, { group_name: n })
      patchLocal(updated)
      bump(updated)
      onGroupsChanged()
    } catch {
      toast('分组失败', 'error')
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await api.deleteWord(deleting.id)
      setAll((ws) => ws.filter((x) => x.id !== deleting.id))
      removeWord(deleting.id)
      toast(`已删除「${deleting.lemma}」`, 'ok')
      setDeleting(null)
      onGroupsChanged()
    } catch {
      toast('删除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  // 批量操作沿用文库批量语义：循环逐个调单条 API，任一失败即停（已完成保留），收尾无条件刷新收敛
  const finishBulk = async (failed: number, okMsg: string, isDelete: boolean) => {
    if (failed) toast(isDelete ? '部分删除失败，已停止' : '部分操作失败，已停止', 'error')
    else toast(okMsg, 'ok')
    setSelected(new Set())
    setBatchGroup('')
    await load()
    onGroupsChanged()
  }

  const bulkStage = async (stage: 0 | 1 | 2) => {
    let failed = 0
    for (const id of [...selected]) {
      try {
        bump(await api.updateWord(id, { stage }))
      } catch {
        failed++
        break
      }
    }
    finishBulk(failed, `已将 ${selected.size} 个生词设为「${STAGE_LABELS[stage]}」`, false)
  }

  const bulkMove = async () => {
    const name = batchGroup.trim().slice(0, 20)
    if (!name) return toast('请输入分组名', 'error')
    let failed = 0
    for (const id of [...selected]) {
      try {
        bump(await api.updateWord(id, { group_name: name }))
      } catch {
        failed++
        break
      }
    }
    finishBulk(failed, `已移动 ${selected.size} 个生词到「${name}」`, false)
  }

  const confirmBatchDelete = async () => {
    setBatchBusy(true)
    let failed = 0
    for (const id of [...selected]) {
      try {
        await api.deleteWord(id)
        removeWord(id)
      } catch {
        failed++
        break
      }
    }
    setBatchBusy(false)
    setBatchDeleting(false)
    finishBulk(failed, `已删除 ${selected.size} 个生词`, true)
  }

  const doExport = async (format: 'csv' | 'anki') => {
    try {
      const blob = await api.wordsExportUrl(format)
      const ok = await saveBlobWithDialog(blob, format === 'csv' ? 'words.csv' : 'words_anki.txt')
      if (ok) toast('已导出', 'ok')
    } catch {
      toast('导出失败', 'error')
    }
  }

  const maxForecast = Math.max(1, ...stats.forecast.map((f) => f.count))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {/* 概览条：阶段卡片兼作筛选 + 今日到期 + 未来 7 天到期预测（面板底，避免与 Waves 背景混杂） */}
      <div className="flex flex-wrap items-center gap-2">
        {([null, ...STAGES] as const).map((s) => {
          const active = stageFilter === s
          const label = s == null ? '全部' : STAGE_LABELS[s]
          const count = s == null ? stats.total : s === 0 ? stats.stage0 : s === 1 ? stats.stage1 : stats.stage2
          return (
            <button
              key={s ?? 'all'}
              onClick={() => setStageFilter(s)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] transition-all ${
                active ? 'border-accent text-accent' : 'border-border text-text-soft hover:border-accent/50'
              }`}
            >
              <span className="opacity-70">{label}</span>
              <b className="ml-1.5 text-[13px]">{count}</b>
            </button>
          )
        })}
        <div className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-text-soft">
          今日到期 <b className="text-accent">{stats.dueToday}</b>
        </div>
        <div className="ml-auto rounded-lg border border-border bg-panel/80 px-3 py-1.5">
          <div className="mb-1 text-right text-[10px] text-text-faint">未来 7 天到期</div>
          <div className="flex items-end gap-2">
            {stats.forecast.map((f, i) => (
              <div key={f.date} className="flex w-6 flex-col items-center gap-1" title={`${f.date} · 到期 ${f.count} 个`}>
                <span className="text-[9px] leading-none text-text-soft">{f.count > 0 ? f.count : ''}</span>
                <div
                  className={`w-4 rounded-t-[3px] ${i === 0 ? 'bg-accent' : f.count > 0 ? 'bg-accent/50' : 'bg-bg-soft'}`}
                  style={{ height: f.count > 0 ? Math.max(6, Math.round((36 * f.count) / maxForecast)) : 3 }}
                />
                <span className={`text-[9px] leading-none ${i === 0 ? 'font-medium text-accent' : 'text-text-faint'}`}>
                  {i === 0 ? '今' : f.date.slice(8)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 工具行：搜索 + 排序 + 全选本页 + 导出 */}
      <div className="flex items-center gap-2">
        <input
          className="input flex-1 py-1 text-xs"
          placeholder="搜索单词 / 释义…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Dropdown
          className="relative shrink-0"
          triggerClass="h-7 rounded-[7px] border border-[var(--border-strong)] bg-panel px-2.5 text-xs transition-colors hover:border-accent"
          label={SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
          items={SORT_OPTIONS.map((o) => ({ key: o.key, label: o.label, active: o.key === sortKey }))}
          onSelect={(k) => setSortKey(k as WordSortKey)}
        />
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={allPageSelected} onChange={toggleSelectPage} />
          全选本页
        </label>
        <button className="btn btn-ghost shrink-0 px-1.5 py-0.5 text-xs" title="导出 CSV" onClick={() => doExport('csv')}>
          CSV
        </button>
        <button className="btn btn-ghost shrink-0 px-1.5 py-0.5 text-xs" title="导出 Anki" onClick={() => doExport('anki')}>
          Anki
        </button>
      </div>

      {/* 批量栏 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs">
          <span className="text-text-soft">
            已选 <b className="text-accent">{selected.size}</b> 项
          </span>
          {STAGES.map((s) => (
            <button
              key={s}
              className="rounded-md px-2 py-0.5 text-text-soft transition-all hover:bg-bg-soft hover:text-accent"
              onClick={() => bulkStage(s)}
            >
              {STAGE_LABELS[s]}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <GroupCombo
            groups={groups}
            value={batchGroup}
            onChange={setBatchGroup}
            onPick={(name) => setBatchGroup(name)}
            onSubmit={bulkMove}
            onCancel={() => setBatchGroup('')}
            widthClass="w-28"
            placeholder="移动到分组…"
          />
          <button className="btn btn-ghost h-6 px-1.5 text-[10.5px]" onClick={bulkMove}>
            移动
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button className="text-[11px] text-danger hover:underline" onClick={() => setBatchDeleting(true)}>
            删除
          </button>
          <button
            className="ml-auto text-[11px] text-text-faint hover:text-text-soft"
            onClick={() => setSelected(new Set())}
          >
            取消
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="spinner" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-faint">
          {q || stageFilter != null || groupFilter !== '' ? '无匹配生词' : '划词收藏的生词会出现在这里'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((w) => (
            <div key={w.id} className="group rounded-lg border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                  checked={selected.has(w.id)}
                  onChange={() => toggleSelect(w.id)}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{w.lemma}</span>
                {STAGES.map((s) => (
                  <button
                    key={s}
                    title={STAGE_LABELS[s]}
                    className={`rounded px-1.5 py-0.5 text-[10.5px] transition-all ${
                      w.stage === s ? 'bg-panel text-accent font-medium' : 'text-text-faint hover:text-text-soft'
                    }`}
                    onClick={() => setStage(w, s)}
                  >
                    {STAGE_LABELS[s][0]}
                  </button>
                ))}
                {editingGroup === w.id ? (
                  <div className="flex items-center gap-1">
                    <GroupCombo
                      groups={groups}
                      value={draftGroup}
                      onChange={setDraftGroup}
                      onPick={(name) => {
                        moveWordToGroup(w, name)
                        setEditingGroup(null)
                      }}
                      onSubmit={() => {
                        moveWordToGroup(w, draftGroup)
                        setEditingGroup(null)
                      }}
                      onCancel={() => setEditingGroup(null)}
                      widthClass="w-24"
                      placeholder="输入新分组名"
                      autoFocus
                    />
                    <button
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] text-accent transition-colors hover:bg-accent-soft"
                      title="确定（Enter）"
                      onClick={() => {
                        moveWordToGroup(w, draftGroup)
                        setEditingGroup(null)
                      }}
                    >
                      ✓
                    </button>
                    <button
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] text-text-faint transition-colors hover:bg-bg-soft hover:text-danger"
                      title="取消（Esc）"
                      onClick={() => setEditingGroup(null)}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="rounded bg-bg-soft px-1.5 py-0.5 text-[11px] text-text-soft">
                      {w.group_name ?? '未分组'}
                    </span>
                    <button
                      className="text-[11px] text-text-faint opacity-0 transition-all hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                      title="编辑分组"
                      onClick={() => {
                        setEditingGroup(w.id)
                        setDraftGroup(w.group_name ?? '')
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="text-[11px] text-text-faint opacity-0 transition-all hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                      title="发音"
                      onClick={() => speak(w.lemma)}
                    >
                      🔊
                    </button>
                    <button
                      className="text-[11px] text-text-faint opacity-0 transition-all hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                      title="删除生词"
                      onClick={() => setDeleting(w)}
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
              {editingId === w.id ? (
                <textarea
                  autoFocus
                  className="input mt-1.5 text-xs"
                  rows={2}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => saveEdit(w)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingId(null)
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(w)
                  }}
                  placeholder="中文释义（Ctrl+Enter 保存，Esc 取消）"
                />
              ) : (
                <button
                  className="mt-0.5 block w-full truncate text-left text-[12px] text-text-soft hover:text-accent"
                  title="点击编辑释义"
                  onClick={() => {
                    setEditingId(w.id)
                    setEditText(w.translation ?? '')
                  }}
                >
                  {w.translation || <span className="text-text-faint">点击补释义…</span>}
                </button>
              )}
              <div className="mt-0.5 text-[10.5px] text-text-faint">
                {STAGE_LABELS[w.stage]}
                {w.review_count > 0 && ` · 复习 ${w.review_count} 次`}
                {w.due_at && w.stage < 2 && ' · 待复习'}
              </div>
            </div>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 py-1 text-xs text-text-faint">
              <button
                className="hover:text-accent disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </button>
              <span>
                第 {Math.min(page, pages)} / {pages} 页
              </span>
              <button
                className="hover:text-accent disabled:opacity-40"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={deleting != null}
        title="删除生词"
        danger
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      >
        <p className="text-xs text-text-soft">
          删除「{deleting?.lemma}」？复习记录与例句将一并清除，正文高亮同步消失。
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={batchDeleting}
        title="批量删除生词"
        danger
        busy={batchBusy}
        onClose={() => setBatchDeleting(false)}
        onConfirm={confirmBatchDelete}
      >
        <p className="text-xs text-text-soft">
          删除选中的 {selected.size} 个生词？复习记录与例句将一并清除，正文高亮同步消失。
        </p>
      </ConfirmModal>
    </div>
  )
}
