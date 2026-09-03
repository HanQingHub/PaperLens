export interface EditOp {
  start: number
  end: number
  text: string
  newStart: number
  newEnd: number
}

export function toggleWrap(text: string, start: number, end: number, marker: string): EditOp | null {
  if (start > end || start < 0 || end > text.length) return null
  const m = marker.length
  if (
    start - m >= 0 &&
    text.slice(start - m, start) === marker &&
    text.slice(end, end + m) === marker
  ) {
    return {
      start: start - m,
      end: end + m,
      text: text.slice(start, end),
      newStart: start - m,
      newEnd: end - m,
    }
  }
  const inner = text.slice(start, end)
  if (inner.length >= m * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const body = inner.slice(m, inner.length - m)
    return { start, end, text: body, newStart: start, newEnd: start + body.length }
  }
  return {
    start,
    end,
    text: marker + inner + marker,
    newStart: start + m,
    newEnd: start + m + inner.length,
  }
}

export function insertLink(text: string, start: number, end: number): EditOp {
  const inner = text.slice(start, end)
  if (inner) {
    const urlPos = start + 1 + inner.length + 2
    return { start, end, text: `[${inner}]()`, newStart: urlPos, newEnd: urlPos }
  }
  const labelPos = start + 1
  return { start, end, text: '[]()', newStart: labelPos, newEnd: labelPos }
}

/**
 * 行前缀切换（无序列表 `- ` / 引用 `> ` 共用）。
 * 规则：锚定 setHeading 的行范围口径（含文末幻影空行语义）；空行恒跳过；
 * 覆盖的非空行全有前缀 → 逐行去前缀，否则非空行全加前缀；
 * 有效行零行（全空/越界）→ null（禁 undo 污染）。
 * 光标映射逐行独立（加/去符号相反，不可复用 setHeading 的同 delta 模型）：
 * 锚点在行内偏移 off>0 则加该行 lineDelta，行首则不加。
 */
export function toggleLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: '- ' | '> ',
): EditOp | null {
  if (start > end || start < 0 || end > text.length) return null
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const excludeEndLine = end > start && end > 0 && text[end - 1] === '\n'
  const lastLineStart = excludeEndLine
    ? text.lastIndexOf('\n', end - 2) + 1
    : text.lastIndexOf('\n', end - 1) + 1
  if (lastLineStart < lineStart) return null
  const nl = text.indexOf('\n', lastLineStart)
  const blockEnd = nl === -1 ? text.length : nl

  const rawBlock = text.slice(lineStart, blockEnd)
  const rawLines = rawBlock.split('\n')
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length === 0) return null
  const allHave = nonEmpty.every((l) => l.startsWith(prefix))

  const outLines: string[] = []
  let newStart = -1
  let newEnd = -1
  let cursor = 0 // rawBlock 内偏移
  let pos = 0 // 新文本内偏移（相对 lineStart）
  for (const line of rawLines) {
    const lineStartInBlock = cursor
    cursor += line.length + 1
    let newLine: string
    let lineDelta: number
    if (line.trim().length === 0) {
      newLine = line
      lineDelta = 0
    } else if (allHave) {
      newLine = line.slice(prefix.length)
      lineDelta = -prefix.length
    } else if (line.startsWith(prefix)) {
      // 混合态加前缀：已有行跳过（免 `- - a` 双前缀），缺的行补齐即达统一
      newLine = line
      lineDelta = 0
    } else {
      newLine = prefix + line
      lineDelta = prefix.length
    }
    for (const [p, isStart] of [
      [start, true],
      [end, false],
    ] as const) {
      const off = p - lineStart - lineStartInBlock
      if (off >= 0 && off <= line.length) {
        const mapped = pos + off + (off > 0 ? lineDelta : 0)
        if (isStart) newStart = mapped
        else newEnd = mapped
      }
    }
    outLines.push(newLine)
    pos += newLine.length + 1
  }

  return {
    start: lineStart,
    end: blockEnd,
    text: outLines.join('\n'),
    newStart: newStart === -1 ? start : lineStart + newStart,
    newEnd: newEnd === -1 ? end : lineStart + newEnd,
  }
}

