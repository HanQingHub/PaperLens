// 句读纯函数（无 DOM/pdfjs 依赖，便于 vitest 直测）
//
// v2（0.9.0）：面向真实 PDF/OCR 提取文本重写。旧版三个硬伤：
//   ① 小数/编号被当成句末（"64.2%" → "64." | "Section 3.1" → "3."），学术文本断句稀碎；
//   ② 选区按空白折叠后与页文本（含 "-\n" 断行连字符、多余空格）不相等 → indexOf 落空 →
//      整段上下文丢失，LLM 只剩一个孤词；
//   ③ 页眉/标题/图表题被当成句子前缀粘进"当前句"，译前上下文里出现 "B. M1: Layer Ablation"。
//
// 现行做法：
//   1) 边界保护：小数/版本号/DOI、缩写（e.g./et al./Fig./Eq./Sec.）、首字母缩写
//      （U.S./Ph.D.）、人名首字母（J. Smith）先替换占位符；
//   2) 边界裁决：句点后必须是"非小写字母"才换句（"Fig. 1 shows"、"in Sec. 3 we" 不断句）；
//   3) 定位模糊化：两侧都归一为"仅字母数字 + 小写 + 丢弃断行连字符"的键再互相查找，
//      并用 key→原文偏移映射表还原位置；连字（ﬁ）、全角字母一并归一；
//   4) 家具行（页码/图表题/节标题/短 Title-Case 行/空行）作为硬边界，不进入句子延伸，
//      句首残留的编号与标题碎片按"选区之前的前缀"精确剥离。

const PH = '\uE000' // 受保护句点占位符（私用区，正文不可能出现）

/** 缩写（其后句点不是句末）：学术写作高频集合 */
const ABBREV_RE =
  /\b(?:e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|Sec|Secs|Tab|Tabs|Ref|Refs|etc|vs|No|Nos|Mr|Mrs|Ms|Dr|St|Prof|cf|pp|p|vol|Vol|approx|resp|al|Inc|Ltd|Co|Jr|Sr|w\.r\.t)\./gi
/** 首字母缩写链：U.S. / e.g. / i.e. / Ph.D. / w.r.t. */
const ACRONYM_RE = /\b(?:[A-Za-z]\.){2,}/g
/** 小数 / 版本号 / 多级编号 / DOI：64.2 / 3.1.2 / 10.1145/xxx.yyy
 * 注意不能用 \b 起头：Qwen3.6 / GPT-5.6 / Mimo-V2.5 里字母与数字之间没有词边界，
 * \b 会漏保护 → 句点把 "Qwen3.6." 切成两句（模型名被截断，译前上下文失真）。 */
const NUMBER_RE = /(?<![\d.])\d+(?:\.\d+)+(?![\d])/g
/** 人名首字母：J. Smith / R. S. Sutton */
const INITIAL_RE = /\b[A-Z]\.(?=\s+[A-Z][a-z])/g
/** 句末候选：句点族（含中文）+ 可选收尾引号/括号 + 空白 / 非 ASCII 紧随 / 文本结束。
 * 中文句末标点后不带空格（"这是一句。这是第二句"），故补非 ASCII 前瞻分支。 */
const BOUNDARY_RE = /([.?!。！？]+)(["'”’»)\]】》]*)(\s+|(?=[^\x00-\x7f])|$)/g

const MAX_SENTENCE_CHARS = 400
const MAX_CONTEXT_CHARS = 600

/** 连字与全角字母：key 归一（同一原文偏移可展开成多个键字符） */
const LIGATURES: Record<string, string> = {
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
}

function normChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCharCode(cp - 0xfee0) // 全角 → 半角
  const lig = LIGATURES[ch]
  if (lig) return lig
  return ch
}

/**
 * 定位键：仅保留字母数字（小写），丢弃标点/空白，以及"断行连字符"
 * （"-" 后紧跟空白 = PDF 换行连字符，atten-\ntion 应等价于 attention）。
 * 返回 key 与 key 每个字符对应的原文起始偏移，末尾附加原文长度哨兵。
 */
export function locateKey(text: string): { key: string; map: number[] } {
  let key = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]
    if (raw === '-' && /\s/.test(text[i + 1] ?? '')) continue
    const norm = normChar(raw)
    for (const ch of norm) {
      if (!/[A-Za-z0-9]/.test(ch)) continue
      key += ch.toLowerCase()
      map.push(i)
    }
  }
  map.push(text.length)
  return { key, map }
}

