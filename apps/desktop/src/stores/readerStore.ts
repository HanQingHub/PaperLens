// 阅读器私有状态：文档/页码/缩放/模式/选区/批注/OCR
import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OcrPageBlocks, Paper } from '../api/types'
import type { AnnotationRaw } from '../api/client'

export type PdfRect = [number, number, number, number]
export type ViewMode = 'single' | 'continuous'
export const ANNO_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const
export type AnnoColor = (typeof ANNO_COLORS)[number]

export interface SelectionInfo {
  text: string
  pageIndex: number
  rects: PdfRect[] // PDF 用户空间
  sentence: string
  prev: string
  next: string
  /** 工具条定位（相对阅读器容器的坐标） */
  toolbarX: number
  toolbarY: number
  toolbarBelow: boolean
}

export interface ReaderAnnotation {
  id: number
  page_no: number
  type: 'word_note' | 'sentence'
  rects: PdfRect[]
  anchorText: string
  card: { x: number; y: number; w: number; h: number } | null
  color: AnnoColor | string
  text: string
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

  highlightVersion: number
  annotations: ReaderAnnotation[]

  ocrBlocks: Map<number, OcrPageBlocks['blocks']>
  ocrStatus: 'none' | 'pending' | 'running' | 'done' | 'failed'
  ocrProgress: { done: number; total: number } | null
  ocrError: string | null

  linking: LinkingDraft | null

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
  bumpHighlight: () => void
  setAnnotations: (list: ReaderAnnotation[]) => void
  upsertAnnotation: (a: ReaderAnnotation) => void
  removeAnnotation: (id: number) => void
  setOcr: (status: ReaderState['ocrStatus'], blocks?: Map<number, OcrPageBlocks['blocks']>) => void
  setOcrProgress: (p: { done: number; total: number } | null, error?: string | null) => void
  setLinking: (l: LinkingDraft | null) => void
  updateLinking: (patch: Partial<LinkingDraft>) => void
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

  highlightVersion: 0,
  annotations: [],

  ocrBlocks: new Map(),
  ocrStatus: 'none',
  ocrProgress: null,
  ocrError: null,

  linking: null,

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
  toggleSearch: (v) => set((s) => ({ searchOpen: v ?? !s.searchOpen })),
  toggleOutline: (v) => set((s) => ({ outlineOpen: v ?? !s.outlineOpen })),
  setSearchTerm: (t) => set({ searchTerm: t }),
  setSearchFocusPage: (p) => set({ searchFocusPage: p }),
  setLocateAnnotation: (id) => set({ locateAnnotationId: id }),
  reset: () => {
    pageTextCache.clear()
    set({
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
      annotations: [],
      ocrBlocks: new Map(),
      ocrStatus: 'none',
      ocrProgress: null,
      linking: null,
      searchOpen: false,
      outlineOpen: false,
      searchTerm: '',
      searchFocusPage: null,
      locateAnnotationId: null,
    })
  },
}))
