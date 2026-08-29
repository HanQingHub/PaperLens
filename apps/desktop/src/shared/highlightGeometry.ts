// 高亮几何统一基准：行盒 band。词带/选区/批注渲染前一律钳制到 band，
// 消除字形盒（ascent+descent > 行距）导致的行间重叠与层间高度不一致。
// 零项目 import（叶子模块）：reader 与 annotations 共用，不成环。
// 渲染映射假设页面 rotation=0（学术论文常态），与 coords.ts 一致。

export type HlName =
  | 'hl-stage-0-s1' | 'hl-stage-0-s2' | 'hl-stage-0-s3'
  | 'hl-stage-1-s1' | 'hl-stage-1-s2' | 'hl-stage-1-s3'
  | 'hl-stage-2' | 'search-hit' | 'search-hit-current'

export function stageHlName(stage: 0 | 1, strength: 1 | 2 | 3): HlName {
  return `hl-stage-${stage}-s${strength}` as HlName
}

/** 行盒 band：舞台坐标下的垂直区间（一条文本行）。left/right 为成员聚合的
 * 水平范围（墨迹标定窗口用），可为空（纯垂直用法不受影响）。 */
export interface LineBand {
  top: number
  bottom: number
  left?: number
  right?: number
}

/** 舞台坐标矩形（SVG rect 直接可用） */
export interface StageBox { left: number; top: number; width: number; height: number }

/**
 * 提取行盒 band，可选 toStageX 把 left/right 换算为舞台 X（fitRunToInk 窗口
 * 契约为舞台坐标；缺省不做换算，保持旧调用兼容）。输入为元素数组（已过滤
 * endOfContent）；toStageY 把可视 Y 换算为舞台 Y。
 * 高度 <2px 的盒（markedContent display:contents 等）丢弃。
 * 两步聚类：
 *  1) 行中心 + x 邻接聚类：中心距 < 0.5×行高且与组 x 并集间距 ≤ colGap 才入组
 *     （并盒取 union）。不可用"top/bottom 差 <1px"判同线——span 度量差（字体
 *     粗斜体/上下标/回退字体）随缩放线性放大，高倍下 >1px 会把一行碎成多条
 *     窄带，后续墨迹标定的 em 随之变小，run 被钳死在碎片邻域（顶部切字的
 *     根因，v2.7 改中心聚类）。中心距单独不够：双栏行的 top 交错可小于阈值
 *     （右栏行顶 = 左栏行顶 +4~7px），邻栏下一行会被熔进当前行，产出跨双栏
 *     双行带（缝合带 + 半行偏移根因，v2.8 加 x 邻接）。
 *  2) 栏切分：行内 x 间隙 > colGap 处切开（跨栏 gutter，聚类 x 邻接后的
 *     兜底）。双栏论文左右栏基线天然错位 2-3pt，跨栏并集的墨迹扫描在行间
 *     零空白行（一栏的行 k 墨迹填满另一栏 k→k+1 的间隙），run 必爬过行界；
 *     栏级 band 让墨迹标定窗口只含本栏文本。
 */
