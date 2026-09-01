// PaperLens API 类型定义

export interface User {
  id: number
  username: string
  display_name: string | null
  created_at: string
}

export interface AuthResp {
  token: string
  user: User
}

export interface Project {
  id: number
  name: string
  sort_order: number
  created_at: string
  paper_count?: number
}

export interface Paper {
  id: number
  project_id: number | null
  title: string
  authors: string | null
  venue: string | null
  year: number | null
  doi: string | null
  arxiv_id: string | null
  file_hash: string
  file_type: 'pdf' | 'markdown'
  orig_filename?: string | null
  page_count: number
  open_count: number
  is_scanned: boolean
  ocr_status: 'none' | 'pending' | 'running' | 'done' | 'failed'
  tags: string[]
  note: string | null
  is_favorite: boolean
  sort_order: number
  created_at: string
  last_opened_at: string | null
  annotation_count?: number
}

export type AnnotationType = 'word_note' | 'sentence'

// 注：后端 annotations.py 返回 anchor_json / card_json（JSON 字符串）
export interface Annotation {
  id: number
  paper_id: number
  page_no: number
  type: AnnotationType
  anchor_json: string
  card_json: string | null
  color: string
  text: string
  created_at: string
  updated_at: string
}

export interface AnnotationAnchor {
  rects: [number, number, number, number][]
  text: string
}

export function parseAnchor(a: Annotation): AnnotationAnchor | null {
  try {
    return JSON.parse(a.anchor_json) as AnnotationAnchor
  } catch {
    return null
  }
}

export interface Word {
  id: number
  lemma: string
  stage: 0 | 1 | 2
  translation: string | null
  group_name: string | null
  ease: number
  interval_days: number
  due_at: string | null
  review_count: number
  first_seen_at: string
  last_seen_at: string
  occurrence_count?: number
}

export interface GlossaryTerm {
  id: number
  paper_id: number
  term: string
  domain_translation: string
  confidence: number
  source: 'tfidf' | 'user'
}

export interface DictionaryEntry {
  word: string
  pos: string | null
  phonetic: string | null
  translation: string | null
  collins_star: number | null
  tag: string | null
  exchange: string | null
  lemma: string | null
}

export interface Excerpt {
  id: number
  paper_id: number
  page_no: number
  text: string
  translation: string | null
  note: string | null
  created_at: string
}

export interface ReadingProgress {
  page_no: number
  scroll_y: number
  updated_at: string
}

export interface StatsOverview {
  today_s: number
  total_s: number
  streak: number
  calendar: { date: string; seconds: number }[]
  words_new_7d: { date: string; count: number }[]
  review_done_today: number
  review_due_today: number
}

export interface LLMModelInfo {
  id: string
  file: string
  size_bytes: number
  builtin: boolean
  downloaded: boolean
}

export interface LLMStatus {
  state: 'unloaded' | 'loading' | 'ready'
  model_id: string | null
  rss_mb: number
  last_used_at: string | null
  error?: string | null
}

export interface OcrStatus {
  status: 'none' | 'pending' | 'running' | 'done' | 'failed'
  pages_done: number
  pages_total: number
  error: string | null
}

export interface OcrPageBlocks {
  paper_id: number
  page: number
  dpi_scale: number
  blocks: {
    bbox: [number, number, number, number]
    conf: number
    text: string
    lines: { bbox: [number, number, number, number]; text: string; conf: number }[]
  }[]
}

// ── SSE 翻译事件 ────────────────────────────────────────
/** hit 事件负载（后端词典/词库/术语命中字段，均为可选） */
export interface TranslateHitData {
  translation?: string
  stage?: number
  badge?: string
  term?: string
  pos?: string | null
  phonetic?: string | null
  gloss?: string | null
}

export type TranslateEvent =
  | { event: 'hit'; layer: 'wordbook' | 'glossary' | 'cache' | 'ecdict'; data: TranslateHitData }
  | { event: 'delta'; text: string }
  | { event: 'done'; engine: string; cached: boolean }
  | { event: 'error'; code: 'llm_loading_timeout' | 'llm_timeout' | 'internal' | 'text_too_long'; detail: string }
  | { event: 'ping' }

export type AppIconVariant = 'orbit' | 'diamond'

export interface AppSettings {
  theme: 'warm' | 'light' | 'dark' | 'system'
  font_scale: number
  highlight_enabled: boolean
  highlight_style: 1 | 2 | 3
  highlight_only_current_paper: boolean
  annotation_default_color: string
  llm_model_id: string | null
  llm_unload_policy: number // 分钟；0=用完即卸 -1=常驻
  animations: boolean
  app_icon: AppIconVariant
}

// ── LLM 模型下载 SSE 事件（llm.py /download：progress|done|error）──
export type LlmDownloadEvent =
  | { event: 'progress'; downloaded: number; total_bytes: number; percent: number | null }
  | { event: 'done'; model_id: string; file: string; size_bytes: number }
  | { event: 'error'; code: string; detail: string }
