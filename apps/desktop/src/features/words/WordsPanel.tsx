// 生词库管理面板：全量词表 + 搜索/筛选 + 行内编辑 + 删除 + 导出
// 数据双写：列表行以 api.words 响应为本地源；每次写操作成功后同步本地行
// 并调 useWords.bump/remove —— 正文高亮 stageMap 即时跟随（G4/G5 同一机制）
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useWords } from '../../stores/words'
import type { Word } from '../../api/types'
import { ConfirmModal } from '../shared/Modal'
import { toast } from '../shared/Toast'
import { saveBlobWithDialog } from '../../api/client'
import { STAGE_LABELS } from './stageLabels'

const STAGES: (0 | 1 | 2)[] = [0, 1, 2]
const LIST_CAP = 500

export default function WordsPanel() {
  const bump = useWords((s) => s.bump)
  const removeWord = useWords((s) => s.remove)
  const [rows, setRows] = useState<Word[]>([])
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [stageFilter, setStageFilter] = useState<0 | 1 | 2 | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [deleting, setDeleting] = useState<Word | null>(null)
  const [busy, setBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const list = await api.words({ q: q || undefined, stage: stageFilter ?? undefined })
      setTruncated(list.length > LIST_CAP)
      setRows(list.slice(0, LIST_CAP))
    } catch {
      toast('生词加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [q, stageFilter])

  useEffect(() => {
    load()
  }, [load])

  // 搜索防抖
  useEffect(() => {
    const t = window.setTimeout(() => setQ(qInput.trim().toLowerCase()), 300)
    return () => window.clearTimeout(t)
  }, [qInput])

  const patchLocal = (w: Word) => setRows((rs) => rs.map((r) => (r.id === w.id ? w : r)))

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

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await api.deleteWord(deleting.id)
      setRows((rs) => rs.filter((r) => r.id !== deleting.id))
      removeWord(deleting.id)
      toast(`已删除「${deleting.lemma}」`, 'ok')
      setDeleting(null)
    } catch {
      toast('删除失败', 'error')
    } finally {
      setBusy(false)
    }
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

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <input
          className="input flex-1 py-1 text-xs"
          placeholder="搜索单词 / 释义…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <button className="btn btn-ghost px-1.5 py-0.5 text-xs" title="导出 CSV" onClick={() => doExport('csv')}>
          CSV
        </button>
        <button className="btn btn-ghost px-1.5 py-0.5 text-xs" title="导出 Anki" onClick={() => doExport('anki')}>
          Anki
        </button>
      </div>

      <div className="flex gap-1 text-[12px]">
        {([null, ...STAGES] as const).map((s) => (
          <button
            key={s ?? 'all'}
            className={`rounded-md px-2 py-0.5 transition-all ${
              stageFilter === s ? 'bg-panel text-accent font-medium' : 'text-text-faint hover:text-text-soft'
            }`}
            onClick={() => setStageFilter(s)}
          >
            {s == null ? '全部' : STAGE_LABELS[s]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="spinner" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-faint">
          {q || stageFilter != null ? '无匹配生词' : '划词收藏的生词会出现在这里'}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {rows.map((w) => (
            <div key={w.id} className="group rounded-lg border border-border p-2">
              <div className="flex items-center gap-2">
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
                <button
                  className="text-[11px] text-text-faint opacity-0 transition-all hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                  title="删除生词"
                  onClick={() => setDeleting(w)}
                >
                  🗑
                </button>
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
          {truncated && (
            <p className="py-1 text-center text-[11px] text-text-faint">
              仅显示前 {LIST_CAP} 条，请用搜索或筛选缩小范围
            </p>
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
    </div>
  )
}