/**
 * 围栏代码块切换：选中块首尾行被 ``` 包裹 → 解包；
 * 否则用 ``` 包围选中行；无选区（start===end）→ 插入 ```\n\n```，光标居中空行。
 */
export function toggleFence(text: string, start: number, end: number): EditOp | null {
  if (start > end || start < 0 || end > text.length) return null
  if (start === end) {
    const ins = '```\n\n```'
    return { start, end, text: ins, newStart: start + 4, newEnd: start + 4 }
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const excludeEndLine = end > 0 && text[end - 1] === '\n'
  const lastLineStart = excludeEndLine ? text.lastIndexOf('\n', end - 2) + 1 : text.lastIndexOf('\n', end - 1) + 1
  if (lastLineStart < lineStart) return null
  const nl = text.indexOf('\n', lastLineStart)
  const blockEnd = nl === -1 ? text.length : nl
  const block = text.slice(lineStart, blockEnd)
  const lines = block.split('\n')
  const first = lines[0].trim()
  const last = lines[lines.length - 1].trim()
  if (lines.length >= 2 && first.startsWith('```') && last.startsWith('```')) {
    // 解包：去首尾围栏行
    const body = lines.slice(1, -1).join('\n')
    return { start: lineStart, end: blockEnd, text: body, newStart: lineStart, newEnd: lineStart + body.length }
  }
  const fenced = '```\n' + block + '\n```'
  return { start: lineStart, end: blockEnd, text: fenced, newStart: lineStart + 4, newEnd: lineStart + 4 + block.length }
}

const TABLE_TEMPLATE = '|  |  |\n|---|---|\n|  |  |'

/**
 * 表格模板插入：删选区后在光标处插入三行模板，光标落首个空单元格（首行 `| ` 之后）。
 */
export function insertTable(_text: string, start: number, end: number): EditOp {
  return { start, end, text: TABLE_TEMPLATE, newStart: start + 2, newEnd: start + 2 }
}

export function setHeading(
  text: string,
  start: number,
  end: number,
  level: 1 | 2 | 3 | 4 | 5 | 6,
): EditOp | null {
  if (start > end || start < 0 || end > text.length) return null
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const excludeEndLine = end > start && end > 0 && text[end - 1] === '\n'
  const lastLineStart = excludeEndLine
    ? text.lastIndexOf('\n', end - 2) + 1
    : text.lastIndexOf('\n', end - 1) + 1
  if (lastLineStart < lineStart) return null
  const nl = text.indexOf('\n', lastLineStart)
  const blockEnd = nl === -1 ? text.length : nl

  const rawBlock = text.slice(lineStart, blockEnd)
  const rawLines = rawBlock.split('\n')
  const prefix = '#'.repeat(level) + ' '
  const headingRe = /^(#{1,6})(?:\s+|$)/

  const outLines: string[] = []
  let pos = 0
  let deltaAcc = 0
  let newStart = -1
  let newEnd = -1
  let cursor = 0
  for (const line of rawLines) {
    const lineStartInBlock = cursor
    cursor += line.length + 1
    const hm = headingRe.exec(line)
    const prevLevel = hm ? hm[1].length : 0
    const stripped = hm ? line.slice(hm[0].length) : line
    const newLine = prevLevel === level ? stripped : prefix + stripped
    const lineDelta = newLine.length - line.length
    for (const [p, isStart] of [
      [start, true],
      [end, false],
    ] as const) {
      const off = p - lineStart - lineStartInBlock
      if (off >= 0 && off < line.length + 1) {
        const mapped = pos + off + (off > 0 ? lineDelta : 0)
        if (isStart) newStart = mapped
        else newEnd = mapped
      }
    }
    outLines.push(newLine)
    pos += newLine.length + 1
    deltaAcc += lineDelta
  }

  return {
    start: lineStart,
    end: blockEnd,
    text: outLines.join('\n'),
    newStart: newStart === -1 ? start + deltaAcc : lineStart + newStart,
    newEnd: newEnd === -1 ? end + deltaAcc : lineStart + newEnd,
  }
}