export function extractLineBands(
  els: Array<{ getBoundingClientRect(): DOMRect }>,
  toStageY: (visualY: number) => number,
  toStageX?: (visualX: number) => number,
): LineBand[] {
  const raw = els
    .map((el) => el.getBoundingClientRect())
    .map((b) => ({
      top: toStageY(b.top),
      bottom: toStageY(b.bottom),
      left: toStageX ? toStageX(b.left) : b.left,
      right: toStageX ? toStageX(b.right) : b.right,
    }))
    .filter((b) => b.bottom - b.top >= 2)
    .sort((a, b) => a.top - b.top)
  type Box = { top: number; bottom: number; left?: number; right?: number }
  const out: LineBand[] = []
  const hasX = raw.length > 0 && raw[0].left != null
  const colGap = hasX
    ? Math.max(
        12,
        0.012 *
          (Math.max(...raw.map((m) => m.right!)) - Math.min(...raw.map((m) => m.left!))),
      )
    : 0
  let group: Box[] = []
  const flush = () => {
    if (!group.length) return
    if (!hasX) {
      out.push({
        top: Math.min(...group.map((m) => m.top)),
        bottom: Math.max(...group.map((m) => m.bottom)),
      })
    } else {
      // 栏切分：行内成员按 left 排序，x 间隙超阈值处切开
      const sorted = [...group].sort((a, b) => a.left! - b.left!)
      let segL = sorted[0].left!
      let segR = sorted[0].right!
      let segTop = sorted[0].top
      let segBottom = sorted[0].bottom
      const emit = () => out.push({ top: segTop, bottom: segBottom, left: segL, right: segR })
      for (let i = 1; i < sorted.length; i++) {
        const m = sorted[i]
        if (m.left! - segR > colGap) {
          emit()
          segL = m.left!
          segR = m.right!
          segTop = m.top
          segBottom = m.bottom
        } else {
          segR = Math.max(segR, m.right!)
          segTop = Math.min(segTop, m.top)
          segBottom = Math.max(segBottom, m.bottom)
        }
      }
      emit()
    }
    group = []
  }
  for (const b of raw) {
    if (!group.length) {
      group = [b]
      continue
    }
    const gt = Math.min(...group.map((m) => m.top))
    const gb = Math.max(...group.map((m) => m.bottom))
    const center = (b.top + b.bottom) / 2
    const lineCenter = (gt + gb) / 2
    const nearCenter = Math.abs(center - lineCenter) < Math.max(0.5 * (gb - gt), 1)
    // x 邻接：与组 x 并集的间隔 ≤ colGap（双栏 gutter 天然大于该值，隔开
    // 交错行；同栏同行碎片 x 相邻不受影响）
    let nearX = true
    if (hasX) {
      let gl = Infinity
      let gr = -Infinity
      for (const m of group) {
        gl = Math.min(gl, m.left!)
        gr = Math.max(gr, m.right!)
      }
      const gap = Math.max(gl - b.right!, b.left! - gr)
      nearX = gap <= colGap
    }
    if (nearCenter && nearX) {
      group.push(b)
    } else {
      flush()
      group = [b]
    }
  }
  flush()
  return out
}

/**
 * 渲染垂直统一入口（词/选区/批注）：先把矩形吸附到行带（无墨迹时的最终几何），
 * 有墨迹时再按**矩形自己覆盖字符的墨迹**重算垂直区间——上界 = 覆盖字符的最高
 * 墨迹行，下界 = 最低墨迹行（用户口径：块高取决于块内字符）。边界约束：
 * 只能在自己行的"领地"内伸展（上方最近垂直不相交 band 底 +1px ～ 下方最近
 * 垂直不相交 band 顶 −1px，同行并排栏带跳过，行间恒留 1px 缝防叠涂），
 * 紧排墨迹占满行距时字符仍被完整覆盖。
 * 返回克隆，不改入参。
 */
export function fitRectVertical(
  ink: InkMap | null | undefined,
  box: StageBox,
  bands: LineBand[],
  scale: number,
): StageBox {
  const snapped = snapToBands(box, bands)
  if (!ink || scale <= 0 || !bands.length || snapped.height <= 0) return snapped
  // band 选择：先在水平相交的带里取垂直交集最大者（交错双栏下，邻栏行带的
  // 垂直交集可能反超本栏带，纯垂直选择会吸到另一栏 → run/领地全错），无 x
  // 信息的带（OCR/旧调用）视为相交
  let bi = -1
  let bestInter = 0
  let bix = -1
  let bestInterX = 0
  bands.forEach((b, i) => {
    const inter = Math.min(snapped.top + snapped.height, b.bottom) - Math.max(snapped.top, b.top)
    if (inter > bestInter) {
      bestInter = inter
      bi = i
    }
    const xHit = b.left == null || b.right == null || (box.left < b.right && b.left < box.left + box.width)
    if (xHit && inter > bestInterX) {
      bestInterX = inter
      bix = i
    }
  })
  if (bix >= 0 && bestInterX > 0) {
    bi = bix
    bestInter = bestInterX
  }
  if (bi < 0 || bestInter <= 0) return snapped
  const band = bands[bi]
  const bh = band.bottom - band.top
  if (bh <= 0) return snapped
  // em 取 max(band 高, 原矩形高)：封顶后 band 高 < 行墨迹高，±0.35em 钳制会切
  // 掉真实降部（botGap −2.5 案例）；原矩形高 ≈ 行墨迹高度，恢复钳制容差
  const run = fitRunToInk(ink, { top: snapped.top, bottom: snapped.top + snapped.height }, box.left, box.left + box.width, Math.max(bh, box.height), scale)
  if (!run) return snapped
  // 领地 = 垂直不相交的最近 band（栏级 band 下同行另一栏的带垂直重叠，须
  // 跳过；取到错误邻带会把领地压成本行自身 → run 恒被截断）
  let roomTop = -Infinity
  for (let j = bi - 1; j >= 0; j--) {
    if (bands[j].bottom <= band.top + 0.5) {
      roomTop = bands[j].bottom + 1
      break
    }
  }
  let roomBottom = Infinity
  for (let j = bi + 1; j < bands.length; j++) {
    if (bands[j].top >= band.bottom - 0.5) {
      roomBottom = bands[j].top - 1
      break
    }
  }
  const top = Math.max(run.top, roomTop)
  const bottom = Math.min(run.bottom, roomBottom)
  if (bottom - top < 2) return snapped
  return { ...snapped, top, height: bottom - top }
}

