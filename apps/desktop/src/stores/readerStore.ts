// 阅读器私有状态：文档/页码/缩放/模式/选区/批注/OCR
import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OcrPageBlocks, Paper } from '../api/types'
import type { AnnotationRaw } from '../api/client'

export type PdfRect = [number, number, number, number]
export type ViewMode = 'single' | 'continuous'
export const ANNO_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const
export type AnnoColor = (typeof ANNO_COLORS)[number]

/** 画笔工具集：自由笔触（pen/highlighter）与图形（line/arrow/rect/ellipse）+ 橡皮擦（eraser，仅前端擦除态，不落库） */
export type InkTool = 'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'eraser'

/**
 * ink 笔迹（page 单位，scale=1 左上原点，x∈[0,baseW] y∈[0,baseH]）：
 * pen/highlighter 为 N 个采样点；图形恰 2 点（起点/终点，rect/ellipse 为包围盒对角）。
 * 与 PDF 用户空间（y 向上）的批注坐标系并存——InkLayer 渲染只需 ×hiScale。
 */
export interface InkStroke {
  tool: InkTool
  color: string
  width: number
  points: [number, number][]
}

/** 画笔会话状态（工具偏好跨文档保留，active 随文档切换复位） */
export interface InkState {
  active: boolean
  tool: InkTool
  color: string
  width: number
}

export interface SelectionInfo {
  text: string
  pageIndex: number
  rects: PdfRect[] // PDF 用户空间
  sentence: string
  prev: string
  next: string
  /** 选区所属论文（对照窗格选区 ≠ 主窗格 paper.id） */
  paperId: number
  /** 工具条定位（视口坐标，fixed 定位跨窗格通用） */
  toolbarX: number
  toolbarY: number
  toolbarBelow: boolean
}

export interface ReaderAnnotation {
  id: number
  page_no: number
  type: 'word_note' | 'sentence' | 'ink'
  rects: PdfRect[]
  anchorText: string
  card: { x: number; y: number; w: number; h: number } | null
  color: AnnoColor | string
  text: string
  /** type='ink' 时的笔迹数据（其余类型恒 null） */
  ink: InkStroke | null
}

/** 可落库工具白名单（eraser 为纯前端擦除态，永不持久化；parse 拒收即渲染层跳过） */
const INK_TOOLS: readonly string[] = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse']

