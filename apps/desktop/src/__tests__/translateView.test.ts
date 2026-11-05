import { describe, expect, it } from 'vitest'
import {
  chunkForTranslation,
  isSentenceSelection,
  parseWordSections,
  pickTranslation,
} from '../features/reader/translateView'

describe('parseWordSections', () => {
  it('解析标准三分区', () => {
    const s = parseWordSections('【词性】n.\n【基本义】注意力；关注\n【文中意】注意力机制')
    expect(s.parsed).toBe(true)
    expect(s.pos).toBe('n.')
    expect(s.gloss).toBe('注意力；关注')
    expect(s.context).toBe('注意力机制')
  })

  it('别名归一到三分区', () => {
    const s = parseWordSections('【词类】v.\n【释义】扩展\n【本文译法】可扩展到')
    expect(s.pos).toBe('v.')
    expect(s.gloss).toBe('扩展')
    expect(s.context).toBe('可扩展到')
  })

  it('流式中途未闭合标记不污染上一个分区', () => {
    const s = parseWordSections('【词性】n.\n【基本义】注意力\n【文中')
    expect(s.pos).toBe('n.')
    expect(s.gloss).toBe('注意力')
    expect(s.context).toBe('注意力') // 兜底用基本义首项
  })

  it('缺少文中意时用基本义首项兜底', () => {
    const s = parseWordSections('【基本义】梯度；斜率')
    expect(s.context).toBe('梯度')
  })

  it('无分区标记 → 未解析，交由原样渲染', () => {
    const s = parseWordSections('注意力机制')
    expect(s.parsed).toBe(false)
    expect(s.context).toBe('')
  })

  it('未知分区归入 extra', () => {
    const s = parseWordSections('【词性】n.\n【基本义】注意\n【文中意】注意力\n【领域词】是')
    expect(s.extra).toEqual(['领域词：是'])
  })

  it('去 Markdown 装饰与行首项目符号', () => {
    const s = parseWordSections('**词性：** n.\n- 【基本义】注意\n## 【文中意】注意力')
    expect(s.pos).toBe('n.')
    expect(s.gloss).toBe('注意')
    expect(s.context).toBe('注意力')
  })
})

describe('pickTranslation', () => {
  it('优先文中意', () => {
    expect(pickTranslation('【基本义】注意\n【文中意】注意力机制')).toBe('注意力机制')
  })
  it('无文中意取基本义首项', () => {
    expect(pickTranslation('【基本义】梯度；斜率')).toBe('梯度')
  })
  it('无分区时用兜底值', () => {
    expect(pickTranslation('噪声文本', '词典义')).toBe('词典义')
  })
})

describe('isSentenceSelection', () => {
  it('单词/短语走词卡', () => {
    expect(isSentenceSelection('attention')).toBe(false)
    expect(isSentenceSelection('attention mechanism')).toBe(false)
  })
  it('四词以上或长文本走整句', () => {
    expect(isSentenceSelection('we propose a novel mechanism')).toBe(true)
    expect(isSentenceSelection('a'.repeat(60))).toBe(true)
  })
  it('空选区不为整句', () => {
    expect(isSentenceSelection('   ')).toBe(false)
  })
})

describe('chunkForTranslation', () => {
  it('短文本原样返回', () => {
    expect(chunkForTranslation('Hello world.')).toEqual(['Hello world.'])
  })
  it('长文本按句切段且不超上限', () => {
    const s = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} reports the exact match rate.`).join(' ')
    const chunks = chunkForTranslation(s, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('Sentence number 39')
  })
  it('单句超长退化为按词切', () => {
    const s = 'word '.repeat(200).trim()
    const chunks = chunkForTranslation(s, 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 100)).toBe(true)
  })
  it('空文本返回空数组', () => {
    expect(chunkForTranslation('  ')).toEqual([])
  })
})
