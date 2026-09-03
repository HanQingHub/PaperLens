// 全局页签栏（AppShell 头部行，与账号/退出登录同一行）：
// 文库 / 生词复习 / 设置 / 论文四类页签；活动态由当前路由派生；
// 点击切换（路由导航），× / 中键关闭；文字 truncate + 横向滚动防溢出。
import { useLocation, useNavigate } from 'react-router-dom'
import { useReaderTabs } from '../../stores/readerTabs'
import { useCompareStore } from '../../stores/compareStore'
import { guardMdNav, pidFromPath } from './mdDirty'
import { routeOf, tabIdFromPath, type AppTab } from '../../features/reader/tabOps'

const KIND_LABEL: Record<string, string> = {
  library: '文库',
  review: '生词复习',
  settings: '设置',
}

export default function TabBar() {
  const tabs = useReaderTabs((s) => s.tabs)
  const navigate = useNavigate()
  const location = useLocation()
  const currentId = tabIdFromPath(location.pathname)

  const close = (tab: AppTab) => {
    const run = () => {
      const nextRoute = useReaderTabs.getState().closeTab(tab.id, currentId)
      // 关闭对照源页签后不留幽灵对照窗格（删除论文路径已由 LibraryPage 联动清理）
      if (tab.kind === 'reader' && tab.paperId != null && useCompareStore.getState().paperId === tab.paperId) {
        useCompareStore.getState().setPaper(null)
      }
      if (nextRoute != null) navigate(nextRoute)
    }
    // 关的正是脏 MD 签才拦（关别签不卸载脏文档；固定签传 -1 永不命中）；变异在确认后执行
    if (!guardMdNav(run, tab.kind === 'reader' ? (tab.paperId ?? -1) : -1)) run()
  }

  const goto = (tab: AppTab) => {
    const r = routeOf(tab)
    if (r === location.pathname) return
    const run = () => navigate(r)
    // 仅当正在离开脏 MD 路由才拦
    if (!guardMdNav(run, pidFromPath(location.pathname))) run()
  }

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((t) => {
        const active = t.id === currentId
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`tab-item ${active ? 'tab-item--active' : ''}`}
            title={t.title}
            onClick={() => goto(t)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(t)
              }
            }}
          >
            {t.kind === 'reader' && t.fileType === 'markdown' && <span className="tab-item-type">MD</span>}
            <span className="tab-item-title">{t.kind === 'reader' ? t.title || '…' : (KIND_LABEL[t.kind] ?? t.title)}</span>
            <span
              className="tab-close"
              title="关闭页签"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                close(t)
              }}
            >
              ✕
            </span>
          </div>
        )
      })}
    </div>
  )
}
