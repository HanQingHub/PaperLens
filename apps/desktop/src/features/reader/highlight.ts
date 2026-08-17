// textLayer / OCR 层词级拆分与高亮（§8.5）
// pdfjs 的 text span 是 absolute + transform，子元素用 <i> 包裹避开 .textLayer span 选择器
import { lookupStage } from './lemma'

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

export interface HighlightOptions {
  stageMap: Map<string, 0 | 1 | 2>
  enabled: boolean
  /** 搜索命中词集合（小写原文） */
  searchTerms?: Set<string>
  /** 当前聚焦的搜索词（强调色） */
  currentTerm?: string | null
}

interface Fragment {
  text: string
  isWord: boolean
}

function splitFragments(text: string): Fragment[] {
  const frags: Fragment[] = []
  let last = 0
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(text)) !== null) {
    if (m.index > last) frags.push({ text: text.slice(last, m.index), isWord: false })
    frags.push({ text: m[0], isWord: true })
    last = m.index + m[0].length
  }
  if (last < text.length) frags.push({ text: text.slice(last), isWord: false })
  return frags
}

/**
 * 对容器内每个 pdfjs 文本 span 重建子节点：命中词库 → .hl-stage-N；
 * 命中搜索词 → .search-hit / .search-hit-current。
 * 原始文本保存在 dataset.orig，可重复调用（词库/搜索变更时刷新）。
 */
export function applyHighlights(container: HTMLElement, opts: HighlightOptions) {
  const spans = container.querySelectorAll<HTMLElement>('.textLayer > span, .ocr-block')
  for (const span of spans) {
    if (span.classList.contains('endOfContent')) continue
    if (!span.dataset.orig) span.dataset.orig = span.textContent ?? ''
    const text = span.dataset.orig
    if (!opts.enabled && !opts.searchTerms?.size) {
      if (span.textContent !== text) span.textContent = text
      continue
    }
    if (!/[A-Za-z]/.test(text)) {
      if (span.textContent !== text) span.textContent = text
      continue
    }
    span.textContent = ''
    for (const frag of splitFragments(text)) {
      if (!frag.isWord) {
        span.append(frag.text)
        continue
      }
      const lower = frag.text.toLowerCase()
      let cls = ''
      if (opts.enabled) {
        const stage = lookupStage(frag.text, opts.stageMap)
        if (stage !== undefined) cls = `hl-stage-${stage}`
      }
      if (!cls && opts.searchTerms?.has(lower)) {
        cls = lower === opts.currentTerm ? 'search-hit search-hit-current' : 'search-hit'
      }
      if (cls) {
        const el = document.createElement('i')
        el.className = cls
        el.textContent = frag.text
        span.append(el)
      } else {
        span.append(frag.text)
      }
    }
  }
}
