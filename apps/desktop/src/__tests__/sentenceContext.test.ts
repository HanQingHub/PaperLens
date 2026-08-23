import { describe, it, expect } from 'vitest'
import { extractSentenceContext, splitSentences } from '../features/reader/sentence'

describe('extractSentenceContext', () => {
  it('section heading glued: B. M1: Layer Ablation', () => {
    const fullText = [
      'M0-M6 gating pipeline.',
      'B.',
      'M1: Layer Ablation Four groups share r=8, α=16, lr= 10-4, epochs= 3 on 171 unique problems.',
      'We compare full-module joint fine-tuning.',
    ].join('\n')
    const { sentence, prev } = extractSentenceContext(fullText, 'Four groups')
    expect(sentence).not.toContain('M1:')
    expect(sentence).not.toContain('B.')
    expect(sentence).toContain('Four groups share')
    expect(prev).toContain('M0-M6 gating pipeline')
  })

  it('page top title/author/abstract header not glued', () => {
    const fullText = [
      'A Programming Paradigm for Spatiotemporal Composability',
      'Yifan Shi1,2, Wei Zhang1',
      'Abstract',
      'Modern software—from plugin systems to self-evolving agent harnesses—increasingly requires dynamic composition, yet its formal foundations remain underdeveloped.',
      'We identify two orthogonal dimensions.',
    ].join('\n')
    const { sentence, prev } = extractSentenceContext(fullText, 'plugin')
    expect(sentence).toContain('plugin')
    expect(sentence).not.toContain('Abstract')
    expect(sentence).not.toContain('Yifan Shi')
    // prev 可能为标题行或空，关键是 sentence 干净
    expect(prev === '' || prev.includes('Abstract') === false).toBeTruthy()
  })

  it('wrapped paragraph across lines preserved', () => {
    const fullText = 'Modern software—from plugin systems to self-evolving agent harnesses—increasingly requires dynamic composition, yet its formal foundations remain underdeveloped.\nWe identify two orthogonal dimensions of the problem.'
    const { sentence, next } = extractSentenceContext(fullText, 'composition')
    expect(sentence).toContain('Modern software')
    expect(sentence).toContain('composition')
    expect(next).toContain('We identify two orthogonal')
  })

  it('abbreviation not split', () => {
    const fullText = 'We report 64.2% on GSM8K [1], e.g. Test shows the model is strong. Next sentence here.'
    const { sentence } = extractSentenceContext(fullText, 'Test shows')
    // e.g. 保护后整句应视为同一句
    expect(sentence).toContain('Test shows the model is strong.')
    expect(sentence).toContain('e.g.')
  })

  it('OCR block join text', () => {
    const fullText = 'We propose a novel attention mechanism.\nIt improves performance on long sequences.'
    const { sentence } = extractSentenceContext(fullText, 'novel attention')
    expect(sentence).toContain('We propose a novel attention mechanism')
  })

  it('needle not found fallback', () => {
    const { sentence, prev, next } = extractSentenceContext('Hello world.', 'missing')
    expect(sentence).toBe('missing')
    expect(prev).toBe('')
    expect(next).toBe('')
  })

  it('same-line heading prefix stripped', () => {
    const fullText = 'M1: Layer Ablation Four groups share r=8. Next sentence.'
    const { sentence } = extractSentenceContext(fullText, 'Four groups')
    expect(sentence).not.toContain('M1:')
    expect(sentence).toContain('Four groups share')
  })
})

describe('splitSentences', () => {
  it('basic', () => {
    expect(splitSentences('Hello world. Next sentence!')).toEqual(['Hello world.', 'Next sentence!'])
  })
  it('abbreviation', () => {
    expect(splitSentences('See Fig. 1. Next.')).toEqual(['See Fig. 1.', 'Next.'])
  })
})