/**
 * 渲染吸附（选区/批注/词带统一垂直基准）：取与矩形垂直交集最大的 band，
 * top/height 整体吸附到该 band —— 行带已封顶+分离，吸附后任意两层色带不相交、
 * 同行同高。两类矩形放行：高 > 2×band（真跨行矩形，压进单行会丢一行的
 * highlight）；与所有 band 无交集且中心距离超 1.5×band（定位失效，保守透传）。
 * 大缩放下 Range 盒与行带的垂直偏移随 zoom 放大，60%/1.6× 双门槛会在高倍下
 * 全员拒绝（实测 432% 全透传回归），故不做偏移容忍度判断；旧格式小矩形
 * （无交集但贴着行带）按最近 band 中心吸附兜底。
 * 返回克隆，不改入参；bands 空返回原引用。
 */
export function snapToBands<T extends StageBox>(box: T, bands: LineBand[]): T {
  if (!bands.length || box.height <= 0) return box
  const center = box.top + box.height / 2
  let best: LineBand | null = null
  let bestInter = 0
  let bestX: LineBand | null = null
  let bestXInter = 0
  let nearest: LineBand | null = null
  let nearestDist = Infinity
  for (const band of bands) {
    const inter = Math.min(box.top + box.height, band.bottom) - Math.max(box.top, band.top)
    if (inter > bestInter) {
      bestInter = inter
      best = band
    }
    // 水平相交优先：交错双栏下邻栏行带的垂直交集可能反超本栏带
    const xHit = band.left == null || band.right == null || (box.left < band.right && band.left < box.left + box.width)
    if (xHit && inter > bestXInter) {
      bestXInter = inter
      bestX = band
    }
    const bh = band.bottom - band.top
    const dist = Math.abs(band.top + bh / 2 - center)
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = band
    }
  }
  let target = bestX && bestXInter > 0 ? bestX : best && bestInter > 0 ? best : null
  if (!target && nearest) {
    const nbh = nearest.bottom - nearest.top
    if (nearestDist <= 1.5 * (nbh || 1)) target = nearest
  }
  if (!target) return box
  const th = target.bottom - target.top
  if (th > 0 && box.height > 2 * th) return box
  return { ...box, top: target.top, height: th }
}

/**
 * 行带高度封顶：墨迹 run 高≈行距（紧排行带相邻相接），封顶到 maxPitchFrac×行距
 * （行距 = 水平相交的最近下方带的 top 间距——并排栏带水平不相交互不干扰，
 * 双栏基线错位 ~2-3pt 时相邻 top 间距 ≈0 会把带压扁；无水平相交者回退到
 * 排序相邻带，末带按前一行行距同款封顶）——行间保留可见白隙；锚点仍为墨迹顶
 * （升部齐平），降部尾端留白属高亮笔正常观感。返回新数组（升序），不改入参。
 */
export function capBandHeight<T extends { top: number; bottom: number; left?: number; right?: number }>(
  items: Array<T>,
  maxPitchFrac = 0.84,
): Array<T> {
  const out = items.map((it) => ({ ...it })).sort((a, b) => a.top - b.top)
  const overlapsX = (a: T, b: T): boolean => {
    if (a.left == null || b.left == null || a.right == null || b.right == null) return true
    return a.left < b.right && b.left < a.right
  }
  for (let i = 0; i < out.length; i++) {
    let pitch = 0
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].top > out[i].top && overlapsX(out[i], out[j])) {
        pitch = out[j].top - out[i].top
        break
      }
    }
    if (pitch <= 0) {
      // 本栏无下带（栏末行）：行距沿用本栏上一行
      for (let j = i - 1; j >= 0; j--) {
        if (out[i].top > out[j].top && overlapsX(out[i], out[j])) {
          pitch = out[i].top - out[j].top
          break
        }
      }
    }
    if (pitch <= 0) {
      pitch =
        i < out.length - 1 ? out[i + 1].top - out[i].top : out.length > 1 ? out[i].top - out[i - 1].top : 0
    }
    if (pitch > 0) out[i].bottom = Math.min(out[i].bottom, out[i].top + maxPitchFrac * pitch)
  }
  return out
}

