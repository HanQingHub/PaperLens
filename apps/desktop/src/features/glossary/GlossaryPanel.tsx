// 右面板·本文术语表：TF-IDF 自动抽取 + 用户修正沉淀
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { GlossaryTerm } from '../../api/types'
import { useReaderBus } from '../../stores/readerBus'
import { toast } from '../shared/Toast'
import '../../styles/panels.css'

export function GlossaryPanel() {
  const paperId = useReaderBus((s) => s.paperId)
  const glossaryVersion = useReaderBus((s) => s.glossaryVersion)
  const [terms, setTerms] = useState<GlossaryTerm[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (paperId == null) return
    setLoading(true)
    try {
      setTerms(await api.glossary(paperId))
    } catch {
      /* 静默 */
    } finally {
      setLoading(false)
    }
  }, [paperId])

  useEffect(() => {
    load()
  }, [load, glossaryVersion])

  const remove = async (t: GlossaryTerm) => {
    try {
      await api.deleteGlossaryTerm(t.id)
      setTerms((list) => list.filter((x) => x.id !== t.id))
      useReaderBus.getState().bumpGlossary()
      toast('已删除术语', 'ok')
    } catch {
      toast('删除失败', 'error')
    }
  }

  if (paperId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <svg width="56" height="56" viewBox="0 0 48 48" fill="none">
          <path
            d="M6 10h12a6 6 0 0 1 6 6v22a4.5 4.5 0 0 0-4.5-4.5H6z"
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
          <path
            d="M42 10H30a6 6 0 0 0-6 6v22a4.5 4.5 0 0 1 4.5-4.5H42z"
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
        </svg>
        <p className="text-xs leading-5 text-text-faint">
          打开论文后，此处显示本文术语表
          <br />
          （TF-IDF 自动抽取 + 你的修正）
        </p>
      </div>
    )
  }

  const userCount = terms.filter((t) => t.source === 'user').length

  return (
    <div className="flex h-full flex-col">
      <div className="pl-subhead shrink-0 border-b border-border px-4 py-2 text-[11px] text-text-faint">
        {terms.length ? `共 ${terms.length} 条 · 用户修正 ${userCount} 条` : '术语表生成中 / 暂无'}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && terms.length === 0 ? (
          <div className="flex justify-center p-6">
            <div className="spinner spinner-lg" />
          </div>
        ) : terms.length === 0 ? (
          <p className="py-8 text-center text-xs leading-5 text-text-faint">
            上传完成后后台自动生成术语表；
            <br />
            也可在翻译卡片点「✎ 修正」沉淀译法
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {terms.map((t) => (
              <div key={t.id} className="panel pl-list-item group flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-serif text-[12.5px] font-medium">{t.term}</span>
                    <span className={`badge shrink-0 ${t.source === 'user' ? 'badge-accent' : ''}`}>
                      {t.source === 'user' ? '用户修正' : '自动'}
                    </span>
                  </div>
                  {t.domain_translation && (
                    <p className="mt-0.5 truncate text-[12px] text-text-soft">{t.domain_translation}</p>
                  )}
                </div>
                <button
                  className="hidden shrink-0 rounded px-1 text-xs text-danger hover:opacity-75 group-hover:block"
                  title="删除术语"
                  onClick={() => remove(t)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
