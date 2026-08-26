// API 客户端：统一 Bearer 鉴权、错误处理、SSE 流
import type {
  Annotation, AppSettings, AuthResp, DictionaryEntry, Excerpt, GlossaryTerm,
  LLMModelInfo, LLMStatus, LlmDownloadEvent, OcrPageBlocks, OcrStatus, Paper, Project,
  ReadingProgress, StatsOverview, Word,
} from './types'
import { parseSseEvent, readFrames } from './stream'

// 生产/开发共用同一后端地址；vite dev 走 /api 代理（见 vite.config.ts 交叉引用）
export const BASE = `${import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8737'}/api`

let token: string | null = localStorage.getItem('pl_token')
export function setToken(t: string | null) {
  token = t
  if (t) localStorage.setItem('pl_token', t)
  else localStorage.removeItem('pl_token')
}
export function getToken() {
  return token
}

/** 401 统一处理回调（App 注册：登出 + toast）；登录/登出接口自身除外 */
let unauthorizedHandler: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** 等待后端就绪（启动期 server 未起时 connection refused，本机回环失败零成本）。
 *  超时抛错，由调用方决定降级界面；ready 判定即 health 200（lifespan 完成后才 bind）。 */
export async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch {
      /* not ready yet */
    }
    if (Date.now() - start >= timeoutMs) throw new Error('后端启动超时')
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T
  // 401 统一处理：会话失效（登录/注册 401 是业务错误，登出 401 会递归）
  if (res.status === 401 && !/^\/auth\/(login|register|logout)/.test(path)) {
    unauthorizedHandler?.()
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const data = await res.json()
    if (!res.ok) throw new ApiError(res.status, data.detail ?? JSON.stringify(data))
    return data as T
  }
  // 文件下载
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return (await res.blob()) as unknown as T
}