/**
 * 垂直分离：按 top 排序后逐对检查，相邻带**垂直重叠且水平相交**（或间距
 * < minGap）时在重叠区中点切开、两侧各让 minGap/2 —— 行带按整行墨迹生成后
 * 高度≈行距，密集批注页相邻行分属不同半透明 SVG，交界双涂层会出深色横条。
 * 水平前置条件：同行两个横向不相交的词带（top/height 位级一致）不会被剁成
 * 半高条。left/width 缺省视为水平相交（纯垂直用法不受影响）。
 * 返回新数组（升序），不改入参。
 */
export function separateVertically<
  T extends { top: number; bottom: number; left?: number; width?: number },
>(items: Array<T>, minGap = 0.5): Array<T> {
  const out = items.map((it) => ({ ...it })).sort((a, b) => a.top - b.top)
  const overlapsX = (a: T, b: T): boolean => {
    if (a.left == null || b.left == null) return true
    const aw = a.width ?? 0
    const bw = b.width ?? 0
    return a.left < b.left + bw && b.left < a.left + aw
  }
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]
    const cur = out[i]
    if (cur.top < prev.bottom + minGap && overlapsX(prev, cur)) {
      const mid = (prev.bottom + cur.top) / 2
      prev.bottom = mid - minGap / 2
      cur.top = mid + minGap / 2
    }
  }
  return out
}

// ── canvas 墨迹标定 ─────────────────────────────────────────
// 文本层的 CSS 度量（回退字体 + scaleX 整串压缩）与 canvas 逐字形绘制存在
// 基线/advance 错位（半字内切、垂直偏移的根因）；高亮带直接按页面 canvas
// 的实际墨迹边界拟合，两类偏差一次消除。

/** 页面 canvas 的像素数据（舞台坐标 × inkScale = canvas 像素坐标） */
export interface InkMap {
  data: Uint8ClampedArray
  width: number
  height: number
}

function inkDark(ink: InkMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= ink.width || y >= ink.height) return false
  const i = (y * ink.width + x) * 4
  return (
    ink.data[i + 3] > 200 &&
    (ink.data[i] < 170 || ink.data[i + 1] < 170 || ink.data[i + 2] < 170)
  )
}

/**
 * 行带垂直墨迹修正：在 anchor ±0.6em × [left,right] 窗口内逐行检测墨迹，
 * 从与 anchor 相交的 ink 行向两侧扩展连续 run（允许 1 行空隙，抗笔画断开），
 * run 最终钳制到 anchor ±0.35em —— 紧排页面的下一行升部永不被并入。
 * run 为空（无墨迹）→ 返回 null（调用方回退启发式）。
 * anchor 为 span 行盒（舞台坐标），left/right/em 同，scale = canvas 像素/舞台 px。
 */
export function fitRunToInk(
  ink: InkMap,
  anchor: { top: number; bottom: number },
  left: number,
  right: number,
  em: number,
  scale: number,
): { top: number; bottom: number } | null {
  if (scale <= 0 || em <= 0) return null
  const l = Math.round(left * scale)
  const r = Math.round(right * scale)
  const ct = Math.round(anchor.top * scale)
  const cb = Math.round(anchor.bottom * scale)
  const emPx = em * scale
  const winT = Math.max(0, Math.floor(ct - 0.6 * emPx))
  const winB = Math.min(ink.height - 1, Math.ceil(cb + 0.6 * emPx))
  const clampT = anchor.top - 0.35 * em
  const clampB = anchor.bottom + 0.35 * em
  const rowHas = (y: number) => {
    for (let x = l; x <= r; x++) if (inkDark(ink, x, y)) return true
    return false
  }
  let seedTop = -1
  let seedBot = -1
  for (let y = Math.max(0, ct); y <= Math.min(ink.height - 1, cb); y++) {
    if (rowHas(y)) {
      if (seedTop < 0) seedTop = y
      seedBot = y
    }
  }
  if (seedTop < 0) return null
  let top2 = seedTop
  let bot2 = seedBot
  let gap = 0
  for (let y = seedTop - 1; y >= winT; y--) {
    if (rowHas(y)) {
      top2 = y
      gap = 0
    } else if (++gap > 1) break
  }
  gap = 0
  for (let y = seedBot + 1; y <= winB; y++) {
    if (rowHas(y)) {
      bot2 = y
      gap = 0
    } else if (++gap > 1) break
  }
  // 钳制到 anchor 邻域（ceil/floor 收紧，防 round 半像素外溢）：
  // ink 越界（相邻行桥接/图形）时截断
  top2 = Math.max(top2, Math.ceil(clampT * scale))
  bot2 = Math.min(bot2, Math.floor(clampB * scale))
  if (bot2 - top2 < 2) return null
  return { top: top2 / scale, bottom: bot2 / scale }
}

