// 翻译卡片展示层纯函数：LLM 三分区解析、长选区切段、译法抽取。
// 与后端 normalize_word_output 的分区名对齐（词性/基本义/文中意）。
import { splitSentences } from './sentence'

export interface WordSections {
  pos: string
  gloss: string
  context: string
  /** 未归类的残余文本（模型自由发挥的分区） */
  extra: string[]
  /** 是否解析到了至少一个分区 */
  parsed: boolean
}

const LABELS: Record<string, keyof Pick<WordSections, 'pos' | 'gloss' | 'context'>> = {
  词性: 'pos',
  词类: 'pos',
  基本义: 'gloss',
  基本含义: 'gloss',
  释义: 'gloss',
  词义: 'gloss',
  文中意: 'context',
  本文译法: 'context',
  文中译法: 'context',
  语境义: 'context',
}

/** 选区语义裁决：≥4 词或 >48 字符按整句处理（工具条/快捷键/卡片共用同一口径） */
export function isSentenceSelection(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const words = t.split(/\s+/).filter(Boolean)
  return words.length >= 4 || t.length > 48
}

/** 解析流式/终态的词卡文本；分区标记可能被 delta 切断，未闭合标记按未解析处理 */
export function parseWordSections(text: string): WordSections {
  const out: WordSections = { pos: '', gloss: '', context: '', extra: [], parsed: false }
  if (!text) return out
  const clean = text
    .replace(/\*\*/g, '')
    .replace(/##/g, '')
    // 行首 "词性：" / "基本义:" 无括号变体 → 补成 【词性】，再走统一解析
    .replace(/^[ \t]*([^\s:：【】]{1,8})[ \t]*[:：][ \t]*/gm, (m, label: string) =>
      LABELS[label] ? `【${label}】` : m,
    )
  const re = /【\s*([^】\n]{1,8})\s*】/g
  const marks: { label: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    marks.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length })
  }
  if (!marks.length) return out
  // 首个分区标记之前的文本：模型开场白，丢弃（但保留纯文本结果由调用方兜底）
  for (let i = 0; i < marks.length; i++) {
    let body = clean
      .slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : clean.length)
      .trim()
      .replace(/^[:：]\s*/, '')
    // 流式中途：末段可能带未闭合的分区标记（"【文中"），先剥掉再展示
    body = body.replace(/【[^】]*$/, '').trim()
    if (!body) continue
    const key = LABELS[marks[i].label]
    if (!key) {
      out.extra.push(`${marks[i].label}：${body}`)
      continue
    }
    if (!out[key]) {
      out[key] = body.split('\n')[0].trim()
      out.parsed = true
      // 同分区换行续写（基本义多义项）并入
      const rest = body.split('\n').slice(1).join(' ').trim()
      if (rest && key === 'gloss') out.gloss += ` ${rest}`
    }
  }
  // 文中意缺失时用基本义首项兜底，保证卡片始终有一句可用的译法
  if (!out.context && out.gloss) out.context = out.gloss.split(/[；;]/)[0].trim()
  if (out.context) out.parsed = true
  return out
}

/** 入生词库/收藏用的译法：优先文中意，其次基本义首项 */
export function pickTranslation(text: string, fallback = ''): string {
  const s = parseWordSections(text)
  const v = s.context || s.gloss.split(/[；;]/)[0] || ''
  const out = v.trim().slice(0, 80)
  return out || fallback
}

/**
 * 长选区切段：按句边界切成 ≤ max 字符的段（单句超长时退化为按词切）。
 * 服务端单次句译有 token 预算，整段超限会直接报 text_too_long；
 * 前端先切再逐段流式翻译，用户看到的是连续产出而不是一次报错。
 */
export function chunkForTranslation(text: string, max = 900): string[] {
  const src = text.trim()
  if (!src) return []
  if (src.length <= max) return [src]
  const sentences = splitSentences(src)
  const parts = sentences.length ? sentences : [src]
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const s of parts) {
    if (s.length > max) {
      push()
      // 单句超长：按词切
      let buf = ''
      for (const w of s.split(/\s+/)) {
        if (buf && buf.length + w.length + 1 > max) {
          out.push(buf)
          buf = w
        } else {
          buf = buf ? `${buf} ${w}` : w
        }
      }
      if (buf) out.push(buf)
      continue
    }
    if (cur && cur.length + s.length + 1 > max) push()
    cur = cur ? `${cur} ${s}` : s
  }
  push()
  return out.length ? out : [src]
}
