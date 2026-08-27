import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { api } from '../../api/client'
import { toast } from '../shared/Toast'
import '../../styles/markdown.css'

interface Props {
  paperId: number
  title?: string
}

type Mode = 'preview' | 'edit' | 'split'

export default function MarkdownReader({ paperId }: Props) {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('pl_md_mode') as Mode) || 'preview')
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('pl_md_mode', mode)
  }, [mode])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getMarkdown(paperId)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setDraft(r.content)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [paperId])

  const save = useCallback(async () => {
    if (draft === content) {
      toast('无改动', 'info')
      return
    }
    setSaving(true)
    try {
      await api.patchMarkdown(paperId, draft)
      setContent(draft)
      toast('已保存', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }, [paperId, draft, content])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save()
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-faint">
        <span className="spinner" /> <span className="ml-2 text-xs">加载中…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
          <button
            className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${mode === 'preview' ? 'bg-accent text-white shadow-sm' : 'text-text-faint hover:bg-panel-soft hover:text-text'}`}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button
            className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${mode === 'edit' ? 'bg-accent text-white shadow-sm' : 'text-text-faint hover:bg-panel-soft hover:text-text'}`}
            onClick={() => setMode('edit')}
          >
            编辑
          </button>
          <button
            className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${mode === 'split' ? 'bg-accent text-white shadow-sm' : 'text-text-faint hover:bg-panel-soft hover:text-text'}`}
            onClick={() => setMode('split')}
          >
            分栏
          </button>
        </div>
        <span className="ml-2 shrink-0 text-xs text-text-faint">{draft.length} 字符</span>
        <div className="ml-auto flex items-center gap-1.5">
          {draft !== content && <span className="text-xs text-accent">● 未保存</span>}
          <button className="btn btn-primary h-7 px-3 text-xs" onClick={save} disabled={saving || draft === content}>
            {saving ? '保存中…' : '保存 (Ctrl+S)'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(mode === 'edit' || mode === 'split') && (
          <div className={`${mode === 'split' ? 'w-1/2 border-r border-border' : 'w-full'} flex min-h-0 flex-col`}>
            <textarea
              className="h-full w-full resize-none border-0 bg-bg p-4 font-mono text-[13px] leading-6 text-text outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="在此编辑 Markdown…"
              spellCheck={false}
            />
          </div>
        )}
        {(mode === 'preview' || mode === 'split') && (
          <div className={`${mode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto bg-bg`}>
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug, rehypeHighlight]}
                components={{
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  code(props: any) {
                    const { children, className, node, ...rest } = props
                    const match = /language-(\w+)/.exec(className || '')
                    const lang = match ? match[1] : ''
                    const isBlock = String(children).includes('\n') || !!lang
                    if (!isBlock) {
                      return (
                        <code className={className} {...rest}>
                          {children}
                        </code>
                      )
                    }
                    return (
                      <CodeBlock lang={lang} className={className}>
                        {String(children).replace(/\n$/, '')}
                      </CodeBlock>
                    )
                  },
                  table({ children }) {
                    return (
                      <div className="md-table-wrap">
                        <table>{children}</table>
                      </div>
                    )
                  },
                }}
              >
                {(mode === 'preview' ? content : draft) || '*空文档*'}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CodeBlock({ lang, className, children }: { lang: string; className?: string; children: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* ignore */
    }
  }
  const lines = children.split('\n')
  return (
    <pre className={className}>
      <div className="code-head">
        <span className="flex items-center gap-1.5">
          <span>{lang || 'text'}</span>
          <span className="opacity-50">∨</span>
        </span>
        <button className="code-copy" onClick={copy} title="复制">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <code className={className}>
        {lines.map((line, i) => (
          <span key={i} className="code-line">
            <span className="line-no">{i + 1}</span>
            <span>{line || ' '}</span>
          </span>
        ))}
      </code>
    </pre>
  )
}
