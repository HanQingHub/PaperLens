// 流式响应帧读取：按分隔符拆帧（SSE 用 '\n\n'，NDJSON 用 '\n'），
// 供 ssePost / llmDownloadStream / fetchOcrBlocks 三处共用。
// SSE 与 NDJSON 是两种协议：帧读取器按分隔符通用，事件解析只在 SSE 场景使用。

export async function* readFrames(
  res: Response,
  sep: string,
): AsyncGenerator<string, void, unknown> {
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
    let idx: number
    while ((idx = buf.indexOf(sep)) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + sep.length)
      yield frame
    }
  }
}

export interface SseFrame {
  event: string
  data: Record<string, unknown>
}

/** 解析单个 SSE 帧（event:/data: 行协议，注释行忽略）；非事件帧返回 null */
export function parseSseEvent(raw: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue // 注释/心跳
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (event === 'message' && dataLines.length === 0) return null
  const dataStr = dataLines.join('\n')
  let data: Record<string, unknown> = {}
  try {
    data = dataStr ? (JSON.parse(dataStr) as Record<string, unknown>) : {}
  } catch {
    data = { text: dataStr }
  }
  return { event, data }
}