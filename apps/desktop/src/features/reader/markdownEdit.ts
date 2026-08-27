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
