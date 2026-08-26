// 句读纯函数（无 DOM/pdfjs 依赖，便于 vitest 直测）
const SENT_BOUNDARY = /[^.?!]*[.?!]+["')\]]?\s*/g
const ABBREV_RE = /\b(?:e\.g|i\.e|et al|Fig|Eq|Sec|Tab|Ref|etc|vs|No|Mr|Mrs|Dr|St|Prof|cf|pp|vol)\./gi
const MAX_SENTENCE_CHARS = 400

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

export function splitSentences(text: string): string[] {
  const guarded = text.replace(ABBREV_RE, (m) => m.replace(/\./g, '\uE000'))
  const out: string[] = []
  SENT_BOUNDARY.lastIndex = 0
  let m: RegExpExecArray | null
  let consumed = 0
  while ((m = SENT_BOUNDARY.exec(guarded)) !== null) {
    const s = m[0].trim()
    if (s) out.push(...chunkLong(s))
    consumed = m.index + m[0].length
  }
  const rest = guarded.slice(consumed).trim()
  if (rest) out.push(...chunkLong(rest))
  return out.map((s) => s.replace(/\uE000/g, '.'))
}

function isHeading(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (/^(?:\(?(?:[IVXivx]{1,5}|[A-Z]\d{0,2}|\d{1,2}(?:\.\d{1,2})*)[.):]\s*)/.test(s)) return true
  if (s.endsWith(':')) return true
  if (/^(Abstract|Introduction|Conclusion|References|Acknowledgments|Background|Method|Results|Discussion)$/i.test(s)) return true
  return false
}

function isSentEnd(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (s.endsWith(':')) return false
  return /[.!?]["')\]]?$/.test(s)
}

function isWholeSentence(s: string): boolean {
  return /[.!?]["')\]]?\s*$/.test(s.trim())
}

function stripLeadingHeading(prefix: string): string {
  let s = prefix.trimStart()
  // 编号头（如 "B. "、"M1: "、"3.2 "）
  const m1 = s.match(/^(?:\(?(?:[IVXivx]{1,5}|[A-Z]\d{0,2}|\d{1,2}(?:\.\d{1,2})*)[.) :]\s*)+/)
  if (m1) {
    s = s.slice(m1[0].length)
    // 剥后若整段 Title-Case（每词首字母大写且 ≤64 字符）视为节标题尾巴
    const words = s.split(/\s+/).filter(Boolean)
    if (s && words.length > 0 && words.length <= 8 && s.length <= 64 && words.every((w) => /^[A-Z0-9]/.test(w))) {
      return ''
    }
    return s
  }
  // 纯 Title-Case 段（无编号头）
  const words = s.split(/\s+/).filter(Boolean)
  if (s && words.length > 0 && words.length <= 8 && s.length <= 64 && words.every((w) => /^[A-Z0-9]/.test(w))) {
    return ''
  }
  return s
}

export function extractSentenceContext(fullText: string, selText: string): {
  sentence: string
  prev: string
  next: string
} {
  const needle = selText.replace(/\s+/g, ' ').trim()
  if (!needle) return { sentence: selText, prev: '', next: '' }

  const lines = fullText.split('\n')

  // 规范化定位：每行折叠空白后拼接（行间单空格），记录规范化偏移→原始行索引的
  // 精确映射。needle 做同样规范化后 indexOf——长度保真，不再有折叠近似误差。
  const normLines: { text: string; rawIdx: number; start: number }[] = []
  let acc = 0
  for (let i = 0; i < lines.length; i++) {
    const norm = lines[i].replace(/\s+/g, ' ').trim()
    if (!norm) continue
    normLines.push({ text: norm, rawIdx: i, start: acc })
    acc += norm.length + 1
  }
  const flatNorm = normLines.map((l) => l.text).join(' ')
  const idx = flatNorm.indexOf(needle)
  if (idx < 0) return { sentence: needle, prev: '', next: '' }

  // idx 所在行（normLines 有序，线性扫描即可）
  let lineIdx = normLines.length - 1
  for (let i = 0; i < normLines.length; i++) {
    const end = normLines[i].start + normLines[i].text.length
    if (idx < end) {
      lineIdx = i
      break
    }
  }
  const rawIdx = normLines[lineIdx].rawIdx

  // 向上收集（目标：得到以上一句句号结尾的 before-clean）
  const collectUp: string[] = []
  let needlePrefix = ''
  {
    const lineText = lines[rawIdx] ?? ''
    // needle 在本行规范化文本内的起点 → 映射回原始行的字符位置（比例近似仅影响
    // 前缀截断点，上下文语义由行级收集保证）
    const normStartInLine = Math.max(0, idx - normLines[lineIdx].start)
    const normLineText = normLines[lineIdx].text
    // 原始行前缀：按规范化长度比例回映射（原始行与规范化行长度差只来自空白）
    const ratio = normLineText.length > 0 ? lineText.length / normLineText.length : 0
    const rawCut = Math.min(lineText.length, Math.round(normStartInLine * ratio))
    needlePrefix = stripLeadingHeading(lineText.slice(0, rawCut)).trim()
    if (needlePrefix) collectUp.unshift(needlePrefix)

    for (let i = rawIdx - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (!t) break
      if (isHeading(t)) {
        if (/^(Abstract|Introduction|Conclusion|References|Acknowledgments|Background|Method|Results|Discussion)$/i.test(t)) break
        continue
      }
      collectUp.unshift(lines[i])
      if (isSentEnd(t)) break
    }
  }

  // 向上收集为空（选区在文档最前/前面全是标题）→ 用纯 needle 流程
  if (collectUp.length === 0) {
    const before = flatNorm.slice(0, idx)
    const after = flatNorm.slice(idx + needle.length)
    const prevSentences = splitSentences(before)
    const nextSentences = splitSentences(after)
    let startFrag = prevSentences.length ? prevSentences[prevSentences.length - 1] : ''
    startFrag = stripLeadingHeading(startFrag)
    if (startFrag.length > 240) {
      const cut = startFrag.slice(-240)
      const sp = cut.indexOf(' ')
      startFrag = sp >= 0 ? cut.slice(sp + 1) : cut
    }
    const endFrag = isWholeSentence(needle) ? '' : (nextSentences.length ? nextSentences[0] : '')
    const next = isWholeSentence(needle)
      ? (nextSentences.length ? nextSentences[0] : '')
      : (nextSentences.length > 1 ? nextSentences[1] : '')
    const sentence = isWholeSentence(needle) ? needle : `${startFrag} ${needle} ${endFrag}`.replace(/\s+/g, ' ').trim() || needle
    return { sentence, prev: prevSentences.length > 1 ? prevSentences[prevSentences.length - 2] : '', next }
  }

  // 正常行感知分支：beforeClean 的末句是上一句
  const beforeClean = collectUp.join(' ').replace(/\s+/g, ' ').trim()
  const beforeParts = splitSentences(beforeClean)
  const prev = beforeParts.length ? beforeParts[beforeParts.length - 1] : ''
  const startFrag = needlePrefix && !beforeClean.endsWith(needlePrefix) ? '' : needlePrefix

  // 向下收集（至第二个句末）
  const normStartInLine = Math.max(0, idx - normLines[lineIdx].start)
  const normLineText = normLines[lineIdx].text
  const restNorm = normLineText.slice(normStartInLine + needle.length)
  const afterCollect: string[] = []
  if (restNorm.trim()) afterCollect.push(restNorm)
  const seenEnd = isSentEnd(restNorm)
  let endCount = seenEnd ? 1 : 0
  for (let i = rawIdx + 1; i < lines.length && endCount < 2; i++) {
    const t = lines[i].trim()
    if (!t) break
    if (isHeading(t)) continue
    afterCollect.push(lines[i])
    if (isSentEnd(t)) endCount++
  }
  const afterClean = afterCollect.join(' ').replace(/\s+/g, ' ').trim()
  const afterParts = splitSentences(afterClean)
  const endFrag = isWholeSentence(needle) ? '' : (afterParts.length ? afterParts[0] : '')
  const next = isWholeSentence(needle) ? (afterParts.length ? afterParts[0] : '') : (afterParts.length > 1 ? afterParts[1] : '')
  const sentence = isWholeSentence(needle) ? needle : `${needle} ${endFrag}`.replace(/\s+/g, ' ').trim() || needle

  let sFrag = startFrag
  if (sFrag.length > 240) {
    const cut = sFrag.slice(-240)
    const sp = cut.indexOf(' ')
    sFrag = sp >= 0 ? cut.slice(sp + 1) : cut
  }

  const finalSentence = sFrag && !needle.startsWith(sFrag.slice(0, 10)) ? `${sFrag} ${needle} ${endFrag}`.replace(/\s+/g, ' ').trim() : sentence

  return { sentence: finalSentence, prev, next }
}
