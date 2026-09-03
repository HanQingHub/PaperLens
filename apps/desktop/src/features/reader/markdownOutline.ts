// MD 大纲解析纯函数（与 store/渲染解耦，便于 node 环境单测）。
// 仅支持 ATX 标题（`#{1,6} + 空格 + 文本`）；setext（`===`/`---`）不支持（范围外，见落地计划 §二）。
// 围栏代码块（``` / ~~~，含 0-3 空格缩进）内行跳过；4 空格缩进代码块不感知（已知缺口）。

export interface MdHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6
  title: string
  /** 0-based 行号 */
  line: number
}

const FENCE_RE = /^(?: {0,3})(`{3,}|~{3,})/
// 引用标记与 0-3 空格缩进剥离后匹配（remark 侧二者均渲染为 h1-h6，需对齐 DOM 顺序）
const HEADING_RE = /^(?: {0,3})(?:>\s?)*(#{1,6})\s+(.*?)\s*#*\s*$/

/** 解析源码标题列表（文档序；空标题丢弃；行尾 `#` 修饰剥离） */
export function parseMdHeadings(src: string): MdHeading[] {
  const out: MdHeading[] = []
  const lines = src.split('\n')
  let fenceChar: '`' | '~' | null = null
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const mark = fence[1]
      const ch = mark[0] as '`' | '~'
      if (fenceChar == null) {
        fenceChar = ch
        fenceLen = mark.length
      } else if (ch === fenceChar && mark.length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }
    if (fenceChar != null) continue
    const m = HEADING_RE.exec(line)
    if (!m) continue
    const title = m[2].trim()
    if (!title) continue
    out.push({ level: m[1].length as MdHeading['level'], title, line: i })
  }
  return out
}
