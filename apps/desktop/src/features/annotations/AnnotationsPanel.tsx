// 右面板·批注与摘录：Tab 切换、过滤、定位、删除、导出 Markdown
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, patchAnnotation, saveBlobWithDialog } from '../../api/client'
import { parseAnchor, type Annotation, type Excerpt } from '../../api/types'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'

const COLOR_HEX: Record<string, string> = {
  yellow: '#ffe08a',
  green: '#a8d5a2',
  blue: '#a9d3e8',
  pink: '#f5b8c4',
  purple: '#c9b6e4',
}

function fmtTime(iso: string) {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function AnnotationsPanel() {
  const paperId = useReaderBus((s) => s.paperId)
  const annotationsVersion = useReaderBus((s) => s.annotationsVersion)
  const locateAnnotation = useReaderBus((s) => s.locateAnnotation)

  const [tab, setTab] = useState<'annotations' | 'excerpts'>('annotations')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [excerpts, setExcerpts] = useState<Excerpt[]>([])
  const [loading, setLoading] = useState(false)
  // 过滤器
  const [colorFilter, setColorFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | 'word_note' | 'sentence'>('all')
  const [keyword, setKeyword] = useState('')

  const load = useCallback(async () => {
    if (paperId == null) return
    setLoading(true)
    try {
      const [annos, excs] = await Promise.all([api.annotations(paperId), api.excerpts(paperId)])
      setAnnotations(annos)
      setExcerpts(excs)
    } catch (e) {
      toast(e instanceof Error ? e.message : '批注加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [paperId])

  useEffect(() => {
    load()
  }, [load, annotationsVersion])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return annotations.filter((a) => {
      if (colorFilter !== 'all' && (a.color ?? '') !== colorFilter) return false
      if (typeFilter !== 'all' && a.type !== typeFilter) return false
      if (kw) {
        const anchorText = parseAnchor(a)?.text ?? ''
        if (!anchorText.toLowerCase().includes(kw) && !(a.text ?? '').toLowerCase().includes(kw)) return false
      }
      return true
    })
  }, [annotations, colorFilter, typeFilter, keyword])

  const removeExcerpt = async (id: number) => {
    try {
      await api.deleteExcerpt(id)
      setExcerpts((list) => list.filter((e) => e.id !== id))
      toast('摘录已删除', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    }
  }

  // 批注 inline 编辑 / 删除（§高亮删除功能 G2）
  const [editingAnnoId, setEditingAnnoId] = useState<number | null>(null)
  const [annoEditText, setAnnoEditText] = useState('')
  const bumpAnnotations = useReaderBus((s) => s.bumpAnnotations)

  const startEditAnno = (a: Annotation) => {
    setEditingAnnoId(a.id)
    setAnnoEditText(a.text ?? '')
  }
  const saveEditAnno = async (id: number) => {
    setEditingAnnoId(null)
    try {
      const raw = await patchAnnotation(id, { text: annoEditText })
      setAnnotations((list) => list.map((x) => (x.id === id ? raw : x)))
      bumpAnnotations()
      toast('批注已保存', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error')
    }
  }
  const removeAnno = async (id: number) => {
    try {
      await api.deleteAnnotation(id)
      setAnnotations((list) => list.filter((x) => x.id !== id))
      bumpAnnotations()
      toast('批注已删除', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    }
  }

  const exportMd = async () => {
    if (paperId == null) return
    try {
      const blob = await api.exportExcerpts(paperId)
      const saved = await saveBlobWithDialog(blob, 'excerpts.md')
      if (!saved) return
      toast('摘录已导出为 Markdown', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '导出失败', 'error')
    }
  }

  if (paperId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
          <rect x="10" y="6" width="24" height="34" rx="3" stroke="var(--border-strong)" strokeWidth="2" />
          <path d="M16 14h12M16 20h12M16 26h8" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
          <circle cx="35" cy="33" r="9" fill="var(--accent-soft)" />
          <path d="M31 33h8M35 29v8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="text-xs leading-5 text-text-faint">
          打开论文后，此处显示该文的
          <br />
          批注与摘录
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab */}
      <div className="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-border bg-panel px-3 pt-2">
        {(
          [
            ['annotations', `批注 ${annotations.length}`],
            ['excerpts', `摘录 ${excerpts.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`rounded-t-md border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${tab === key ? 'border-accent font-medium text-accent' : 'border-transparent text-text-faint hover:text-text-soft'}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'annotations' && (
        <>
          {/* 过滤器 */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <select className="input w-auto py-0.5 text-[11.5px]" value={colorFilter} onChange={(e) => setColorFilter(e.target.value)}>
              <option value="all">全部颜色</option>
              {Object.entries(COLOR_HEX).map(([k]) => (
                <option key={k} value={k}>
                  {['黄', '绿', '蓝', '粉', '紫'][Object.keys(COLOR_HEX).indexOf(k)]}
                </option>
              ))}
            </select>
            <select className="input w-auto py-0.5 text-[11.5px]" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
              <option value="all">全部类型</option>
              <option value="word_note">词句笔记</option>
              <option value="sentence">句子高亮</option>
            </select>
            <input className="input min-w-0 flex-1 py-0.5 text-[11.5px]" placeholder="关键词…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading && annotations.length === 0 ? (
              <div className="flex justify-center p-6">
                <div className="spinner spinner-lg" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-xs text-text-faint">
                {annotations.length === 0 ? '暂无批注。阅读时选中文本即可添加批注' : '没有符合过滤条件的批注'}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((a) => {
                  const anchorText = parseAnchor(a)?.text ?? ''
                  const editing = editingAnnoId === a.id
                  return (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      className="panel pl-list-item group w-full cursor-pointer p-2.5 text-left"
                      onClick={() => locateAnnotation(a.id, a.page_no)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') locateAnnotation(a.id, a.page_no)
                      }}
                      title="点击定位到原文"
                    >
                      <div className="flex items-center gap-1.5 text-[10.5px] text-text-faint">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR_HEX[a.color ?? ''] ?? 'var(--border-strong)' }} />
                        <span>p.{a.page_no}</span>
                        <span>{a.type === 'word_note' ? '笔记' : '高亮'}</span>
                        <span className="ml-auto">{fmtTime(a.updated_at || a.created_at)}</span>
                        <button
                          className="hidden shrink-0 rounded px-1 hover:text-accent group-hover:block"
                          title="编辑笔记"
                          onClick={(e) => {
                            e.stopPropagation()
                            startEditAnno(a)
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="hidden shrink-0 rounded px-1 text-danger hover:opacity-75 group-hover:block"
                          title="删除批注"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeAnno(a.id)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      {anchorText && (
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-text-soft">
                          <span className="rounded px-0.5" style={{ background: `${COLOR_HEX[a.color ?? 'yellow']}55` }}>
                            {anchorText}
                          </span>
                        </p>
                      )}
                      {editing ? (
                        <textarea
                          autoFocus
                          className="input mt-1 w-full text-[12px] leading-5"
                          value={annoEditText}
                          style={{ height: 64 }}
                          placeholder="写点笔记…"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setAnnoEditText(e.target.value)}
                          onBlur={() => saveEditAnno(a.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingAnnoId(null)
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditAnno(a.id)
                          }}
                        />
                      ) : (
                        a.text && <p className="mt-1 line-clamp-2 text-[12px] leading-5">{a.text}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'excerpts' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex justify-end">
            <button className="btn px-2 py-0.5 text-[11.5px]" onClick={exportMd} disabled={excerpts.length === 0}>
              导出 Markdown
            </button>
          </div>
          {excerpts.length === 0 ? (
            <p className="py-8 text-center text-xs text-text-faint">暂无摘录。阅读时选中句子可一键摘录（原文 + 译文 + 笔记）</p>
          ) : (
            <div className="flex flex-col gap-2">
              {excerpts.map((e) => (
                <div key={e.id} className="panel pl-list-item group p-2.5">
                  <div className="flex items-center gap-2 text-[10.5px] text-text-faint">
                    <span>p.{e.page_no ?? '?'}</span>
                    <span className="ml-auto">{fmtTime(e.created_at)}</span>
                    <button
                      className="hidden rounded px-1 text-danger hover:opacity-75 group-hover:block"
                      title="删除摘录"
                      onClick={() => removeExcerpt(e.id)}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-3 border-l-2 border-border pl-2 text-[12px] leading-5 text-text-soft">{e.text}</p>
                  {e.translation && <p className="mt-1 line-clamp-2 text-[12px] leading-5">{e.translation}</p>}
                  {e.note && <p className="mt-1 line-clamp-2 text-[11.5px] leading-5 text-text-faint">✎ {e.note}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