/** 在 text 中查找 needleKey（已归一），返回原文起止偏移；未命中返回 null */
export function locateKeyIn(text: string, needleKey: string): { start: number; end: number } | null {
  if (!needleKey) return null
  const { key, map } = locateKey(text)
  const at = key.indexOf(needleKey)
  if (at < 0) return null
  return { start: map[at], end: map[at + needleKey.length - 1] + 1 }
}

/** 句点边界保护：把"非句末"的句点换成占位符 */
function protectDots(text: string): string {
  return text
    .replace(ACRONYM_RE, (m) => m.replace(/\./g, PH))
    .replace(ABBREV_RE, (m) => m.replace(/\./g, PH))
    .replace(NUMBER_RE, (m) => m.replace(/\./g, PH))
    .replace(INITIAL_RE, (m) => m.replace(/\./g, PH))
}

function restore(s: string): string {
  return s.replace(/\uE000/g, '.')
}

/** 句末裁决：句点后紧跟小写字母/逗号分号冒号 → 句中断点 */
function isRealBoundary(text: string, end: number, punct: string): boolean {
  if (/[?!。！？]/.test(punct)) return true
  const rest = text.slice(end)
  const m = rest.match(/^\s*([\s\S])/)
  if (!m) return true
  const ch = m[1]
  if (/[a-z]/.test(ch)) return false
  if (/[,;:]/.test(ch)) return false
  return true
}

function chunkLong(s: string): string[] {
  if (s.length <= MAX_SENTENCE_CHARS) return [s]
  const words = s.split(/\s+/)
  const chunks: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && cur.length + w.length + 1 > MAX_SENTENCE_CHARS) {
      chunks.push(cur)
      cur = w
    } else {
      cur = cur ? `${cur} ${w}` : w
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** 正文切句（保护缩写/小数/编号，中文句末标点同样支持） */
export function splitSentences(text: string): string[] {
  if (!text.trim()) return []
  const guarded = protectDots(text)
  const out: string[] = []
  let start = 0
  BOUNDARY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BOUNDARY_RE.exec(guarded)) !== null) {
    const end = m.index + m[1].length + m[2].length
    if (!isRealBoundary(guarded, end, m[1])) continue
    const piece = guarded.slice(start, end).trim()
    if (piece) out.push(...chunkLong(piece))
    start = m.index + m[0].length
  }
  const rest = guarded.slice(start).trim()
  if (rest) out.push(...chunkLong(rest))
  return out.map(restore)
}

/** 文本中最后一个句末边界之后的偏移（无边界返回 0） */
function lastBoundaryEnd(text: string): number {
  const guarded = protectDots(text)
  let at = 0
  BOUNDARY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BOUNDARY_RE.exec(guarded)) !== null) {
    const end = m.index + m[1].length + m[2].length
    if (!isRealBoundary(guarded, end, m[1])) continue
    at = m.index + m[0].length
  }
  return at
}

/** 文本中第一个句末边界的结束偏移（无边界返回文本长度） */
function firstBoundaryEnd(text: string): number {
  const guarded = protectDots(text)
  BOUNDARY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BOUNDARY_RE.exec(guarded)) !== null) {
    const end = m.index + m[1].length + m[2].length
    if (!isRealBoundary(guarded, end, m[1])) continue
    return end
  }
  return text.length
}

// ── 家具行（页眉/标题/图表题/页码）识别 ──────────────────────────

const SECTION_WORD_RE =
  /^(?:abstract|introduction|related works?|background|preliminar(?:y|ies)|methods?|methodology|approach|experiments?|evaluation|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|appendix|keywords?|appendix)\b/i
const CAPTION_RE = /^(?:figure|fig\.?|table|tab\.?|algorithm|listing|equation|eq\.?)\s*[\dIVXivx]+/i
const NUMBERING_ONLY_RE = /^(?:\(?(?:[IVXivx]{1,5}|[A-Z]|\d{1,2}(?:\.\d{1,2})*)[.)]?)$/

