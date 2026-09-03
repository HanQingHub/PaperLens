// MD 未保存脏态注册表（无 React 依赖，供 TabBar/侧栏/返回按钮/登出/删文同步查询）。
// 脏检查必须在一切变异（closeTab/navigate/logout/delete）之前；确认后才执行意图。
let dirtyPaperId: number | null = null

export function setMdDirty(paperId: number | null) {
  dirtyPaperId = paperId
}

export function getMdDirty(): number | null {
  return dirtyPaperId
}

export function clearMdDirty() {
  dirtyPaperId = null
}

/** 单例待定导航（全局同时至多一个确认框；后意图覆盖先前的） */
export interface PendingNav {
  run: () => void
}

let pending: PendingNav | null = null

type Listener = () => void
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((fn) => fn())
}

/** 供确认框订阅（AppShell 单例渲染） */
export function subscribeMdGuard(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function hasPendingNav(): boolean {
  return pending != null
}

export function setPendingNav(p: PendingNav | null) {
  pending = p
  emit()
}

export function takePendingNav(): PendingNav | null {
  const p = pending
  if (p) {
    pending = null
    emit()
  }
  return p
}

/**
 * 脏检查门禁：返回 true=已拦截（意图已存，确认框会弹），false=无脏直接放行。
 * leavingPid：正在离开的论文路由 pid（TabBar/侧栏/返回按钮传入，仅当离开的正是脏文档才拦；
 * 登出/删文等整树级操作不传，脏即拦）。
 */
export function guardMdNav(run: () => void, leavingPid?: number | null): boolean {
  const dirty = dirtyPaperId
  if (dirty == null) return false
  if (leavingPid != null && leavingPid !== dirty) return false
  setPendingNav({ run })
  return true
}

/** 确认放弃：先清脏再执行意图（否则意图内的导航触发新的脏检查） */
export function confirmPendingNav() {
  const p = takePendingNav()
  clearMdDirty()
  p?.run()
}

/** 从路由派生正整数 pid（非 /reader/:id 返回 null） */
export function pidFromPath(path: string): number | null {
  const m = /^\/reader\/(\d+)(?:\/)?$/.exec(path)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}
