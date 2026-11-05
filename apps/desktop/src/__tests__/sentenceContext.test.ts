import { describe, it, expect } from 'vitest'
import { extractSentenceContext, isFurnitureLine, locateKey, splitSentences } from '../features/reader/sentence'

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

  // ── v2 新增：真实 PDF 提取文本的极端形态 ──────────────────────

  it('hyphenated line break: selection "attention" matches "atten-\\ntion"', () => {
    const fullText = 'We propose a novel atten-\ntion mechanism that scales. It works well.'
    const { sentence, next } = extractSentenceContext(fullText, 'attention mechanism')
    expect(sentence).toContain('propose a novel')
    expect(sentence).toContain('mechanism that scales')
    expect(next).toContain('It works well')
  })

  it('decimal point inside sentence is not a boundary', () => {
    const fullText = 'Accuracy reaches 64.2% on GSM8K and 81.7% on MATH. This is strong.'
    const { sentence, next, prev } = extractSentenceContext(fullText, 'GSM8K')
    expect(sentence).toContain('Accuracy reaches')
    expect(sentence).toContain('81.7%')
    expect(next).toContain('This is strong')
    expect(prev).toBe('')
  })

  it('numbered section reference does not cut the sentence', () => {
    const fullText = 'As described in Section 3.1 the model uses 8 layers. We follow this design.'
    const { sentence } = extractSentenceContext(fullText, '8 layers')
    expect(sentence).toContain('As described in Section 3.1')
    expect(sentence).toContain('8 layers')
  })

  it('U.S. abbreviation does not cut the sentence', () => {
    const fullText = 'The U.S. market grew by 12%. We then compare with Europe.'
    const { sentence, next } = extractSentenceContext(fullText, 'market grew')
    expect(sentence).toContain('The U.S. market grew')
    expect(next).toContain('We then compare')
  })

  it('figure caption between paragraphs is skipped, not glued', () => {
    const fullText = [
      'The encoder maps tokens to vectors.',
      'Figure 3: Architecture of the proposed model.',
      'Decoder applies cross-attention over these vectors.',
    ].join('\n')
    const { sentence, prev } = extractSentenceContext(fullText, 'cross-attention')
    expect(sentence).toContain('Decoder applies')
    expect(sentence).not.toContain('Figure 3')
    expect(prev).toContain('encoder maps tokens')
  })

  it('page number line is not part of context', () => {
    const fullText = ['12', 'We propose a new loss function.', 'It converges faster.'].join('\n')
    const { sentence, prev } = extractSentenceContext(fullText, 'new loss')
    expect(sentence).toBe('We propose a new loss function.')
    expect(prev).toBe('')
  })

  it('multi-sentence selection keeps the whole selection', () => {
    const a = 'First sentence about retrieval augmented generation.'
    const b = 'Second sentence reports the exact match rate.'
    const fullText = `Intro line. ${a} ${b} Tail sentence.`
    const sel = `${a} ${b}`
    const { sentence } = extractSentenceContext(fullText, sel)
    expect(sentence).toContain('First sentence')
    expect(sentence).toContain('Second sentence')
  })

  it('selection at document start has no prev', () => {
    const fullText = 'Opening sentence defines the problem. Second sentence follows.'
    const { sentence, prev, next } = extractSentenceContext(fullText, 'Opening')
    expect(prev).toBe('')
    expect(sentence).toContain('Opening sentence defines the problem.')
    expect(next).toContain('Second sentence follows')
  })

  it('collapsed whitespace and quotes still locate', () => {
    const fullText = 'We call this   "adaptive   routing" in the paper. It helps.'
    const { sentence } = extractSentenceContext(fullText, '"adaptive routing"')
    expect(sentence).toContain('We call this')
  })

  it('model names with version numbers are not split', () => {
    const fullText = 'We compare with Qwen3.6 and GPT-5.6. Mimo-V2.5 is faster.'
    const { sentence, prev, next } = extractSentenceContext(fullText, 'Mimo-V2.5')
    expect(sentence).toBe('Mimo-V2.5 is faster.')
    expect(prev).toBe('We compare with Qwen3.6 and GPT-5.6.')
    expect(next).toBe('')
  })

  it('CJK sentence punctuation splits', () => {
    expect(splitSentences('这是一句。这是第二句！')).toEqual(['这是一句。', '这是第二句！'])
  })
})

describe('splitSentences', () => {
  it('basic', () => {
    expect(splitSentences('Hello world. Next sentence!')).toEqual(['Hello world.', 'Next sentence!'])
  })
  it('abbreviation', () => {
    expect(splitSentences('See Fig. 1. Next.')).toEqual(['See Fig. 1.', 'Next.'])
  })
  it('decimal and numbering', () => {
    expect(splitSentences('We get 64.2% on GSM8K. Next one.')).toEqual(['We get 64.2% on GSM8K.', 'Next one.'])
    expect(splitSentences('In Section 3.1 we show it works. Then we stop.')).toEqual([
      'In Section 3.1 we show it works.',
      'Then we stop.',
    ])
  })
  it('version numbers glued to letters', () => {
    expect(splitSentences('We use Qwen3.6 and GPT-5.6. Then Mimo-V2.5.')).toEqual([
      'We use Qwen3.6 and GPT-5.6.',
      'Then Mimo-V2.5.',
    ])
  })
  it('acronyms', () => {
    expect(splitSentences('The U.S. market fell. Ph.D. students joined.')).toEqual([
      'The U.S. market fell.',
      'Ph.D. students joined.',
    ])
  })
  it('initials', () => {
    expect(splitSentences('We thank J. Smith for help. He agreed.')).toEqual([
      'We thank J. Smith for help.',
      'He agreed.',
    ])
  })
  it('lowercase continuation is not a boundary', () => {
    expect(splitSentences('We use ResNet. which is deep.')).toEqual(['We use ResNet. which is deep.'])
  })
})

describe('locateKey', () => {
  it('drops hyphen at line break and keeps offset mapping', () => {
    const { key } = locateKey('atten-\ntion mechanism')
    expect(key).toBe('attentionmechanism')
  })
  it('normalizes ligatures and full-width letters', () => {
    expect(locateKey('eﬃcient ＡＢＣ').key).toBe('efficientabc')
  })
})

describe('isFurnitureLine', () => {
  it('detects headings, captions, page numbers', () => {
    expect(isFurnitureLine('Abstract')).toBe(true)
    expect(isFurnitureLine('B.')).toBe(true)
    expect(isFurnitureLine('Figure 3: Architecture')).toBe(true)
    expect(isFurnitureLine('12')).toBe(true)
    expect(isFurnitureLine('A Programming Paradigm for Composability')).toBe(true)
  })
  it('keeps real prose and wrapped lines', () => {
    expect(isFurnitureLine('We propose a novel attention mechanism that')).toBe(false)
    expect(isFurnitureLine('Modern software increasingly requires dynamic composition, yet')).toBe(false)
  })
})