/** 行是否属于"版式家具"：不作为句子成分，且构成硬边界 */
export function isFurnitureLine(text: string): boolean {
  const s = text.trim()
  if (!s) return true
  if (/^\d{1,4}$/.test(s)) return true // 页码
  if (NUMBERING_ONLY_RE.test(s)) return true // "B." / "(iv)" / "3.2"
  if (CAPTION_RE.test(s) && s.length <= 120) return true
  if (SECTION_WORD_RE.test(s) && s.length <= 48) return true
  if (SECTION_WORD_RE.test(s) && /[:：]$/.test(s) && s.length <= 64) return true
  if (s.length <= 72 && !/[.!?。！？:;,]["'”’)\]]?$/.test(s)) {
    const words = s.split(/\s+/).filter(Boolean)
    if (words.length <= 9 && words.every(isTitleWord)) return true
  }
  return false
}

/** 标题词：首字母大写/数字开头，或虚词（for/of/and 等小写连词也属标题） */
function isTitleWord(w: string): boolean {
  return /^[A-Z0-9(“"[(]/.test(w) || STOPWORDS.has(w.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'these', 'those', 'we', 'i', 'it', 'its', 'in', 'on', 'for',
  'to', 'of', 'and', 'or', 'but', 'as', 'at', 'by', 'with', 'from', 'is', 'are', 'was',
  'were', 'be', 'been', 'our', 'their', 'however', 'therefore', 'thus', 'here', 'there',
])

/**
 * 剥离"选区之前"的前缀里的版式残渣：编号头（"B. " / "M1: " / "3.2 "）、
 * 图表题（"Figure 3: "）、章节名（"ABSTRACT "）、纯 Title-Case 尾巴（"Layer Ablation "）。
 * 只处理选区之前的部分——绝不吞掉选区本身或其所在句的实质内容。
 */
function stripLeadingFurniture(prefix: string): string {
  let s = prefix
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(/^\s*(?:\(?(?:[IVXivx]{1,5}|[A-Z]\d{0,2}|\d{1,2}(?:\.\d{1,2})*)[.):])\s*/g, '')
    s = s.replace(/^\s*\d{1,2}(?:\.\d{1,2})+\s+/g, '')
    s = s.replace(/^\s*(?:fig(?:ure)?|tab(?:le)?|algorithm|listing|eq(?:uation)?|section|sec)\.?\s*[A-Z0-9][\w.-]*[.:]?\s*/gi, '')
    s = s.replace(/^\s*(?:abstract|introduction|related work)\s*[—–:.-]\s*/gi, '')
    if (s === before) break
  }
  const words = s.trimEnd().split(/\s+/).filter(Boolean)
  const isTitle = (w: string) =>
    /^[A-Z0-9(“"[(]/.test(w) && !STOPWORDS.has(w.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
  let cut = words.length
  while (cut > 0 && words.length - cut < 6 && isTitle(words[cut - 1])) cut--
  if (cut < words.length) {
    if (cut === 0) return ''
    const rest = words.slice(0, cut).join(' ')
    // 尾段 ≥2 词且剩余部分以标点/编号收尾 → 判定为标题碎片
    if (words.length - cut >= 2 && /[.:;]$/.test(rest)) return ''
  }
  return prefix
}

/** 句子是否为"家具句"（标题/页码/图表题）：不作为 prev/next 返回 */
function isFurnitureSentence(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length <= 8 && /^[A-Z]\.?$/.test(t)) return true
  if (/^\d{1,4}$/.test(t)) return true
  if (CAPTION_RE.test(t) && t.length <= 120) return true
  if (SECTION_WORD_RE.test(t) && t.length <= 48) return true
  if (t.length <= 72 && !/[.!?。！？]$/.test(t)) {
    const words = t.split(/\s+/).filter(Boolean)
    if (words.length <= 9 && words.every(isTitleWord)) return true
  }
  return false
}

function cutTail(s: string, budget: number): string {
  if (s.length <= budget) return s
  const cut = s.slice(s.length - budget)
  const sp = cut.indexOf(' ')
  return sp >= 0 ? cut.slice(sp + 1) : cut
}

function cutHead(s: string, budget: number): string {
  if (s.length <= budget) return s
  const cut = s.slice(0, budget)
  const sp = cut.lastIndexOf(' ')
  return sp > 0 ? cut.slice(0, sp) : cut
}

interface LineInfo { start: number; end: number; text: string; furniture: boolean }

/** 逐行折叠空白拼成单行文本，并记录行区间（坐标回映射用） */
function buildFlat(fullText: string): { flat: string; lines: LineInfo[] } {
  const rawLines = fullText.split(/\r?\n/)
  const lines: LineInfo[] = []
  let flat = ''
  for (const raw of rawLines) {
    const text = raw.replace(/\s+/g, ' ').trim()
    const start = flat.length
    if (text) {
      if (flat) flat += ' '
      flat += text
      lines.push({ start: flat.length - text.length, end: flat.length, text, furniture: isFurnitureLine(text) })
    } else {
      // 空行 = 段落硬边界（位置取当前末尾）
      lines.push({ start, end: flat.length, text: '', furniture: true })
    }
  }
  return { flat, lines }
}

/**
 * 从整页文本 + 选区文本提取「当前句 / 上一句 / 下一句」。
 * 选区与页文本的空白、连字断行、标点差异由 locateKey 归一后吸收。
 */
export function extractSentenceContext(fullText: string, selText: string): {
  sentence: string
  prev: string
  next: string
} {
  const needleRaw = (selText ?? '').replace(/\s+/g, ' ').trim()
  if (!needleRaw) return { sentence: selText, prev: '', next: '' }
  const needleKey = locateKey(needleRaw).key
  if (!needleKey) return { sentence: needleRaw, prev: '', next: '' }

  const { flat, lines } = buildFlat(fullText)
  const located = locateKeyIn(flat, needleKey)
  // 定位失败（页文本缺字/跨页选区）：退回纯选区，绝不编造上下文
  if (!located) return { sentence: needleRaw, prev: '', next: '' }

  const { start, end } = located
  const longSelection = needleKey.length > 120

  // ── 句首：上一个句末边界之后；再被最近一个家具行夹紧 ──
  let sentStart = lastBoundaryEnd(flat.slice(0, start))
  for (const ln of lines) {
    if (ln.furniture && ln.end <= start && ln.end + 1 > sentStart) sentStart = Math.min(ln.end + 1, start)
  }
  // ── 句尾：第一个句末边界；遇家具行截断 ──
  let sentEnd = end + firstBoundaryEnd(flat.slice(end))
  for (const ln of lines) {
    if (ln.furniture && ln.start >= end && ln.start < sentEnd) sentEnd = ln.start
  }
  sentStart = Math.max(0, Math.min(sentStart, start))
  sentEnd = Math.max(end, Math.min(sentEnd, flat.length))

  let sentence = flat.slice(sentStart, sentEnd).replace(/\s+/g, ' ').trim()
  if (!longSelection) {
    // 剥离句首版式残渣：以选区在句内的相对位置为界，只清理前缀
    const inSentence = locateKeyIn(sentence, needleKey)
    if (inSentence && inSentence.start > 0) {
      const cleaned = stripLeadingFurniture(sentence.slice(0, inSentence.start))
      sentence = `${cleaned}${sentence.slice(inSentence.start)}`.replace(/\s+/g, ' ').trim()
    }
  } else {
    // 长选区：当前句就是选区本身（去掉句首残渣），不向前后延伸
    sentence = flat.slice(start, end).replace(/\s+/g, ' ').trim()
  }
  if (!sentence) sentence = needleRaw
  // 句子长度兜底：围绕选区截断，避免把整段灌进 prompt
  if (sentence.length > MAX_CONTEXT_CHARS) {
    const at = Math.max(0, sentence.toLowerCase().indexOf(needleRaw.slice(0, 24).toLowerCase()))
    const from = Math.max(0, at - Math.floor(MAX_CONTEXT_CHARS * 0.4))
    sentence = `${at > 0 ? '…' : ''}${cutHead(sentence.slice(from), MAX_CONTEXT_CHARS)}`
  }

  // ── 上一句：句首之前的最后一个实质句（未收尾的残句不返回） ──
  const before = flat.slice(0, Math.max(0, sentStart))
  const beforeParts = splitSentences(before)
  let prev = ''
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const p = beforeParts[i].trim()
    if (isFurnitureSentence(p)) continue
    if (!/[.!?。！？]["'”’)\]]?$/.test(p)) break
    prev = p
    break
  }

  // ── 下一句：句尾之后的第一个实质句（允许残句，作上下文） ──
  const after = flat.slice(Math.max(0, sentEnd))
  const afterParts = splitSentences(after)
  let next = ''
  for (const p of afterParts) {
    if (isFurnitureSentence(p)) continue
    next = p.trim()
    break
  }

  return {
    sentence,
    prev: prev.length > MAX_SENTENCE_CHARS ? cutTail(prev, MAX_SENTENCE_CHARS) : prev,
    next: next.length > MAX_SENTENCE_CHARS ? cutHead(next, MAX_SENTENCE_CHARS) : next,
  }
}
