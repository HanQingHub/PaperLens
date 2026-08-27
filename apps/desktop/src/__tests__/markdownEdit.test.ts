import { describe, expect, it } from 'vitest'
import { insertLink, setHeading, toggleWrap } from '../features/reader/markdownEdit'

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

function apply(text: string, op: { start: number; end: number; text: string }): string {
  return text.slice(0, op.start) + op.text + text.slice(op.end)
}