/**
 * 左右缘墨迹吸附共享实现：返回吸附后的 [L,R]（canvas 列，闭包）。
 * 判定（防误吸邻词字形）：
 *  - 外扩（切进本词字形）：缘上、缘外都有墨，且墨迹跨缘向盒内连续延伸 ≥3 列；
 *    向外扩到首个 ≥3 连续空列（词间空格）
 *  - 内收（盖住空白/邻词尾随字形）：缘上无墨 → 向内收到首个墨迹列
 *  - 其余（缘在墨迹内但不向盒内延伸）：保守不动
 * 窗口 = 0.6em 且封顶 48 stage px（整页大矩形不误吸远处墨迹）。
 */
function fitEdgesToInkCols(
  ink: InkMap,
  l0: number,
  r0: number,
  t: number,
  b: number,
  emPx: number,
  scale: number,
): { L: number; R: number } {
  const colInk = (x: number) => {
    for (let y = t; y <= b; y++) if (inkDark(ink, x, y)) return true
    return false
  }
  const win = Math.min(0.6 * emPx, 48 * scale)
  const winL = Math.max(0, Math.floor(l0 - win))
  const winR = Math.min(ink.width - 1, Math.ceil(r0 + win))
  let L = l0
  let R = r0
  const inL = colInk(l0)
  if (l0 > 0 && colInk(l0 - 1) && inL && colInk(l0 + 1) && colInk(l0 + 2)) {
    let gap = 0
    for (let x = l0 - 1; x >= winL; x--) {
      if (colInk(x)) {
        L = x
        gap = 0
      } else if (++gap >= 3) break
    }
  } else if (!inL) {
    const lim = Math.min(winR, Math.floor(l0 + win))
    for (let x = l0 + 1; x <= lim; x++) {
      if (colInk(x)) {
        L = x
        break
      }
    }
  }
  const inR = colInk(r0)
  if (colInk(r0 + 1) && inR && colInk(r0 - 1) && colInk(r0 - 2)) {
    let gap = 0
    for (let x = r0 + 1; x <= winR; x++) {
      if (colInk(x)) {
        R = x
        gap = 0
      } else if (++gap >= 3) break
    }
  } else if (!inR) {
    const lim = Math.max(winL, Math.ceil(r0 - win))
    for (let x = r0 - 1; x >= lim; x--) {
      if (colInk(x)) {
        R = x
        break
      }
    }
  }
  return { L, R }
}

/**
 * 批注/选区矩形左右缘墨迹吸附（舞台坐标）：落库几何来自文本层 Range 盒，
 * scaleX 压缩使其相对 canvas 墨迹水平漂移（整串总宽守恒、累计误差全压在
 * 起点侧 → 单缘切进字形半格，另缘恰好对齐），渲染时按墨迹吸附归位。
 * 只动 left/width；垂直归一由 snapToBands/fitRectVertical 负责。无墨迹/退化 → 原样返回。
 */
export function fitRectEdgesToInk(ink: InkMap, box: StageBox, em: number, scale: number): StageBox {
  if (scale <= 0 || em <= 0 || box.width <= 0 || box.height <= 0) return box
  const t = Math.round(box.top * scale)
  const b = Math.round((box.top + box.height) * scale)
  if (b <= t) return box
  const l0 = Math.round(box.left * scale)
  const r0 = Math.round((box.left + box.width) * scale) - 1
  const { L, R } = fitEdgesToInkCols(ink, l0, r0, t, b - 1, em * scale, scale)
  if (R <= L) return box
  return { ...box, left: L / scale, width: (R - L + 1) / scale }
}
