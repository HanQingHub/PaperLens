// 生词库 store：高亮匹配用 lemma→stage 集合
import { create } from 'zustand'
import { api } from '../api/client'
import type { Word } from '../api/types'

interface WordsState {
  words: Word[]
  /** lemma 小写 → stage 映射 */
  stageMap: Map<string, 0 | 1 | 2>
  loaded: boolean
  load: () => Promise<void>
  stageOf: (lemma: string) => 0 | 1 | 2 | undefined
  bump: (word: Word) => void
  remove: (id: number) => void
}

export const useWords = create<WordsState>((set, get) => ({
  words: [],
  stageMap: new Map(),
  loaded: false,
  load: async () => {
    const words = await api.words()
    const stageMap = new Map<string, 0 | 1 | 2>()
    for (const w of words) stageMap.set(w.lemma.toLowerCase(), w.stage)
    set({ words, stageMap, loaded: true })
  },
  stageOf: (lemma) => get().stageMap.get(lemma.toLowerCase()),
  bump: (word) =>
    set((s) => {
      const stageMap = new Map(s.stageMap)
      stageMap.set(word.lemma.toLowerCase(), word.stage)
      return { words: [...s.words.filter((w) => w.id !== word.id), word], stageMap }
    }),
  remove: (id) =>
    set((s) => {
      const target = s.words.find((w) => w.id === id)
      const stageMap = new Map(s.stageMap)
      if (target) stageMap.delete(target.lemma.toLowerCase())
      return { words: s.words.filter((w) => w.id !== id), stageMap }
    }),
}))
