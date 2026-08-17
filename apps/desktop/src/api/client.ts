// API 客户端：统一 Bearer 鉴权、错误处理、SSE 流
import type {
  Annotation, AppSettings, AuthResp, DictionaryEntry, Excerpt, GlossaryTerm,
  LLMModelInfo, LLMStatus, LlmDownloadEvent, OcrPageBlocks, OcrStatus, Paper, Project,
  ReadingProgress, StatsOverview, Word,
} from './types'

export const BASE = 'http://127.0.0.1:8737/api'

let token: string | null = localStorage.getItem('pl_token')
export function setToken(t: string | null) {
  token = t
  if (t) localStorage.setItem('pl_token', t)
  else localStorage.removeItem('pl_token')
}
export function getToken() {
  return token
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
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
  papers: (params: { project_id?: number; tag?: string; favorite?: boolean; q?: string; sort?: string } = {}) => {
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
  deletePaper: (id: number) => request<void>(`/papers/${id}`, { method: 'DELETE' }),
  fileToken: (id: number) => request<{ token: string; url: string }>(`/papers/${id}/file-token`, { method: 'POST' }),

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
  words: (params: { stage?: number; q?: string; due?: number } = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    })
    return request<Word[]>(`/words${q.size ? `?${q}` : ''}`)
  },
  addWord: (body: { lemma: string; translation?: string; paper_id?: number; sentence?: string; context?: string }) =>
    request<Word>('/words', { method: 'POST', body: JSON.stringify(body) }),
  updateWord: (id: number, patch: { stage?: number; translation?: string }) =>
    request<Word>(`/words/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWord: (id: number) => request<void>(`/words/${id}`, { method: 'DELETE' }),
  reviewWord: (id: number, q: 2 | 3 | 5) =>
    request<{ next_due: string; interval: number }>(`/words/${id}/review`, { method: 'POST', body: JSON.stringify({ q }) }),
  wordsExportUrl: (format: 'csv' | 'anki') => {
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
    // 导出走 fetch 拿 blob
    return request<Blob>(`/words/export?format=${format}`, { headers })
  },

  // ── 批注 ──
  annotations: (paperId: number) => request<Annotation[]>(`/papers/${paperId}/annotations`),
  addAnnotation: (paperId: number, body: Partial<Annotation>) =>
    request<Annotation>(`/papers/${paperId}/annotations`, { method: 'POST', body: JSON.stringify(body) }),
  updateAnnotation: (id: number, patch: Partial<Annotation>) =>
    request<Annotation>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAnnotation: (id: number) => request<void>(`/annotations/${id}`, { method: 'DELETE' }),
  exportAnnotationsPdf: (paperId: number) =>
    request<Blob>(`/papers/${paperId}/export-annotations-pdf`, { method: 'POST' }),
  exportAnnotationsMd: (paperId: number) =>
    request<Blob>(`/papers/${paperId}/export-annotations-md`, { method: 'POST' }),

  // ── OCR ──
  startOcr: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr`, { method: 'POST' }),
  retryOcr: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr/retry`, { method: 'POST' }),
  ocrStatus: (paperId: number) => request<OcrStatus>(`/papers/${paperId}/ocr-status`),
  ocrResult: (paperId: number) => request<OcrPageBlocks[]>(`/papers/${paperId}/ocr-result`),

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

// 触发浏览器下载
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// 具名导出（阅读器翻译卡片使用）
export const addGlossaryTerm = (paperId: number, term: string, domainTranslation: string) =>
  api.addGlossaryTerm(paperId, term, domainTranslation)

// ── 阅读器追加（reader agent）──────────────────────────────

/** PDF 文件加载地址（一次性 token 查询参数，Range 请求不消耗） */
export function pdfFileUrl(paperId: number, token: string) {
  return `${BASE}/papers/${paperId}/file?token=${encodeURIComponent(token)}`
}

/** OCR 结果是 NDJSON 流（每行一页），request() 无法解析，需单独 fetch */
export async function fetchOcrBlocks(paperId: number): Promise<import('./types').OcrPageBlocks[]> {
  const res = await fetch(`${BASE}/papers/${paperId}/ocr-result`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''))
  const text = await res.text()
  const pages: import('./types').OcrPageBlocks[] = []
  for (const line of text.split('\n')) {
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

// LLM 模型下载 SSE（fetch + ReadableStream 解析，参考 sse.ts 模式）
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
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length === 0) continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(dataLines.join('\n'))
      } catch {
        continue
      }
      if (event === 'progress') {
        yield {
          event: 'progress',
          downloaded: Number(data.downloaded) || 0,
          total_bytes: Number(data.total_bytes) || 0,
          percent: data.percent == null ? null : Number(data.percent),
        }
      } else if (event === 'done') {
        yield {
          event: 'done',
          model_id: String(data.model_id ?? ''),
          file: String(data.file ?? ''),
          size_bytes: Number(data.size_bytes) || 0,
        }
      } else if (event === 'error') {
        yield { event: 'error', code: String(data.code ?? 'internal'), detail: String(data.detail ?? '') }
      }
    }
  }
}