/** anchor_json（type='ink'）→ InkStroke；损坏/缺字段降级为 null（渲染层跳过） */
function parseInkStroke(anchorJson: string): InkStroke | null {
  try {
    const a = JSON.parse(anchorJson) as Partial<InkStroke>
    if (typeof a.tool !== 'string' || !INK_TOOLS.includes(a.tool)) return null
    if (!Array.isArray(a.points) || a.points.length === 0) return null
    const points = a.points.filter(
      (p): p is [number, number] =>
        Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
    if (!points.length) return null
    return {
      tool: a.tool as InkTool,
      color: typeof a.color === 'string' ? a.color : '#e74c3c',
      width: Number.isFinite(a.width) ? Math.max(0.5, Number(a.width)) : 2,
      points,
    }
  } catch {
    return null
  }
}

export function parseAnnotation(raw: AnnotationRaw): ReaderAnnotation {
  let rects: PdfRect[] = []
  let anchorText = ''
  try {
    const a = JSON.parse(raw.anchor_json) as { rects?: PdfRect[]; text?: string }
    rects = Array.isArray(a.rects) ? a.rects : []
    anchorText = a.text ?? ''
  } catch {
    /* anchor_json 损坏时留空 */
  }
  let card: ReaderAnnotation['card'] = null
  if (raw.card_json) {
    try {
      card = JSON.parse(raw.card_json)
    } catch {
      /* 损坏忽略 */
    }
  }
  return {
    id: raw.id,
    page_no: raw.page_no,
    type: raw.type,
    rects,
    anchorText,
    card,
    color: raw.color || 'yellow',
    text: raw.text ?? '',
    ink: raw.type === 'ink' ? parseInkStroke(raw.anchor_json) : null,
  }
}

/** 连线批注进行时状态 */
export interface LinkingDraft {
  pageIndex: number
  rects: PdfRect[]
  text: string
  /** 拖动中的鼠标位置（页内 viewport 坐标），null = 未开始拖 */
  drag: { x: number; y: number } | null
  /** 松手后待保存的卡片（viewport 坐标 + 尺寸） */
  cardDraft: { x: number; y: number; w: number; h: number } | null
}

/** 页全文缓存（句子提取 + 搜索共用） */
export const pageTextCache = new Map<number, string>()

interface ReaderState {
  paper: Paper | null
  pdf: PDFDocumentProxy | null
  numPages: number
  /** 每页 scale=1 基础尺寸 */
  pageSizes: { w: number; h: number }[]
  loading: boolean
  loadError: string | null

  mode: ViewMode
  scale: number
  fitWidth: boolean
  currentPage: number // 1-based
  renderRange: [number, number] // 0-based 闭区间

  selection: SelectionInfo | null
  toolbarVisible: boolean

  /** 竞态守卫：词点击（click 阶段）置位，ReaderPage.onMouseUp 的 setTimeout
   *  回调读到后跳过并复位——否则会用 below=first.top>64 覆写 onWordClick
   *  刚写入的 toolbarBelow，造成顶部 64px 内工具条翻转 */
  suppressSelection: boolean

  highlightVersion: number
  annotations: ReaderAnnotation[]

  ocrBlocks: Map<number, OcrPageBlocks['blocks']>
  ocrStatus: 'none' | 'pending' | 'running' | 'done' | 'failed'
  ocrProgress: { done: number; total: number } | null
  ocrError: string | null

  linking: LinkingDraft | null

  /** 画笔会话（工具/颜色/粗细偏好保留，active 随 reset 复位） */
  ink: InkState

  searchOpen: boolean
  outlineOpen: boolean
  /** 页内搜索：当前词（小写）与聚焦命中页（0-based，null=非聚焦态） */
  searchTerm: string
  searchFocusPage: number | null
  /** 待跳转定位的批注 id（跳转后清除） */
  locateAnnotationId: number | null

  // actions
  setDoc: (paper: Paper, pdf: PDFDocumentProxy, pageSizes: { w: number; h: number }[], numPages: number) => void
  /** 懒解析回填：替换 [start, start+sizes.length) 段的页尺寸（等比占位 → 真实值） */
  appendPageSizes: (start: number, sizes: { w: number; h: number }[]) => void
  setLoading: (v: boolean) => void
  setLoadError: (e: string | null) => void
  setMode: (m: ViewMode) => void
  setScale: (s: number, fitWidth?: boolean) => void
  setCurrentPage: (p: number) => void
  setRenderRange: (r: [number, number]) => void
  setSelection: (s: SelectionInfo | null) => void
  setToolbarVisible: (v: boolean) => void
  setSuppressSelection: (v: boolean) => void
  bumpHighlight: () => void
  setAnnotations: (list: ReaderAnnotation[]) => void
  upsertAnnotation: (a: ReaderAnnotation) => void
  removeAnnotation: (id: number) => void
  setOcr: (status: ReaderState['ocrStatus'], blocks?: Map<number, OcrPageBlocks['blocks']>) => void
  setOcrProgress: (p: { done: number; total: number } | null, error?: string | null) => void
  setLinking: (l: LinkingDraft | null) => void
  updateLinking: (patch: Partial<LinkingDraft>) => void
  setInk: (patch: Partial<InkState>) => void
  toggleSearch: (v?: boolean) => void
  toggleOutline: (v?: boolean) => void
  setSearchTerm: (t: string) => void
  setSearchFocusPage: (p: number | null) => void
  setLocateAnnotation: (id: number | null) => void
  reset: () => void
}

const LS_MODE = 'pl_reader_mode'

export const useReader = create<ReaderState>((set) => ({
  paper: null,
  pdf: null,
  numPages: 0,
  pageSizes: [],
  loading: true,
  loadError: null,

  mode: (localStorage.getItem(LS_MODE) as ViewMode) || 'continuous',
  scale: 1.2,
  fitWidth: false,
  currentPage: 1,
  renderRange: [0, 4],

  selection: null,
  toolbarVisible: false,
  suppressSelection: false,

  highlightVersion: 0,
  annotations: [],

  ocrBlocks: new Map(),
  ocrStatus: 'none',
  ocrProgress: null,
  ocrError: null,

  linking: null,

  ink: { active: false, tool: 'pen', color: '#e74c3c', width: 2 },

  searchOpen: false,
  outlineOpen: false,
  searchTerm: '',
  searchFocusPage: null,
  locateAnnotationId: null,

  setDoc: (paper, pdf, pageSizes, numPages) =>
    set({ paper, pdf, numPages, pageSizes, loading: false, loadError: null }),
  appendPageSizes: (start, sizes) =>
    set((s) => {
      if (start < 0 || start + sizes.length > s.pageSizes.length) return {}
      const next = s.pageSizes.slice()
      for (let i = 0; i < sizes.length; i++) next[start + i] = sizes[i]
      return { pageSizes: next }
    }),
  setLoading: (v) => set({ loading: v }),
  setLoadError: (e) => set({ loadError: e, loading: false }),
  setMode: (m) => {
    localStorage.setItem(LS_MODE, m)
    set({ mode: m })
  },
  setScale: (s, fitWidth = false) =>
    set({ scale: Math.min(6, Math.max(0.3, Math.round(s * 100) / 100)), fitWidth }),
  setCurrentPage: (p) => set({ currentPage: p }),
  setRenderRange: (r) => set({ renderRange: r }),
  setSelection: (s) => set({ selection: s, toolbarVisible: !!s }),
  setToolbarVisible: (v) => set({ toolbarVisible: v }),
  setSuppressSelection: (v) => set({ suppressSelection: v }),
  bumpHighlight: () => set((s) => ({ highlightVersion: s.highlightVersion + 1 })),
  setAnnotations: (list) => set({ annotations: list }),
  upsertAnnotation: (a) =>
    set((s) => ({
      annotations: [...s.annotations.filter((x) => x.id !== a.id), a],
    })),
  removeAnnotation: (id) =>
    set((s) => ({
      annotations: s.annotations.filter((x) => x.id !== id),
    })),
  setOcr: (status, blocks) =>
    set((s) => ({ ocrStatus: status, ocrBlocks: blocks ?? s.ocrBlocks, ocrProgress: null })),
  setOcrProgress: (p, error = null) => set({ ocrProgress: p, ocrError: error }),
  setLinking: (l) => set({ linking: l }),
  updateLinking: (patch) =>
    set((s) => (s.linking ? { linking: { ...s.linking, ...patch } } : {})),
  setInk: (patch) => set((s) => ({ ink: { ...s.ink, ...patch } })),
  toggleSearch: (v) => set((s) => ({ searchOpen: v ?? !s.searchOpen })),
  toggleOutline: (v) => set((s) => ({ outlineOpen: v ?? !s.outlineOpen })),
  setSearchTerm: (t) => set({ searchTerm: t }),
  setSearchFocusPage: (p) => set({ searchFocusPage: p }),
  setLocateAnnotation: (id) => set({ locateAnnotationId: id }),
  reset: () => {
    pageTextCache.clear()
    set((s) => ({
      paper: null,
      pdf: null,
      numPages: 0,
      pageSizes: [],
      loading: true,
      loadError: null,
      currentPage: 1,
      renderRange: [0, 4],
      selection: null,
      toolbarVisible: false,
      suppressSelection: false,
      annotations: [],
      ocrBlocks: new Map(),
      ocrStatus: 'none',
      ocrProgress: null,
      linking: null,
      // 保留工具/颜色/粗细偏好，仅退出激活态
      ink: { ...s.ink, active: false },
      searchOpen: false,
      outlineOpen: false,
      searchTerm: '',
      searchFocusPage: null,
      locateAnnotationId: null,
    }))
  },
}))