export const api = {
  // ── 账号 ──
  register: (username: string, password: string) =>
    request<AuthResp>('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string, remember: boolean) =>
    request<AuthResp>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: AuthResp['user']; settings: AppSettings }>('/me'),

  // ── 项目 ──
  projects: () => request<Project[]>('/projects'),
  createProject: (name: string) => request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  updateProject: (id: number, patch: Partial<Project>) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  // ── 论文 ──
  papers: (params: { project_id?: number; tag?: string; favorite?: boolean; q?: string; sort?: 'created' | 'title' | 'last_opened' | 'manual' } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    })
    return request<Paper[]>(`/papers${q.size ? `?${q}` : ''}`)
  },
  paper: (id: number) => request<Paper>(`/papers/${id}`),
  uploadPaper: (file: File, projectId: number | null, isScanned: boolean) => {
    const fd = new FormData()
    fd.append('file', file)
    if (projectId != null) fd.append('project_id', String(projectId))
    fd.append('is_scanned', String(isScanned))
    return request<{ paper: Paper }>('/papers/upload', { method: 'POST', body: fd })
  },
  updatePaper: (id: number, patch: Partial<Paper>) =>
    request<Paper>(`/papers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  extractMeta: (id: number) => request<Paper>(`/papers/${id}/extract-meta`, { method: 'POST' }),
  deletePaper: (id: number) => request<void>(`/papers/${id}`, { method: 'DELETE' }),
  fileToken: (id: number) => request<{ token: string; url: string }>(`/papers/${id}/file-token`, { method: 'POST' }),
  importArxiv: (arxivId: string) =>
    request<Paper>('/papers/arxiv', { method: 'POST', body: JSON.stringify({ arxiv_id: arxivId }) }),

  // ── 账号资料 / 查词历史 ──
  updateProfile: (displayName: string) =>
    request<{ id: number; username: string; display_name: string }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: displayName }),
    }),
  translateHistory: (limit = 50) =>
    request<{ id: number; word: string; sentence: string | null; mode: string; result: Record<string, unknown>; created_at: string }[]>(
      `/translate/history?limit=${limit}`,
    ),
  wordGroups: () => request<{ name: string; count: number }[]>('/words/groups'),

  // ── 词典 / 术语表 ──
  dictionary: (word: string) => request<DictionaryEntry>(`/dictionary/${encodeURIComponent(word)}`),
  glossary: (paperId: number) => request<GlossaryTerm[]>(`/papers/${paperId}/glossary`),
  addGlossaryTerm: (paperId: number, term: string, domainTranslation: string) =>
    request<GlossaryTerm>('/glossary/terms', {
      method: 'POST',
      body: JSON.stringify({ paper_id: paperId, term, domain_translation: domainTranslation }),
    }),
  deleteGlossaryTerm: (id: number) => request<void>(`/glossary/terms/${id}`, { method: 'DELETE' }),

  // ── 生词 ──
  words: (params: { stage?: number; q?: string; due?: number; group?: string } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    })
    return request<Word[]>(`/words${q.size ? `?${q}` : ''}`)
  },
  addWord: (body: { lemma: string; translation?: string; paper_id?: number; sentence?: string; context?: string }) =>
    request<Word>('/words', { method: 'POST', body: JSON.stringify(body) }),
  updateWord: (id: number, patch: { stage?: number; translation?: string; group_name?: string }) =>
    request<Word>(`/words/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWord: (id: number) => request<void>(`/words/${id}`, { method: 'DELETE' }),
  reviewWord: (id: number, q: 2 | 3 | 5) =>
    request<{ next_due: string; interval: number; word: Word }>(`/words/${id}/review`, { method: 'POST', body: JSON.stringify({ q }) }),
  wordsExportUrl: (format: 'csv' | 'anki') => {
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
    // 导出走 fetch 拿 blob
    return request<Blob>(`/words/export?format=${format}`, { headers })
  },

  // ── 批注 ──
  annotations: (paperId: number) => request<Annotation[]>(`/papers/${paperId}/annotations`),
  updateAnnotation: (id: number, patch: Partial<Annotation>) =>
    request<Annotation>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAnnotation: (id: number) => request<void>(`/annotations/${id}`, { method: 'DELETE' }),
  exportAnnotationsPdf: (paperId: number, filter?: { color?: string; type?: string }) => {
    const q = new URLSearchParams()
    if (filter?.color) q.set('color', filter.color)
    if (filter?.type) q.set('type', filter.type)
    return request<Blob>(`/papers/${paperId}/export-annotations-pdf${q.size ? `?${q}` : ''}`, { method: 'POST' })
  },
  exportAnnotationsMd: (paperId: number, filter?: { color?: string; type?: string }) => {
    const q = new URLSearchParams()
    if (filter?.color) q.set('color', filter.color)
    if (filter?.type) q.set('type', filter.type)
    return request<Blob>(`/papers/${paperId}/export-annotations-md${q.size ? `?${q}` : ''}`, { method: 'POST' })
  },

  // ── OCR ──
  startOcr: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr`, { method: 'POST' }),
  retryOcr: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr/retry`, { method: 'POST' }),
  ocrStatus: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr-status`),
  ocrResult: (paperId: number) => request<OcrPageBlocks[]>(`/papers/${paperId}/ocr-result`),
  ocrQueue: () => request<{ paused: boolean; pending: number }>('/ocr/queue'),
  ocrQueuePause: (paused: boolean) => request<{ paused: boolean }>('/ocr/queue/pause', { method: 'POST', body: JSON.stringify({ paused }) }),
  cancelOcr: (paperId: number) => request<{ status: string }>(`/papers/${paperId}/ocr/cancel`, { method: 'POST' }),

  // ── 阅读与统计 ──
  readingProgress: (paperId: number) => request<ReadingProgress | null>(`/reading-progress/${paperId}`),
  saveReadingProgress: (paperId: number, page_no: number, scroll_y: number) =>
    request<void>(`/reading-progress/${paperId}`, { method: 'PUT', body: JSON.stringify({ page_no, scroll_y }) }),
  readingSession: (paperId: number, start_at: string, end_at: string) =>
    request<void>('/reading-sessions', { method: 'POST', body: JSON.stringify({ paper_id: paperId, start_at, end_at }) }),
  stats: () => request<StatsOverview>('/stats/overview'),

  // ── 摘录 ──
  excerpts: (paperId?: number) =>
    request<Excerpt[]>(`/excerpts${paperId ? `?paper_id=${paperId}` : ''}`),
  addExcerpt: (body: { paper_id: number; page_no: number; text: string; translation?: string; note?: string }) =>
    request<Excerpt>('/excerpts', { method: 'POST', body: JSON.stringify(body) }),
  deleteExcerpt: (id: number) => request<void>(`/excerpts/${id}`, { method: 'DELETE' }),
  exportExcerpts: (paperId?: number) =>
    request<Blob>(`/excerpts/export${paperId ? `?paper_id=${paperId}` : ''}`, { method: 'POST' }),

  // ── 备份 / 设置 / 缓存 ──
  backupExport: () => request<Blob>('/backup/export', { method: 'POST' }),
  backupImport: (zip: File) => {
    const fd = new FormData()
    fd.append('file', zip)
    return request<{ report: string[] }>('/backup/import', { method: 'POST', body: fd })
  },
  settings: () => request<AppSettings>('/settings'),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  migrateDataDir: (target: string) =>
    request<{ ok: boolean; path: string }>('/data-dir/migrate', { method: 'POST', body: JSON.stringify({ target }) }),
  clearCache: (type: 'ocr' | 'translate') => request<{ freed_bytes: number }>(`/cache/${type}`, { method: 'DELETE' }),

  // ── LLM ──
  llmModels: () => request<LLMModelInfo[]>('/llm/models'),
  // 模型下载为 SSE 流（progress/done/error），见文件末尾 llmDownloadStream
  llmDownloadStream: (modelId: string) => llmDownloadStream(modelId),
  llmImport: (gguf: File) => {
    const fd = new FormData()
    fd.append('file', gguf)
    return request<LLMModelInfo>('/llm/import', { method: 'POST', body: fd })
  },
  llmLoad: (modelId: string) => request<void>('/llm/load', { method: 'POST', body: JSON.stringify({ model_id: modelId }) }),
  llmUnload: () => request<void>('/llm/unload', { method: 'POST' }),
  llmStatus: () => request<LLMStatus>('/llm/status'),
}

// 弹"另存为"对话框保存（Tauri dialog + fs 插件）；用户取消返回 false
export async function saveBlobWithDialog(blob: Blob, defaultName: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const path = await save({ defaultPath: defaultName })
  if (!path) return false
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
  return true
}

// 具名导出（阅读器翻译卡片使用）
export const addGlossaryTerm = (paperId: number, term: string, domainTranslation: string) =>
  api.addGlossaryTerm(paperId, term, domainTranslation)

// ── 阅读器追加 ───────────────────────────────────────────

/** PDF 文件加载地址（一次性 token 查询参数，Range 请求不消耗） */
export function pdfFileUrl(paperId: number, token: string) {
  return `${BASE}/papers/${paperId}/file?token=${encodeURIComponent(token)}`
}

/** OCR 结果是 NDJSON 流（每行一页），request() 无法解析，需单独 fetch */
export async function fetchOcrBlocks(paperId: number): Promise<OcrPageBlocks[]> {
  const res = await fetch(`${BASE}/papers/${paperId}/ocr-result`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''))
  const pages: OcrPageBlocks[] = []
  for await (const line of readFrames(res, '\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      pages.push(JSON.parse(t))
    } catch {
      /* 跳过损坏行 */
    }
  }
  return pages
}

export interface AnnotationRaw {
  id: number
  paper_id: number
  page_no: number
  type: 'word_note' | 'sentence'
  anchor_json: string
  card_json: string | null
  color: string
  text: string
  created_at: string
  updated_at: string
}

export interface AnnotationWrite {
  page_no: number
  type: 'word_note' | 'sentence'
  anchor_json: string
  card_json?: string | null
  color?: string
  text?: string
}

/** 后端批注字段为 anchor_json/card_json 字符串（与 types.ts 的 Annotation 结构不同） */
export function createAnnotation(paperId: number, body: AnnotationWrite) {
  return request<AnnotationRaw>(`/papers/${paperId}/annotations`, { method: 'POST', body: JSON.stringify(body) })
}

export function patchAnnotation(
  id: number,
  patch: Partial<Pick<AnnotationWrite, 'card_json' | 'color' | 'text' | 'page_no'>>,
) {
  return request<AnnotationRaw>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** 阅读进度（open=true 时服务端 open_count+1，仅进入时调用一次） */
export function saveProgress(paperId: number, page_no: number, scroll_y: number, open = false) {
  return request<{ page_no: number }>(`/reading-progress/${paperId}`, {
    method: 'PUT',
    body: JSON.stringify({ page_no, scroll_y, open }),
  })
}

// LLM 模型下载 SSE（fetch + ReadableStream 解析，共享帧读取器见 stream.ts）
export async function* llmDownloadStream(
  modelId: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<LlmDownloadEvent, void, unknown> {
  const res = await fetch(`${BASE}/llm/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ model_id: modelId }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `HTTP ${res.status}`)
  }
  for await (const raw of readFrames(res, '\n\n')) {
    const frame = parseSseEvent(raw)
    if (!frame) continue
    const data = frame.data
    if (frame.event === 'progress') {
      yield {
        event: 'progress',
        downloaded: Number(data.downloaded) || 0,
        total_bytes: Number(data.total_bytes) || 0,
        percent: data.percent == null ? null : Number(data.percent),
      }
    } else if (frame.event === 'done') {
      yield {
        event: 'done',
        model_id: String(data.model_id ?? ''),
        file: String(data.file ?? ''),
        size_bytes: Number(data.size_bytes) || 0,
      }
    } else if (frame.event === 'error') {
      yield { event: 'error', code: String(data.code ?? 'internal'), detail: String(data.detail ?? '') }
    }
  }
}
