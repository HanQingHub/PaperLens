// 词形归一与规则还原：lowercase + 规则变体多候选，与词库求交集
// 不规则形态经 GET /api/dictionary/{lemma} 验证（异步缓存，可选增强）
import { api } from '../../api/client'

/** 规则还原候选（含原词小写）；多候选由调用方与词库 Set 求交集 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase()
  const out = new Set<string>([w])
  if (w.length < 4) return [...out]
  // -ing → 去 e 加 ing 还原：computing→compute, studying→study, running→run
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3)
    out.add(stem)
    out.add(stem + 'e')
    out.add(stem.replace(/i$/, '') + 'y') // studying → study（stem=study? study-3=stud, stud+y）
    out.add(w.slice(0, -4)) // running → run（双写辅音）
  }
  // -ed / -d：trained→train, networks→network（-s 不在此）
  if (w.endsWith('ed')) {
    out.add(w.slice(0, -2)) // trained→train? train+ed → traine? slice(-2) 去掉 ed → train
    out.add(w.slice(0, -1)) // filed→file
    out.add(w.slice(0, -3)) // stopped→stop（双写）
  } else if (w.endsWith('d') && !w.endsWith('ed')) {
    out.add(w.slice(0, -1))
  }
  // -es / -s：studies→study, networks→network
  if (w.endsWith('ies')) {
    out.add(w.slice(0, -3) + 'y')
  } else if (w.endsWith('es')) {
    out.add(w.slice(0, -2))
    out.add(w.slice(0, -1))
  } else if (w.endsWith('s') && !w.endsWith('ss')) {
    out.add(w.slice(0, -1))
  }
  // -er / -est：faster→fast
  if (w.endsWith('iest')) {
    out.add(w.slice(0, -4) + 'y')
  } else if (w.endsWith('est')) {
    out.add(w.slice(0, -3))
    out.add(w.slice(0, -2))
  } else if (w.endsWith('ier')) {
    out.add(w.slice(0, -3) + 'y')
  } else if (w.endsWith('er') && !w.endsWith('eer')) {
    out.add(w.slice(0, -2))
    out.add(w.slice(0, -1))
  }
  return [...out]
}

/** 词库查档：候选依序与 stageMap 求交集 */
export function lookupStage(word: string, stageMap: Map<string, 0 | 1 | 2>): 0 | 1 | 2 | undefined {
  for (const c of lemmaCandidates(word)) {
    const s = stageMap.get(c)
    if (s !== undefined) return s
  }
  return undefined
}

// 不规则词形缓存：word → 词库命中的 lemma（null = 已查无）
const irregularCache = new Map<string, string | null>()

/** 异步归一化：规则候选未命中时查 dictionary（server 侧 lemma.en.txt 词形库），返回词库中真实存在的 lemma */
export async function resolveLemma(word: string, stageMap: Map<string, 0 | 1 | 2>): Promise<string | null> {
  const lower = word.toLowerCase()
  for (const c of lemmaCandidates(lower)) {
    if (stageMap.has(c)) return c
  }
  if (irregularCache.has(lower)) {
    const hit = irregularCache.get(lower)
    return hit != null && stageMap.has(hit) ? hit : null
  }
  let result: string | null = null
  try {
    const entry = await api.dictionary(encodeURIComponent(lower))
    const lemma = entry.lemma?.toLowerCase()
    if (lemma && stageMap.has(lemma)) result = lemma
  } catch {
    /* 404 或网络异常：缓存为 null，正文高亮跳过不规则词 */
  }
  irregularCache.set(lower, result)
  return result
}

export function clearIrregularCache() {
  irregularCache.clear()
}
