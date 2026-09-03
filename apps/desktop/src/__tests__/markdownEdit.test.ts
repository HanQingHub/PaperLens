import { describe, expect, it } from 'vitest'
import { insertLink, insertTable, setHeading, toggleFence, toggleLinePrefix, toggleWrap } from '../features/reader/markdownEdit'

describe('toggleWrap', () => {
  it('无选区插入空对并光标居中', () => {
    const op = toggleWrap('abc', 1, 1, '**')
    expect(op).toEqual({ start: 1, end: 1, text: '****', newStart: 3, newEnd: 3 })
    expect(apply('abc', op!)).toBe('a****bc')
  })

  it('有选区包裹并选区回落 inner', () => {
    const op = toggleWrap('abc', 1, 3, '**')
    expect(op).toEqual({ start: 1, end: 3, text: '**bc**', newStart: 3, newEnd: 5 })
    expect(apply('abc', op!)).toBe('a**bc**')
  })

  it('选区紧邻两侧 marker 时解除（路径 A）', () => {
    const op = toggleWrap('a**bc**d', 3, 5, '**')
    expect(op).toEqual({ start: 1, end: 7, text: 'bc', newStart: 1, newEnd: 3 })
    expect(apply('a**bc**d', op!)).toBe('abcd')
  })

  it('无选区且光标在空对中间时解除', () => {
    const op = toggleWrap('a****b', 3, 3, '**')
    expect(op).toEqual({ start: 1, end: 5, text: '', newStart: 1, newEnd: 1 })
    expect(apply('a****b', op!)).toBe('ab')
  })

  it('选区自身成对包裹时解除（路径 B）', () => {
    const op = toggleWrap('ab**cd**ef', 2, 8, '**')
    expect(op).toEqual({ start: 2, end: 8, text: 'cd', newStart: 2, newEnd: 4 })
    expect(apply('ab**cd**ef', op!)).toBe('abcdef')
  })

  it('斜体单星', () => {
    const op = toggleWrap('x', 0, 1, '*')
    expect(op && apply('x', op)).toBe('*x*')
    const undo = toggleWrap('*x*', 0, 3, '*')
    expect(undo && apply('*x*', undo)).toBe('x')
  })

  it('删除线双波浪', () => {
    const op = toggleWrap('hi', 0, 2, '~~')
    expect(op && apply('hi', op)).toBe('~~hi~~')
  })

  it('行内代码反引号', () => {
    const op = toggleWrap('code', 0, 4, '`')
    expect(op && apply('code', op)).toBe('`code`')
  })

  it('文首与文末边界', () => {
    const first = toggleWrap('abc', 0, 0, '**')
    expect(first && apply('abc', first)).toBe('****abc')
    const last = toggleWrap('abc', 3, 3, '`')
    expect(last && apply('abc', last)).toBe('abc``')
  })

  it('跨行选区包裹', () => {
    const op = toggleWrap('ab\ncd', 0, 5, '**')
    expect(op && apply('ab\ncd', op)).toBe('**ab\ncd**')
  })

  it('非法区间返回 null', () => {
    expect(toggleWrap('ab', 2, 1, '**')).toBeNull()
    expect(toggleWrap('ab', -1, 1, '**')).toBeNull()
    expect(toggleWrap('ab', 0, 3, '**')).toBeNull()
  })
})

describe('insertLink', () => {
  it('有选区包成链接并光标落 () 内', () => {
    const op = insertLink('ab', 0, 2)
    expect(op).toEqual({ start: 0, end: 2, text: '[ab]()', newStart: 5, newEnd: 5 })
    expect(apply('ab', op)).toBe('[ab]()')
  })

  it('无选区插入 []() 光标落 [] 内', () => {
    const op = insertLink('', 0, 0)
    expect(op).toEqual({ start: 0, end: 0, text: '[]()', newStart: 1, newEnd: 1 })
  })
})

