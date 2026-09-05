import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { api, saveProgress } from '../../api/client'
import { toast } from '../shared/Toast'
import { openExternal } from '../../shared/openExternal'
import { insertLink, insertTable, setHeading, toggleFence, toggleLinePrefix, toggleWrap, type EditOp } from './markdownEdit'
import { parseMdHeadings } from './markdownOutline'
import { IconMenu, IconMinus, IconPlus, IconQuote, IconSearch, IconX } from '../../components/shared/Icon'
import { clearMdDirty, setMdDirty } from './mdDirty'
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
  const previewRef = useRef<HTMLDivElement>(null)
  // 大纲抽屉开关（预览/分栏有点标题滚动，编辑独占点标题走光标）
  const [outlineOpen, setOutlineOpen] = useState(false)
  // 预览全文搜索：输入即查（150ms 防抖），命中上限 FIND_MAX
  const [findOpen, setFindOpen] = useState(false)
  const [mdFind, setMdFind] = useState('')
  const [debouncedFind, setDebouncedFind] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const [findCapped, setFindCapped] = useState(false)
  // 分栏滚动同步锁（编辑→预览单向，防 rAF 竞态）
  const syncLock = useRef(false)
  // 待恢复的滚动比（打开时读进度，预览挂载后消费一次）
  const pendingRatio = useRef<number | null>(null)
  const progressTimer = useRef(0)

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
    pendingRatio.current = null
    setOutlineOpen(false)
    api
      .getMarkdown(paperId)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setDraft(r.content)
        // 进度恢复：服务端不区分 pdf/md，page_no 恒 1，scroll_y 即滚动比
        api
          .readingProgress(paperId)
          .then((p) => {
            if (cancelled || !p) return
            const ratio = Math.max(0, Math.min(1, p.scroll_y ?? 0))
            if (ratio > 0) pendingRatio.current = ratio
          })
          .catch(() => {})
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      window.clearTimeout(progressTimer.current)
      clearMdDirty() // 卸载兜底：防脏态泄漏到下次打开
    }
  }, [paperId])

  // 脏态注册：draft !== content 即脏（拦截点经 mdDirty 查询）。
  // 门控 loading：pid 切换同组件不卸载，加载窗内旧 draft/content 残留，
  // 不门控会把旧脏态误写到新 pid；加载 effect 清理已先 clearMdDirty。
  const isDirty = draft !== content
  useEffect(() => {
    if (loading) return
    setMdDirty(isDirty ? paperId : null)
  }, [isDirty, paperId, loading])

  // 进度恢复消费：预览挂载且有待恢复比率时执行一次；编辑独占首开无预览则保留，
  // 待切 preview/split（effect 因 mode 重跑）时再消费
  useEffect(() => {
    if (loading || pendingRatio.current == null) return
    if (previewRef.current == null) return
    const ratio = pendingRatio.current
    pendingRatio.current = null
    requestAnimationFrame(() => {
      const el = previewRef.current
      if (!el) return
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight)
    })
  }, [loading, mode, content])

  // 预览滚动 → 防抖存进度（尽力而为，失败静默）
  const onPreviewScroll = useCallback(() => {
    window.clearTimeout(progressTimer.current)
    progressTimer.current = window.setTimeout(() => {
      const el = previewRef.current
      if (!el) return
      const max = Math.max(1, el.scrollHeight - el.clientHeight)
      saveProgress(paperId, 1, Math.max(0, Math.min(1, el.scrollTop / max)), false).catch(() => {})
    }, 500)
  }, [paperId])

  // 大纲：按当前渲染源解析（预览=content，分栏/编辑=draft）
  const renderSrc = mode === 'preview' ? content : draft
  const headings = useMemo(() => parseMdHeadings(renderSrc), [renderSrc])

  // 搜索输入防抖（split 每键入不直接重包 DOM）
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedFind(mdFind)
      setFindIdx(0)
    }, 150)
    return () => window.clearTimeout(t)
  }, [mdFind])

  // 搜索高亮：先清后包（React 重渲染会自然丢弃 marks，effect 幂等）
  useEffect(() => {
    const root = previewRef.current
    if (root) clearFindMarks(root)
    if (!root || !debouncedFind) {
      setFindCount(0)
      setFindCapped(false)
      return
    }
    const { count, capped } = wrapFindMarks(root, debouncedFind, findIdx)
    setFindCount(count)
    setFindCapped(capped)
    if (count > 0 && findIdx >= count) {
      setFindIdx(0)
      return
    }
    root.querySelector('mark[data-mdfind-cur]')?.scrollIntoView({ block: 'center' })
  }, [debouncedFind, findIdx, mode, content, draft])

  // 分栏滚动同步（编辑→预览单向；预览手动滚不反驱）
  const onEditScroll = useCallback(
    (e: React.UIEvent<HTMLTextAreaElement>) => {
      if (mode !== 'split' || syncLock.current) return
      const ta = e.currentTarget
      const pv = previewRef.current
      if (!pv) return
      const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight)
      syncLock.current = true
      requestAnimationFrame(() => {
        pv.scrollTop = ratio * Math.max(0, pv.scrollHeight - pv.clientHeight)
        syncLock.current = false
      })
    },
    [mode],
  )

  // 大纲跳转：有预览走滚动，无预览（编辑独占）走光标
  const gotoHeading = useCallback(
    (line: number, index: number) => {
      const pv = previewRef.current
      if (pv) {
        const els = pv.querySelectorAll('h1,h2,h3,h4,h5,h6')
        const el = els[index] as HTMLElement | undefined
        if (el) el.scrollIntoView({ block: 'start' })
      } else {
        const ta = taRef.current
        if (!ta) return
        let pos = 0
        const lines = draft.split('\n')
        for (let i = 0; i < Math.min(line, lines.length); i++) pos += lines[i].length + 1
        ta.focus()
        ta.setSelectionRange(pos, pos)
        ta.scrollTop = Math.max(0, pos > 0 ? (pos / Math.max(1, draft.length)) * ta.scrollHeight - ta.clientHeight / 2 : 0)
      }
      setOutlineOpen(false)
    },
    [draft],
  )

  const save = useCallback(async () => {
    if (draft === content) {
      toast('无改动', 'info')
      return
    }
    setSaving(true)
    try {
      await api.patchMarkdown(paperId, draft)
      setContent(draft)
      clearMdDirty() // 保存成功即不脏，否则确认框阴魂不散
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
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') op = toggleLinePrefix(value, s, t, '- ')
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'q') op = toggleLinePrefix(value, s, t, '> ')
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') op = toggleFence(value, s, t)
    else if (mod && e.shiftKey && e.key.toLowerCase() === 't') op = insertTable(value, s, t)
    else if (mod && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '6')
      op = setHeading(value, s, t, Number(e.key) as 1 | 2 | 3 | 4 | 5 | 6)
    if (op) {
      e.preventDefault()
      execEdit(op)
    }
  }

  // 浏览器刷新/关闭：脏时弹原生确认（chrome 后退不在拦截范围，见计划 §四.7）
  useEffect(() => {
    if (!isDirty) return
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [isDirty])

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
        <button
          className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
          title={headings.length ? '目录大纲' : '本文无标题'}
          disabled={headings.length === 0}
          onClick={() => setOutlineOpen((v) => !v)}
        >
          目录{headings.length ? `(${headings.length})` : ''}
        </button>
        <button
          className={`btn btn-ghost flex shrink-0 items-center px-2 py-1 text-xs ${findOpen ? 'text-accent' : ''}`}
          title="预览全文搜索"
          onClick={() => setFindOpen((v) => !v)}
        >
          <IconSearch size={12} />
        </button>
        {findOpen && (
          <span className="flex shrink-0 items-center gap-1">
            <input
              className="input h-7 w-36 px-2 text-xs"
              placeholder="搜索预览…"
              value={mdFind}
              onChange={(e) => setMdFind(e.target.value)}
              onKeyDown={(e) => {
                const step = (d: number) => setFindIdx((i) => (findCount > 0 ? (i + d + findCount) % findCount : 0))
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  step(1)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  step(-1)
                } else if (e.key === 'Escape') {
                  setFindOpen(false)
                  setMdFind('')
                }
              }}
            />
            <span
              className="shrink-0 text-[11px] tabular-nums text-text-faint"
              title={findCapped ? '仅显示前 500 处' : undefined}
            >
              {debouncedFind
                ? findCount > 0
                  ? `${findIdx + 1}/${findCount}${findCapped ? '+（仅显示前 500 处）' : ''}`
                  : '无匹配'
                : ''}
            </span>
            <button
              className="btn btn-ghost px-1.5 py-1 text-xs"
              title="上一个"
              onClick={() => setFindIdx((i) => (findCount > 0 ? (i + findCount - 1) % findCount : 0))}
            >
              ↑
            </button>
            <button
              className="btn btn-ghost px-1.5 py-1 text-xs"
              title="下一个"
              onClick={() => setFindIdx((i) => (findCount > 0 ? (i + 1) % findCount : 0))}
            >
              ↓
            </button>
          </span>
        )}
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
            className="rd-seg flex items-center gap-0.5 text-[10px] leading-none"
            title="减小字号"
            disabled={mdFont <= MD_FONT_SIZES[0]}
            onClick={() =>
              setMdFont((f) => MD_FONT_SIZES[Math.max(0, MD_FONT_SIZES.indexOf(f as (typeof MD_FONT_SIZES)[number]) - 1)] ?? f)
            }
            aria-label="减小字号"
          >
            A<IconMinus size={9} />
          </button>
          <span className="min-w-9 shrink-0 text-center text-[11px] tabular-nums text-text-faint">{mdFont}px</span>
          <button
            className="rd-seg flex items-center gap-0.5 text-[10px] leading-none"
            title="增大字号"
            disabled={mdFont >= MD_FONT_SIZES[MD_FONT_SIZES.length - 1]}
            onClick={() =>
              setMdFont((f) => MD_FONT_SIZES[Math.min(MD_FONT_SIZES.length - 1, MD_FONT_SIZES.indexOf(f as (typeof MD_FONT_SIZES)[number]) + 1)] ?? f)
            }
            aria-label="增大字号"
          >
            A<IconPlus size={9} />
          </button>
        </div>
        <span className="ml-2 shrink-0 text-xs text-text-faint">{draft.length} 字符</span>
        <div className="ml-auto flex items-center gap-1.5">
          {draft !== content && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              未保存
            </span>
          )}
          <button className="btn btn-primary h-7 px-3 text-xs" onClick={save} disabled={saving || draft === content}>
            {saving ? '保存中…' : '保存 (Ctrl+S)'}
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {outlineOpen &&
          (headings.length > 0 ? (
          <aside className="md-outline-drawer">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-xs font-medium">目录大纲</span>
              <button
                className="flex items-center px-1 text-xs text-text-faint hover:text-danger"
                title="关闭大纲"
                onClick={() => setOutlineOpen(false)}
              >
                <IconX size={11} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {headings.map((h, i) => (
                <button
                  key={`${h.line}-${i}`}
                  className="block w-full truncate rounded-md px-2 py-1 text-left text-[12px] text-text-soft transition-colors hover:bg-accent-soft hover:text-accent"
                  style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
                  title={h.title}
                  onClick={() => gotoHeading(h.line, i)}
                >
                  {h.title}
                </button>
              ))}
            </div>
          </aside>
          ) : (
            <aside className="md-outline-drawer">
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-medium">目录大纲</span>
              <button
                className="flex items-center px-1 text-xs text-text-faint hover:text-danger"
                title="关闭大纲"
                onClick={() => setOutlineOpen(false)}
              >
                <IconX size={11} />
              </button>
              </div>
              <p className="p-3 text-center text-[11px] text-text-faint">本文无标题</p>
            </aside>
          ))}
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
              <FmtButton title="无序列表 (Ctrl+Shift+L)" onClick={() => applyFormat((v, s, t) => toggleLinePrefix(v, s, t, '- '))}>
                <IconMenu size={12} />
              </FmtButton>
              <FmtButton title="引用 (Ctrl+Shift+Q)" onClick={() => applyFormat((v, s, t) => toggleLinePrefix(v, s, t, '> '))}>
                <IconQuote size={12} />
              </FmtButton>
              <FmtButton title="代码块 (Ctrl+Shift+C)" className="font-mono text-[10px]" onClick={() => applyFormat((v, s, t) => toggleFence(v, s, t))}>
                {'```'}
              </FmtButton>
              <FmtButton title="表格 (Ctrl+Shift+T)" onClick={() => applyFormat((v, s, t) => insertTable(v, s, t))}>
                表
              </FmtButton>
            </div>
            <textarea
              ref={taRef}
              className="min-h-0 w-full flex-1 resize-none border-0 bg-bg p-4 font-mono leading-6 text-text outline-none"
              style={{ fontSize: mdFont }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={onEditScroll}
              placeholder="在此编辑 Markdown…"
              spellCheck={false}
            />
          </div>
        )}
        {(mode === 'preview' || mode === 'split') && (
          <div
            ref={previewRef}
            onScroll={onPreviewScroll}
            className={`${mode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto bg-bg`}
          >
            <div className="markdown-body" style={{ fontSize: mdFont }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug, rehypeHighlight]}
                components={{
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  a(props: any) {
                    const { href, children, ...rest } = props
                    const url: string = href ?? ''
                    if (/^https?:\/\//i.test(url)) {
                      // 调用前已过滤 scheme：Tauri 走系统浏览器，dev 回退 window.open
                      return (
                        <a
                          href={url}
                          {...rest}
                          onClick={(e) => {
                            e.preventDefault()
                            openExternal(url).catch(() => toast('打开外部链接失败', 'error'))
                          }}
                        >
                          {children}
                        </a>
                      )
                    }
                    if (/^(mailto|tel|file):/i.test(url) || url === '') {
                      // 与 PDF 口径一致：非 http(s) 无动作
                      return (
                        <a href={url} {...rest} onClick={(e) => e.preventDefault()}>
                          {children}
                        </a>
                      )
                    }
                    return (
                      <a href={url} {...rest}>
                        {children}
                      </a>
                    )
                  },
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

/** 预览全文搜索命中上限（超限截断并提示 `+`） */
const FIND_MAX = 500

function clearFindMarks(root: HTMLElement) {
  root.querySelectorAll('mark[data-mdfind]').forEach((m) => {
    m.parentNode?.replaceChild(document.createTextNode(m.textContent ?? ''), m)
  })
  root.normalize()
}

/**
 * 在预览 DOM 内包裹查询命中（大小写不敏感，纯字面非正则）。
 * 逐文本节点切分；跳过代码行号 `.line-no`；跨节点命中不支持（已知缺口）。
 * 返回实际包裹数与是否截断。
 */
function wrapFindMarks(root: HTMLElement, query: string, curIdx: number): { count: number; capped: boolean } {
  const q = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      if (el.closest('.line-no') || el.closest('mark[data-mdfind]')) return NodeFilter.FILTER_REJECT
      if (!node.textContent || !node.textContent.toLowerCase().includes(q)) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  let count = 0
  let capped = false
  outer: for (const node of nodes) {
    let cur: Text | null = node
    for (;;) {
      if (!cur?.textContent) break
      const i = cur.textContent.toLowerCase().indexOf(q)
      if (i < 0) break
      if (count >= FIND_MAX) {
        capped = true
        break outer
      }
      const match = cur.splitText(i)
      const after = match.splitText(query.length)
      const mark = document.createElement('mark')
      mark.setAttribute('data-mdfind', '')
      if (count === curIdx) mark.setAttribute('data-mdfind-cur', '')
      mark.textContent = match.textContent
      match.parentNode?.replaceChild(mark, match)
      count++
      cur = after
    }
  }
  return { count, capped }
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
