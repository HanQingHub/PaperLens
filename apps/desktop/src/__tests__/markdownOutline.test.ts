import { describe, expect, it } from 'vitest'
import { parseMdHeadings } from '../features/reader/markdownOutline'

describe('parseMdHeadings', () => {
  it('空输入 → 空', () => {
    expect(parseMdHeadings('')).toEqual([])
    expect(parseMdHeadings('正文无标题\n第二行')).toEqual([])
  })

  it('ATX 六级 + 行号 + 行尾修饰剥离', () => {
    const src = '# 一\n## 二 ##\n### 三\n#### 四 ####\n##### 五\n###### 六\n###无空格非标题'
    const r = parseMdHeadings(src)
    expect(r.map((h) => [h.level, h.title, h.line])).toEqual([
      [1, '一', 0],
      [2, '二', 1],
      [3, '三', 2],
      [4, '四', 3],
      [5, '五', 4],
      [6, '六', 5],
    ])
  })

  it('`##` 空标题丢弃（无空格/无文本）', () => {
    expect(parseMdHeadings('##\n##   \n# 实')).toEqual([{ level: 1, title: '实', line: 2 }])
  })

  it('``` 围栏内假标题跳过 + 未闭合吞掉余下', () => {
    const src = '# 真1\n```js\n# 假\n```\n# 真2\n```\n# 假2'
    expect(parseMdHeadings(src).map((h) => h.title)).toEqual(['真1', '真2'])
  })

  it('~~~ 围栏 + 0-3 空格缩进围栏', () => {
    const src = '# 真1\n~~~\n# 假\n~~~\n  ```js\n# 假2\n  ```\n# 真2'
    expect(parseMdHeadings(src).map((h) => h.title)).toEqual(['真1', '真2'])
  })

  it('围栏字符不一致不闭合（``` 内 ~~~ 不算闭合）', () => {
    const src = '```\n~~~\n# 假\n~~~\n```\n# 真'
    expect(parseMdHeadings(src).map((h) => h.title)).toEqual(['真'])
  })

  it('短闭合不闭合长开启（```` 需 ≥4 反引号闭合）', () => {
    const src = '````\n# 假\n```\n# 仍假\n````\n# 真'
    expect(parseMdHeadings(src).map((h) => h.title)).toEqual(['真'])
  })

  it('setext 不收录', () => {
    expect(parseMdHeadings('标题\n===\n副\n---')).toEqual([])
  })

  it('行内代码与引用行不误伤：引用内标题照收（remark 亦渲染）', () => {
    const r = parseMdHeadings('> # 引用标题')
    expect(r).toEqual([{ level: 1, title: '引用标题', line: 0 }])
  })

  it('0-3 空格缩进标题照收（remark 亦渲染）', () => {
    const r = parseMdHeadings('  ## 缩进')
    expect(r).toEqual([{ level: 2, title: '缩进', line: 0 }])
  })
})