describe('setHeading', () => {
  it('单行加档', () => {
    const op = setHeading('abc', 1, 1, 2)
    expect(op).toEqual({ start: 0, end: 3, text: '## abc', newStart: 4, newEnd: 4 })
    expect(apply('abc', op!)).toBe('## abc')
  })

  it('同档再按取消', () => {
    const op = setHeading('## abc', 4, 4, 2)
    expect(op && apply('## abc', op)).toBe('abc')
    expect(op).toEqual({ start: 0, end: 6, text: 'abc', newStart: 1, newEnd: 1 })
  })

  it('异档替换', () => {
    const op = setHeading('## abc', 4, 4, 4)
    expect(op && apply('## abc', op)).toBe('#### abc')
  })

  it('多行选区逐行加档并映射选区', () => {
    const op = setHeading('ab\ncd', 1, 4, 2)
    expect(op && apply('ab\ncd', op)).toBe('## ab\n## cd')
    expect(op).toMatchObject({ newStart: 4, newEnd: 10 })
  })

  it('选区以换行结尾时末行不计', () => {
    const op = setHeading('ab\ncd', 1, 3, 2)
    expect(op && apply('ab\ncd', op)).toBe('## ab\ncd')
    expect(op).toMatchObject({ start: 0, end: 2, newEnd: 6 })
  })

  it('行首光标不加本行 delta', () => {
    const op = setHeading('ab\ncd', 3, 3, 1)
    expect(op && apply('ab\ncd', op)).toBe('ab\n# cd')
    expect(op).toMatchObject({ newStart: 3, newEnd: 3 })
  })

  it('无空格的 #x 按非标题叠前缀', () => {
    const op = setHeading('##x', 0, 3, 2)
    expect(op && apply('##x', op)).toBe('## ##x')
  })

  it('文末换行后的幻影空行不误伤', () => {
    const op = setHeading('ab\n', 0, 3, 1)
    expect(op && apply('ab\n', op)).toBe('# ab\n')
  })

  it('光标在换行符上按下一行处理', () => {
    const op = setHeading('ab\ncd', 3, 3, 2)
    expect(op && apply('ab\ncd', op)).toBe('ab\n## cd')
  })

  it('空文本插入标题前缀', () => {
    const op = setHeading('', 0, 0, 3)
    expect(op && apply('', op)).toBe('### ')
  })

  it('非法区间返回 null', () => {
    expect(setHeading('ab', 2, 1, 1)).toBeNull()
  })
})

describe('toggleLinePrefix', () => {
  it('单行加前缀（行首锚点不加 delta，沿 setHeading 口径）', () => {
    const op = toggleLinePrefix('ab', 0, 2, '- ')
    expect(op && apply('ab', op)).toBe('- ab')
    expect(op).toMatchObject({ newStart: 0, newEnd: 4 })
  })

  it('混合态加前缀：已有行跳过（免双前缀）', () => {
    const op = toggleLinePrefix('- a\nb', 0, 5, '- ')
    expect(op && apply('- a\nb', op)).toBe('- a\n- b')
  })

  it('全有前缀 → 逐行去前缀', () => {
    const op = toggleLinePrefix('- ab', 0, 4, '- ')
    expect(op && apply('- ab', op)).toBe('ab')
  })

  it('多行半有 → 非空行全加（含空行跳过）', () => {
    const op = toggleLinePrefix('- a\nb\n\nc', 0, 8, '- ')
    expect(op && apply('- a\nb\n\nc', op)).toBe('- a\n- b\n\n- c')
  })

  it('多行全有 → 全去', () => {
    const op = toggleLinePrefix('> a\n> b', 0, 7, '> ')
    expect(op && apply('> a\n> b', op)).toBe('a\nb')
  })

  it('选区以换行结尾末行不计', () => {
    const op = toggleLinePrefix('ab\ncd', 0, 3, '- ')
    expect(op && apply('ab\ncd', op)).toBe('- ab\ncd')
  })

  it('全空选区 → null（禁 undo 污染）', () => {
    expect(toggleLinePrefix('\n\n', 0, 2, '- ')).toBeNull()
    expect(toggleLinePrefix('', 0, 0, '- ')).toBeNull()
  })

  it('越界 → null', () => {
    expect(toggleLinePrefix('ab', 2, 1, '- ')).toBeNull()
    expect(toggleLinePrefix('ab', -1, 1, '- ')).toBeNull()
    expect(toggleLinePrefix('ab', 0, 9, '- ')).toBeNull()
  })
})

describe('toggleFence', () => {
  it('无选区插入空围栏并光标居中', () => {
    const op = toggleFence('ab', 1, 1)
    expect(op && apply('ab', op)).toBe('a```\n\n```b')
    expect(op).toMatchObject({ newStart: 5, newEnd: 5 })
  })

  it('选中行包裹', () => {
    const op = toggleFence('ab\ncd', 0, 5)
    expect(op && apply('ab\ncd', op)).toBe('```\nab\ncd\n```')
  })

  it('已包裹 → 解包', () => {
    const src = '```\nab\n```'
    const op = toggleFence(src, 0, src.length)
    expect(op && apply(src, op)).toBe('ab')
  })

  it('非法区间返回 null', () => {
    expect(toggleFence('ab', 2, 1)).toBeNull()
  })
})

describe('insertTable', () => {
  it('光标处插入模板并落首单元格', () => {
    const op = insertTable('ab', 1, 1)
    expect(apply('ab', op)).toBe('a|  |  |\n|---|---|\n|  |  |b')
    expect(op).toMatchObject({ newStart: 3, newEnd: 3 })
  })

  it('有选区删选区后插入', () => {
    const op = insertTable('ab', 0, 2)
    expect(apply('ab', op)).toBe('|  |  |\n|---|---|\n|  |  |')
  })
})

function apply(text: string, op: { start: number; end: number; text: string }): string {
  return text.slice(0, op.start) + op.text + text.slice(op.end)
}
