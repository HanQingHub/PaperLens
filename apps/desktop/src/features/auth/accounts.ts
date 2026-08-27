// 最近本机账号持久化工具（pl_accounts，LRU 3 个；明文 token 与 pl_token 同一信任边界）
// 独立模块：供 features/auth/AuthPage 与 stores/auth 共用，避免 store↔组件循环依赖

export interface SavedAccount {
  username: string
  display_name: string
  token: string
  at: number
}

export function loadAccounts(): SavedAccount[] {
  try {
    const arr = JSON.parse(localStorage.getItem('pl_accounts') ?? '[]')
    return Array.isArray(arr) ? arr.slice(0, 3) : []
  } catch {
    return []
  }
}

export function upsertAccount(a: SavedAccount) {
  const rest = loadAccounts().filter((x) => x.username !== a.username)
  localStorage.setItem('pl_accounts', JSON.stringify([a, ...rest].slice(0, 3)))
}

export function removeAccount(username: string) {
  localStorage.setItem('pl_accounts', JSON.stringify(loadAccounts().filter((x) => x.username !== username)))
}
