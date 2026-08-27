import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { api } from '../../api/client'
import { toast } from '../shared/Toast'
import { insertLink, setHeading, toggleWrap, type EditOp } from './markdownEdit'
import '../../styles/markdown.css'

interface Props {
  paperId: number
  title?: string
}

type Mode = 'preview' | 'edit' | 'split'

const MD_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24] as const

export default function MarkdownReader({ paperId }: Props) {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('pl_md_mode') as Mode) || 'preview')
  const [mdFont, setMdFont] = useState<number>(() => {
    const v = Number(localStorage.getItem('pl_md_fontsize'))
    return (MD_FONT_SIZES as readonly number[]).includes(v) ? v : 14
  })
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('pl_md_mode', mode)
  }, [mode])

  useEffect(() => {
    localStorage.setItem('pl_md_fontsize', String(mdFont))
  }, [mdFont])

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

  const execEdit = useCallback((op: EditOp) => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(op.start, op.end)
    const ok = document.execCommand('insertText', false, op.text)
    if (!ok) {
      const { selectionStart: s, selectionEnd: t, value } = ta
      setDraft(value.slice(0, s) + op.text + value.slice(t))
    }
    requestAnimationFrame(() => ta.setSelectionRange(op.newStart, op.newEnd))
  }, [])

  const applyFormat = useCallback(
    (fn: (value: string, start: number, end: number) => EditOp | null) => {
      const ta = taRef.current
      if (!ta) return
      const op = fn(ta.value, ta.selectionStart, ta.selectionEnd)
      if (op) execEdit(op)
    },
    [execEdit],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save()
      return
    }
    const { selectionStart: s, selectionEnd: t, value } = e.currentTarget
    let op: EditOp | null = null
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') op = toggleWrap(value, s, t, '**')
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') op = toggleWrap(value, s, t, '*')
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'x') op = toggleWrap(value, s, t, '~~')
    else if (mod && (e.key === '`' || e.code === 'Backquote')) op = toggleWrap(value, s, t, '`')
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') op = insertLink(value, s, t)
    else if (mod && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '6')
      op = setHeading(value, s, t, Number(e.key) as 1 | 2 | 3 | 4 | 5 | 6)
    if (op) {
      e.preventDefault()
      execEdit(op)
    }
  }

  useEffect(() => {
    const onWinKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'e') {
        if (e.isComposing) return
        const root = containerRef.current
        if (!root) return
        const el = document.activeElement
        const formLike =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement ||
          (el instanceof HTMLElement && el.isContentEditable)
        const outsideInput = !!el && el !== document.body && !root.contains(el) && formLike
        if (outsideInput) return
        e.preventDefault()
        setMode((m) => (m === 'preview' ? 'edit' : 'preview'))
      }
    }
    window.addEventListener('keydown', onWinKey)
    return () => window.removeEventListener('keydown', onWinKey)
  }, [])

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
    <div ref={containerRef} className="flex h-full flex-col">
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
        <div className="ml-2 flex shrink-0 items-center rounded-md border border-border p-0.5">
          <button
            className="rd-seg text-[10px] leading-none"
            title="减小字号 (A−)"
            disabled={mdFont <= MD_FONT_SIZES[0]}
            onClick={() =>
              setMdFont((f) => MD_FONT_SIZES[Math.max(0, MD_FONT_SIZES.indexOf(f as (typeof MD_FONT_SIZES)[number]) - 1)] ?? f)
            }
            aria-label="减小字号"
          >
            A−
          </button>
          <span className="min-w-9 shrink-0 text-center text-[11px] tabular-nums text-text-faint">{mdFont}px</span>
          <button
            className="rd-seg text-[10px] leading-none"
            title="增大字号 (A＋)"
            disabled={mdFont >= MD_FONT_SIZES[MD_FONT_SIZES.length - 1]}
            onClick={() =>
              setMdFont((f) => MD_FONT_SIZES[Math.min(MD_FONT_SIZES.length - 1, MD_FONT_SIZES.indexOf(f as (typeof MD_FONT_SIZES)[number]) + 1)] ?? f)
            }
            aria-label="增大字号"
          >
            A＋
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
            <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
              <FmtButton title="加粗 (Ctrl+B)" className="font-bold" onClick={() => applyFormat((v, s, t) => toggleWrap(v, s, t, '**'))}>
                B
              </FmtButton>
              <FmtButton title="斜体 (Ctrl+I)" className="italic" onClick={() => applyFormat((v, s, t) => toggleWrap(v, s, t, '*'))}>
                I
              </FmtButton>
              <FmtButton title="删除线 (Ctrl+Shift+X)" className="line-through" onClick={() => applyFormat((v, s, t) => toggleWrap(v, s, t, '~~'))}>
                S
              </FmtButton>
              <FmtButton title="行内代码 (Ctrl+`)" className="font-mono text-[10px]" onClick={() => applyFormat((v, s, t) => toggleWrap(v, s, t, '`'))}>
                {'</>'}
              </FmtButton>
              <FmtButton title="插入链接 (Ctrl+K)" onClick={() => applyFormat(insertLink)}>链接</FmtButton>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <FmtButton
                  key={n}
                  title={`${n} 级标题 (Ctrl+${n})`}
                  onClick={() => applyFormat((v, s, t) => setHeading(v, s, t, n as 1 | 2 | 3 | 4 | 5 | 6))}
                >
                  H{n}
                </FmtButton>
              ))}
            </div>
            <textarea
              ref={taRef}
              className="min-h-0 w-full flex-1 resize-none border-0 bg-bg p-4 font-mono leading-6 text-text outline-none"
              style={{ fontSize: mdFont }}
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
            <div className="markdown-body" style={{ fontSize: mdFont }}>
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

function FmtButton({
  title,
  className = '',
  onClick,
  children,
}: {
  title: string
  className?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      className={`shrink-0 rounded-md px-1.5 py-1 text-xs leading-none text-text-faint transition-colors hover:bg-panel-soft hover:text-text ${className}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
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
