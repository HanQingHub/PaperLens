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

  const flat = fullText.replace(/\s+/g, ' ')
  const idx = flat.indexOf(needle)
  if (idx < 0) return { sentence: selText, prev: '', next: '' }

  // 行感知：用原始换行切分，建 char→line 映射
  const lines = fullText.split('\n')
  let acc = 0
  const lineOff: number[] = []
  for (const ln of lines) {
    lineOff.push(acc)
    acc += ln.length + 1 // +1 for '\n'
  }
  // flat 的换行已被折为空格，映射需用折叠后长度近似；简化：用 lines 拼成 flatLines 再 indexOf
  const flatLines = lines.map((ln) => ln.replace(/\s+/g, ' ').trim()).filter(Boolean)
  // 备用：若 flatLines 方法找不到，回退旧逻辑
  const needleLineIdx = (() => {
    let _p = 0
    for (let i = 0; i < lines.length; i++) {
      const norm = lines[i].replace(/\s+/g, ' ').trim()
      if (!norm) { _p += 1; continue }
      if (norm.includes(needle.split(' ')[0] ?? '')) {
        // 粗略：首词命中即认为该行包含 needle
        const lineFlat = flatLines.join(' ')
        const li = lineFlat.indexOf(needle)
        if (li >= 0) {
          // 估算行号：累加 flatLines 长度
          let s = 0
          for (let j = 0; j < flatLines.length; j++) {
            if (s <= li && li < s + flatLines[j].length) return j
            s += flatLines[j].length + 1
          }
        }
      }
      _p += norm.length + 1
    }
    // 回退：用 char 映射近似
    let cur = 0
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (idx >= cur && idx < cur + ln.length + 1) return i
      cur += ln.length + 1
    }
    return -1
  })()

  // 向上收集（目标：得到以上一句句号结尾的 before-clean）
  const collectUp: string[] = []
  let needlePrefix = ''
  if (needleLineIdx >= 0) {
    const lineText = lines[needleLineIdx] ?? ''
    const firstWord = needle.split(' ')[0] ?? ''
    const col = firstWord ? lineText.indexOf(firstWord) : -1
    const prefixInLine = col >= 0 ? lineText.slice(0, col) : ''
    needlePrefix = stripLeadingHeading(prefixInLine).trim()
    if (needlePrefix) collectUp.unshift(needlePrefix)

    for (let i = needleLineIdx - 1; i >= 0; i--) {
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

  let beforeClean: string
  if (collectUp.length > 0) {
    beforeClean = collectUp.join(' ').replace(/\s+/g, ' ').trim()
    // 若 needlePrefix 非空且 beforeClean 以它结尾，则它是当前句前缀，否则它是上一句
    if (needlePrefix && beforeClean.endsWith(needlePrefix)) {
      // beforeClean 包含当前句前缀，需拆分（保留整体让后续 split 自然处理）
    }
  } else {
    // 回退旧逻辑的 before
    const before = flat.slice(0, idx)
    const prevSentences = splitSentences(before)
    let startFrag = prevSentences.length ? prevSentences[prevSentences.length - 1] : ''
    // 同行标题剥离
    startFrag = stripLeadingHeading(startFrag)
    if (prevSentences.length === 1 && before.length > 300 && startFrag.length > 200) startFrag = ''
    else if (startFrag.length > 240) {
      const cut = startFrag.slice(-240)
      const sp = cut.indexOf(' ')
      startFrag = sp >= 0 ? cut.slice(sp + 1) : cut
    }
    beforeClean = startFrag ? startFrag + ' ' + needle : needle
    // 简化：直接用 startFrag 逻辑的 beforeClean 近似
    // 为避免与新逻辑分支混淆，这里直接按新收集结果处理：若无收集则用 startFrag
    const parts = splitSentences(beforeClean)
    const startFrag2 = parts.length ? parts[parts.length - 1] : ''
    const prev2 = parts.length > 1 ? parts[parts.length - 2] : ''
    // 向下仍用旧逻辑的 after
    const after = flat.slice(idx + needle.length)
    const nextSentences = splitSentences(after)
    const endFrag = isWholeSentence(needle) ? '' : (nextSentences.length ? nextSentences[0] : '')
    const next2 = isWholeSentence(needle) ? (nextSentences.length ? nextSentences[0] : '') : (nextSentences.length > 1 ? nextSentences[1] : '')
    const sentence2 = `${startFrag2}`.replace(/\s+/g, ' ').trim() || needle
    // 合并 endFrag（整句时不再粘下一句）
    const fullSent = isWholeSentence(needle) ? sentence2 : `${sentence2} ${endFrag}`.replace(/\s+/g, ' ').trim()
    return { sentence: fullSent || needle, prev: prev2, next: next2 }
  }

  // 正常行感知分支：beforeClean 是上一句，needlePrefix 是当前句前缀
  const beforeParts = splitSentences(beforeClean)
  const prev = beforeParts.length ? beforeParts[beforeParts.length - 1] : ''
  const startFrag = needlePrefix

  // 向下收集（至第二个句末）
  const needleLine = needleLineIdx >= 0 ? lines[needleLineIdx] : ''
  const colEnd = needleLineIdx >= 0 ? needleLine.indexOf(needle) + needle.length : -1
  const restInLine = colEnd >= 0 ? needleLine.slice(colEnd) : ''
  const afterCollect: string[] = []
  if (restInLine.trim()) afterCollect.push(restInLine)
  const seenEnd = isSentEnd(restInLine)
  let endCount = seenEnd ? 1 : 0
  for (let i = (needleLineIdx >= 0 ? needleLineIdx + 1 : 0); i < lines.length && endCount < 2; i++) {
    const t = lines[i].trim()
    if (!t) break
    if (isHeading(t)) continue
    afterCollect.push(lines[i])
    if (isSentEnd(t)) endCount++
  }
  const afterClean2 = afterCollect.join(' ').replace(/\s+/g, ' ').trim()
  const afterParts = splitSentences(afterClean2)
  const endFrag = isWholeSentence(needle) ? '' : (afterParts.length ? afterParts[0] : '')
  const next = isWholeSentence(needle) ? (afterParts.length ? afterParts[0] : '') : (afterParts.length > 1 ? afterParts[1] : '')
  const sentence = isWholeSentence(needle) ? needle : `${needle} ${endFrag}`.replace(/\s+/g, ' ').trim() || needle

  // 兜底
  let sFrag = startFrag
  if (sFrag.length > 240) {
    const cut = sFrag.slice(-240)
    const sp = cut.indexOf(' ')
    sFrag = sp >= 0 ? cut.slice(sp + 1) : cut
  }

  // 若 startFrag 非空且 needle 不以它结尾，说明 startFrag 是上一句前缀的片段而非当前句前缀；此时 sentence 前应补上 sFrag
  // 但按收集逻辑，sFrag 已是当前句前缀（来自 needle 行前缀或上一行折行），应拼入
  const finalSentence = sFrag && !needle.startsWith(sFrag.slice(0, 10)) ? `${sFrag} ${needle} ${endFrag}`.replace(/\s+/g, ' ').trim() : sentence

  return { sentence: finalSentence, prev, next }
}
