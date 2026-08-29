// highlightGeometry 纯函数单测（node 环境）
// 行盒 band 提取 / 行盒钳制（吸附式）/ 名称映射
import { describe, expect, it } from 'vitest'
import {
  capBandHeight,
  extractLineBands,
  fitRectEdgesToInk,
  fitRectVertical,
  fitRunToInk,
  separateVertically,
  snapToBands,
  stageHlName,
  type InkMap,
  type LineBand,
} from '../shared/highlightGeometry'

const rectOf = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
}) as DOMRect

describe('extractLineBands', () => {
  const toY = (v: number) => v - 100 // 模拟舞台原点偏移

  it('空输入返回空数组', () => {
    expect(extractLineBands([], toY)).toEqual([])
  })

  it('按可视 Y 换算为舞台坐标并排序', () => {
    const els = [
      { getBoundingClientRect: () => rectOf(0, 120, 100, 13.2) },
      { getBoundingClientRect: () => rectOf(0, 101, 100, 13.2) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(2)
    expect(bands[0].top).toBeCloseTo(1)
    expect(bands[0].bottom).toBeCloseTo(14.2)
    expect(bands[1].top).toBeCloseTo(20)
    expect(bands[1].bottom).toBeCloseTo(33.2)
  })

  it('丢弃高度 <2px 的盒（markedContent display:contents 等）', () => {
    const els = [
      { getBoundingClientRect: () => rectOf(0, 100, 100, 1.2) },
      { getBoundingClientRect: () => rectOf(0, 110, 100, 0) },
      { getBoundingClientRect: () => rectOf(0, 120, 100, 13.2) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(1)
    expect(bands[0].top).toBe(20)
    expect(bands[0].bottom).toBeCloseTo(33.2)
  })

  it('同线多 span 度量微差（<1px）合并为一条 band', () => {
    const els = [
      { getBoundingClientRect: () => rectOf(0, 100, 40, 13.2) },
      { getBoundingClientRect: () => rectOf(45, 100.4, 40, 13.0) },
      { getBoundingClientRect: () => rectOf(0, 130, 40, 13.2) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(2)
    expect(bands[0].top).toBe(0)
    expect(bands[0].bottom).toBeCloseTo(13.4)
  })

  it('span 度量差 >1px 的一行不碎带（高缩放碎片带回归 v2.7）', () => {
    // 粗体 span 盒比邻 span 高 3px、top 低 1.5px——旧"top/bottom 双 <1px"
    // 规则下碎成 2 条窄带（em 变小 → 墨迹钳死碎片邻域 → 顶切字）
    const els = [
      { getBoundingClientRect: () => rectOf(0, 100, 40, 13.2) },
      { getBoundingClientRect: () => rectOf(45, 98.5, 40, 16.4) },
      { getBoundingClientRect: () => rectOf(0, 130, 40, 13.2) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(2)
    expect(bands[0].top).toBeCloseTo(-1.5)
    expect(bands[0].bottom).toBeCloseTo(14.9)
  })

  it('上标/小盒碎片并入主行（中心距 < 半行高）', () => {
    const els = [
      { getBoundingClientRect: () => rectOf(0, 100, 100, 31.4) },
      { getBoundingClientRect: () => rectOf(100, 102.2, 12, 11.8) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(1)
    expect(bands[0].top).toBe(0)
    expect(bands[0].bottom).toBeCloseTo(31.4)
    expect(bands[0].right).toBe(112)
  })

  it('双栏同行 span 按 gutter 切成栏级 band（v2.8 缝合带回归）', () => {
    // 左栏行 [0..24.8] x[25..650]，右栏行 [6.5..31.4] x[680..1308]（基线错位 6.5px）
    const els = [
      { getBoundingClientRect: () => rectOf(25, 100, 625, 24.8) },
      { getBoundingClientRect: () => rectOf(680, 106.5, 628, 24.9) },
      { getBoundingClientRect: () => rectOf(25, 130, 625, 24.8) },
    ]
    const bands = extractLineBands(els, toY)
    expect(bands).toHaveLength(3)
    expect(bands[0].top).toBe(0)
    expect(bands[0].bottom).toBeCloseTo(24.8)
    expect(bands[0].left).toBe(25)
    expect(bands[0].right).toBe(650)
    expect(bands[1].top).toBeCloseTo(6.5)
    expect(bands[1].bottom).toBeCloseTo(31.4)
    expect(bands[1].left).toBe(680)
    expect(bands[1].right).toBe(1308)
    expect(bands[2].top).toBe(30)
  })

  it('交错双栏行不熔并（top 交错 < 中心阈值，靠 x 邻接隔开，v2.8）', () => {
    // 120% 实测：右栏行顶 = 左栏行顶 +4.3（< 0.5×行高阈值），
    // 纯中心距会把左栏行 k 与右栏行 k+1 熔成跨双栏双行带
    const els = [
      { getBoundingClientRect: () => rectOf(386, 479.1, 289, 12) }, // B 右栏行 k
      { getBoundingClientRect: () => rectOf(71, 489.2, 289, 11.9) }, // C 左栏行 k+1
      { getBoundingClientRect: () => rectOf(374, 493.5, 301, 11.9) }, // D 右栏行 k+1（与 C 中心距 4.3）
      { getBoundingClientRect: () => rectOf(59, 503.5, 301, 12) }, // E 左栏行 k+2
    ]
    const bands = extractLineBands(els, (v) => v)
    expect(bands).toHaveLength(4)
    expect(bands.map((b) => [b.left, b.right])).toEqual([
      [386, 675],
      [71, 360],
      [374, 675],
      [59, 360],
    ])
    expect(bands[1].bottom).toBeCloseTo(501.1) // 不含 D 的 505.4
    expect(bands[2].top).toBeCloseTo(493.5) // 不含 C 的 489.2
  })

  it('toStageX：left/right 换算为舞台 X（fitRunToInk 窗口契约）', () => {
    const els = [{ getBoundingClientRect: () => rectOf(100, 120, 50, 13.2) }]
    const bands = extractLineBands(els, (v) => v - 100, (v) => v - 50)
    expect(bands[0].left).toBe(50)
    expect(bands[0].right).toBe(100)
  })

  it('相邻行（行距 19.2）不合并', () => {
    const els = [
      { getBoundingClientRect: () => rectOf(0, 100, 100, 13.2) },
      { getBoundingClientRect: () => rectOf(0, 119.2, 100, 13.2) },
    ]
    expect(extractLineBands(els, toY)).toHaveLength(2)
  })
})

describe('fitRectVertical（块高=块内字符墨迹 v2.6）', () => {
  const bands: LineBand[] = [
    { top: 10, bottom: 23.2 },
    { top: 29.2, bottom: 42.4 },
  ]

  it('无墨迹：吸附到行带（退化为 snapToBands）', () => {
    const box = { left: 5, top: 12, width: 40, height: 8 }
    expect(fitRectVertical(null, box, bands, 1)).toEqual({ left: 5, top: 10, width: 40, height: 13.2 })
  })

  it('块高 = 块内字符墨迹：本块 x 范围墨迹 12..21 决定上下界，块外更深墨迹不影响', () => {
    const ink = makeInk(100, 40, [[30, 12, 50, 21], [80, 22, 95, 24]])
    const box = { left: 30, top: 12, width: 20, height: 8 }
    const out = fitRectVertical(ink, box, bands, 1)
    expect(out.top).toBe(12)
    expect(out.height).toBeCloseTo(9)
  })

  it('降部伸入行间空隙（领地内完整覆盖字符墨迹，至下行 band 顶 −1px）', () => {
    const ink = makeInk(100, 40, [[30, 12, 50, 25]])
    const box = { left: 30, top: 12, width: 20, height: 8 }
    const out = fitRectVertical(ink, box, bands, 1)
    expect(out.top + out.height).toBeCloseTo(25)
    expect(out.top + out.height).toBeLessThan(29.2) // 不越过下一行行带
  })

  it('下界不越过下一行行带（墨迹更深时被截到下行 band 顶 −1px）', () => {
    const ink = makeInk(100, 40, [[30, 12, 50, 28]])
    const box = { left: 30, top: 12, width: 20, height: 8 }
    const out = fitRectVertical(ink, box, bands, 1)
    // fitRunToInk ±0.35em 防桥接钳制先截到 27，领地上限 28.2 不再约束
    expect(out.top + out.height).toBeCloseTo(27)
    expect(out.top + out.height).toBeLessThan(29.2)
  })

  it('x 范围内无墨迹：回退吸附结果', () => {
    const ink = makeInk(100, 40, [[80, 12, 95, 20]])
    const box = { left: 30, top: 12, width: 20, height: 8 }
    const out = fitRectVertical(ink, box, bands, 1)
    expect(out).toEqual({ left: 30, top: 10, width: 20, height: 13.2 })
  })

  it('领地跳过同行并排栏带（v2.8 缝合领地回归）', () => {
    const colBands: LineBand[] = [
      { top: 10, bottom: 23.2, left: 0, right: 100 }, // L1
      { top: 15, bottom: 28.2, left: 200, right: 300 }, // R1（双栏基线错位 +5）
      { top: 29.2, bottom: 42.4, left: 0, right: 100 }, // L2
    ]
    // 右栏矩形：本块墨迹 16..27；旧领地 roomTop=L1.bottom+1=24.2 → 顶被压到 24 切字
    const ink = makeInk(300, 50, [[210, 16, 240, 27]])
    const box = { left: 210, top: 17, width: 30, height: 8 }
    const out = fitRectVertical(ink, box, colBands, 1)
    expect(out.top).toBe(16)
    expect(out.top + out.height).toBe(27)
  })

  it('band 选择 x 优先：右栏矩形不吸左栏带（v2.8 交错双栏回归）', () => {
    const colBands: LineBand[] = [
      { top: 620, bottom: 630, left: 59, right: 360 },
      { top: 624.3, bottom: 634.3, left: 374, right: 675 },
    ]
    // 右栏墨迹 625..632（x 380..500）
    const ink = makeInk(700, 700, [[380, 625, 500, 632]])
    const box = { left: 374, top: 619.5, width: 301, height: 17.1 }
    const out = fitRectVertical(ink, box, colBands, 1)
    expect(out.top).toBe(625)
    expect(out.height).toBe(7) // 吸错左栏带时领地互相钳制 → 退化为 snapped h=10
  })
})

describe('snapToBands（渲染吸附 v2.5）', () => {
  const bands: LineBand[] = [
    { top: 10, bottom: 23.2 }, // band 高 13.2
    { top: 29.2, bottom: 42.4 },
  ]

  it('字形盒 ⊇ band：吸附到 band 精确值', () => {
    const box = { left: 5, top: 6.85, width: 50, height: 19.5 }
    const out = snapToBands(box, bands)
    expect(out).toEqual({ left: 5, top: 10, width: 50, height: 13.2 })
    expect(box).toEqual({ left: 5, top: 6.85, width: 50, height: 19.5 }) // 不改入参
  })

  it('历史行盒高矩形：归一到 band', () => {
    const box = { left: 0, top: 11, width: 50, height: 12 }
    expect(snapToBands(box, bands)).toEqual({ left: 0, top: 10, width: 50, height: 13.2 })
  })

  it('大缩放下 Range 盒与 band 偏移大（交集仅 30%）也吸附——432% 全透传回归', () => {
    const box = { left: 0, top: 19, width: 50, height: 13.4 } // 与 band1 交集 4.2
    const out = snapToBands(box, bands)
    expect(out).toEqual({ left: 0, top: 10, width: 50, height: 13.2 })
  })

  it('真跨行矩形（h > 2×band）：不钳制，返回原引用', () => {
    const box = { left: 0, top: 8, width: 50, height: 30 } // 30 > 26.4
    expect(snapToBands(box, bands)).toBe(box)
  })

  it('高恰好 2×band：吸附（含等号）', () => {
    const box = { left: 0, top: 8, width: 50, height: 2 * 13.2 }
    const out = snapToBands(box, bands)
    expect(out.top).toBe(10)
    expect(out.height).toBe(13.2)
  })

  it('与所有 band 无交集但贴近某行（旧格式小矩形）：按最近 band 中心吸附', () => {
    // 盒 [4,12]（中心 8）在 band1 [10,23.2]（中心 16.6）上方 8.6px ≤ 1.5×13.2
    const box = { left: 0, top: 4, width: 50, height: 8 }
    const out = snapToBands(box, bands)
    expect(out).toEqual({ left: 0, top: 10, width: 50, height: 13.2 })
  })

  it('远离所有行带（中心距离超 1.5×band）：透传', () => {
    const box = { left: 0, top: 100, width: 50, height: 8 }
    expect(snapToBands(box, bands)).toBe(box)
  })

  it('空 bands：透传', () => {
    const box = { left: 0, top: 8, width: 50, height: 19.5 }
    expect(snapToBands(box, [])).toBe(box)
  })

  it('零高矩形：透传', () => {
    const box = { left: 0, top: 8, width: 50, height: 0 }
    expect(snapToBands(box, bands)).toBe(box)
  })

  it('命中垂直交集最大的 band', () => {
    const box = { left: 0, top: 28, width: 50, height: 19.5 }
    const out = snapToBands(box, bands)
    expect(out).toEqual({ left: 0, top: 29.2, width: 50, height: 13.2 })
  })

  it('垂直交集相近时优先水平相交的 band（交错双栏回归 v2.8）', () => {
    // 左栏行带 [620..630] x[59..360]，右栏行带 [624.3..634.3] x[374..675]：
    // 右栏矩形 [619.5..636.6] 与左带的垂直交集（10.5）反超右带（10），
    // 纯垂直选择吸到左栏带 → run/领地全错
    const colBands: LineBand[] = [
      { top: 620, bottom: 630, left: 59, right: 360 },
      { top: 624.3, bottom: 634.3, left: 374, right: 675 },
    ]
    const box = { left: 374, top: 619.5, width: 301, height: 17.1 }
    const out = snapToBands(box, colBands)
    expect(out.top).toBe(624.3)
    expect(out.height).toBe(10)
  })
})

describe('capBandHeight（行间白隙 v2.5）', () => {
  it('墨迹带高≈行距：封顶到 0.84×行距，行间留出可见白隙', () => {
    // 行距 19.2，墨迹 run 19.5（相接）→ 封顶 16.128，白隙 3.07
    const out = capBandHeight([
      { top: 10, bottom: 29.5 },
      { top: 29.2, bottom: 48.7 },
      { top: 48.4, bottom: 67.9 },
    ])
    expect(out[0].bottom).toBeCloseTo(10 + 0.84 * 19.2)
    expect(out[1].top - out[0].bottom).toBeCloseTo(19.2 * 0.16)
    expect(out[1].bottom).toBeCloseTo(29.2 + 0.84 * 19.2)
    expect(out[2].top).toBe(48.4)
  })

  it('末带按前一行行距同款封顶', () => {
    const out = capBandHeight([
      { top: 10, bottom: 29.5 },
      { top: 29.2, bottom: 48.7 },
    ])
    expect(out[1].bottom).toBeCloseTo(29.2 + 0.84 * 19.2)
  })

  it('本就短于封顶值的带不动；单带（无行距参照）透传', () => {
    const single = [{ top: 10, bottom: 20 }]
    expect(capBandHeight(single)[0]).toEqual({ top: 10, bottom: 20 })
    const out = capBandHeight([
      { top: 10, bottom: 20 },
      { top: 50, bottom: 60 }, // 行距 40 → 封顶 43.6 > 20，不动
    ])
    expect(out[0]).toEqual({ top: 10, bottom: 20 })
    expect(out[1]).toEqual({ top: 50, bottom: 60 })
  })

  it('并排栏带互不干扰行距（x 感知 pitch，v2.8）', () => {
    // 双栏基线错位 +6：旧相邻规则把 L1 的行距算成 R1 的 6 → 带压扁成 5px
    const out = capBandHeight([
      { top: 0, bottom: 30, left: 0, right: 100 }, // L1
      { top: 6, bottom: 36, left: 200, right: 300 }, // R1
      { top: 30, bottom: 60, left: 0, right: 100 }, // L2
      { top: 36, bottom: 66, left: 200, right: 300 }, // R2
    ])
    expect(out[0].bottom).toBeCloseTo(25.2) // 0.84×30（pitch 取 x 相交的 L2）
    expect(out[1].bottom).toBeCloseTo(31.2) // 6 + 0.84×30（pitch 取 R2）
    expect(out[2].bottom).toBeCloseTo(55.2) // 栏末行：行距沿用本栏上一行
    expect(out[3].bottom).toBeCloseTo(61.2)
  })
})

describe('separateVertically（行带/词带垂直分离 v2.4）', () => {
  it('相邻带重叠：重叠区中点切开，两侧各让 minGap/2', () => {
    const out = separateVertically([
      { top: 10, bottom: 20 },
      { top: 19, bottom: 30 },
    ])
    expect(out[0]).toEqual({ top: 10, bottom: 19.25 })
    expect(out[1]).toEqual({ top: 19.75, bottom: 30 })
    expect(out[1].top - out[0].bottom).toBeCloseTo(0.5)
  })

  it('紧邻（间距 < minGap）也强制拉开', () => {
    const out = separateVertically([
      { top: 10, bottom: 20 },
      { top: 20.2, bottom: 30 },
    ])
    expect(out[1].top - out[0].bottom).toBeCloseTo(0.5)
  })

  it('三连重叠链式分离，间距全部 ≥ minGap', () => {
    const out = separateVertically([
      { top: 0, bottom: 12 },
      { top: 10, bottom: 24 },
      { top: 22, bottom: 36 },
    ])
    expect(out[1].top - out[0].bottom).toBeGreaterThanOrEqual(0.5)
    expect(out[2].top - out[1].bottom).toBeGreaterThanOrEqual(0.5)
    expect(out[0].top).toBe(0)
    expect(out[2].bottom).toBe(36)
  })

  it('无重叠：数值不变，返回新数组不改入参', () => {
    const input = [
      { top: 10, bottom: 20 },
      { top: 30, bottom: 40 },
    ]
    const out = separateVertically(input)
    expect(out).not.toBe(input)
    expect(out[0]).toEqual(input[0])
    expect(out[1]).toEqual(input[1])
    expect(input[0]).toEqual({ top: 10, bottom: 20 })
  })

  it('乱序输入：输出按 top 升序', () => {
    const out = separateVertically([
      { top: 30, bottom: 40 },
      { top: 10, bottom: 20 },
    ])
    expect(out.map((b) => b.top)).toEqual([10, 30])
  })

  it('同行两个横向不相交的词带（top/height 位级一致）：不切分（缺陷 A 回归）', () => {
    const out = separateVertically([
      { top: 10, bottom: 23.2, left: 10, width: 30 },
      { top: 10, bottom: 23.2, left: 50, width: 30 },
    ])
    expect(out[0]).toEqual({ top: 10, bottom: 23.2, left: 10, width: 30 })
    expect(out[1]).toEqual({ top: 10, bottom: 23.2, left: 50, width: 30 })
  })

  it('同 top 但横向相交：仍切分（真重叠）', () => {
    const out = separateVertically([
      { top: 10, bottom: 23.2, left: 10, width: 30 },
      { top: 10, bottom: 23.2, left: 25, width: 30 },
    ])
    expect(out[0].bottom).toBeLessThan(out[1].top)
  })
})

describe('stageHlName', () => {
  it('stage+强度映射正确', () => {
    expect(stageHlName(0, 1)).toBe('hl-stage-0-s1')
    expect(stageHlName(0, 2)).toBe('hl-stage-0-s2')
    expect(stageHlName(0, 3)).toBe('hl-stage-0-s3')
    expect(stageHlName(1, 1)).toBe('hl-stage-1-s1')
    expect(stageHlName(1, 3)).toBe('hl-stage-1-s3')
  })
})

// ── 墨迹标定（合成 InkMap：白底 + 指定区域暗像素）──────────────
const scale = 1

function makeInk(w: number, h: number, darkRects: Array<[number, number, number, number]>): InkMap {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255
    data[i * 4 + 1] = 255
    data[i * 4 + 2] = 255
    data[i * 4 + 3] = 255
  }
  for (const [x0, y0, x1, y1] of darkRects) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4
        data[i] = 40
        data[i + 1] = 40
        data[i + 2] = 40
      }
    }
  }
  return { data, width: w, height: h }
}

describe('fitRunToInk', () => {
  it('band 与墨迹部分相交：扩展到完整墨迹行（降部/升部覆盖）', () => {
    // 墨迹行 10..19（含升部 10-11 与降部 18-19），band 只盖 12..17
    const ink = makeInk(100, 40, [[20, 10, 60, 19]])
    const run = fitRunToInk(ink, { top: 12, bottom: 17 }, 20, 60, 10, scale)
    expect(run).toEqual({ top: 10, bottom: 19 })
  })

  it('band 与墨迹无交集 → null（回退启发式）', () => {
    const ink = makeInk(100, 40, [[20, 30, 60, 35]])
    expect(fitRunToInk(ink, { top: 5, bottom: 10 }, 20, 60, 10, scale)).toBeNull()
  })

  it('窗口内无墨迹 → null', () => {
    const ink = makeInk(100, 40, [])
    expect(fitRunToInk(ink, { top: 10, bottom: 20 }, 20, 60, 10, scale)).toBeNull()
  })

  it('墨迹延伸超出 anchor 邻域（相邻行桥接）：钳制到 ±0.35em', () => {
    // 词墨迹 10..19 经 1 空行桥接下一行 21..24；anchor 12..17 → 钳制 [8.5,20.5]
    const ink = makeInk(100, 40, [[20, 10, 60, 24]])
    expect(fitRunToInk(ink, { top: 12, bottom: 17 }, 20, 60, 10, scale)).toEqual({ top: 10, bottom: 20 })
  })

  it('1 行空隙（笔画断开）不中断扩展', () => {
    const ink = makeInk(100, 40, [[20, 10, 60, 14], [20, 16, 60, 19]])
    const run = fitRunToInk(ink, { top: 12, bottom: 17 }, 20, 60, 10, scale)
    expect(run).toEqual({ top: 10, bottom: 19 })
  })

  it('scale>1 时按 canvas 像素坐标换算', () => {
    const ink = makeInk(200, 80, [[40, 20, 120, 39]]) // ×2 像素
    const run = fitRunToInk(ink, { top: 12, bottom: 17 }, 40, 120, 10, 2)
    expect(run).toEqual({ top: 10, bottom: 19.5 })
  })
})

describe('fitRectEdgesToInk（批注/选区缘吸附 v2.3）', () => {
  it('左缘切进字形：外扩到字形左界，垂直区间不动', () => {
    // 墨迹 20..60，矩形左缘 26 切进字形
    const ink = makeInk(100, 40, [[20, 10, 60, 19]])
    const out = fitRectEdgesToInk(ink, { left: 26, top: 10, width: 30, height: 10 }, 10, scale)
    expect(out).toEqual({ left: 20, top: 10, width: 41, height: 10 })
  })

  it('左缘盖住空白（落库几何起点漂移）：内收到首个墨迹列', () => {
    const ink = makeInk(100, 40, [[26, 10, 60, 19]])
    const out = fitRectEdgesToInk(ink, { left: 20, top: 10, width: 40, height: 10 }, 10, scale)
    expect(out).toEqual({ left: 26, top: 10, width: 35, height: 10 })
  })

  it('多词矩形的内部空格不收缩（只动左右缘）', () => {
    // 词 10..20，空格，词 30..40；矩形 12..38
    const ink = makeInk(100, 40, [[10, 10, 20, 19], [30, 10, 40, 19]])
    const out = fitRectEdgesToInk(ink, { left: 12, top: 10, width: 26, height: 10 }, 10, scale)
    expect(out).toEqual({ left: 10, top: 10, width: 31, height: 10 })
  })

  it('窗口内无墨迹（矩形盖空白区）：数值原样返回', () => {
    const ink = makeInk(200, 40, [[150, 10, 180, 19]])
    const box = { left: 20, top: 10, width: 30, height: 10 }
    expect(fitRectEdgesToInk(ink, box, 10, scale)).toEqual(box)
  })

  it('漂移窗口封顶（0.6em=6 < 48）：远处墨迹不误吸', () => {
    const ink = makeInk(200, 40, [[60, 10, 90, 19]])
    const box = { left: 20, top: 10, width: 20, height: 10 }
    expect(fitRectEdgesToInk(ink, box, 10, scale)).toEqual(box)
  })

  it('零尺寸矩形：原引用返回', () => {
    const ink = makeInk(100, 40, [[20, 10, 60, 19]])
    const box = { left: 20, top: 10, width: 0, height: 10 }
    expect(fitRectEdgesToInk(ink, box, 10, scale)).toBe(box)
  })
})
