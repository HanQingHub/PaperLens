// 根级错误边界：渲染期异常不再让 React 卸载整树变白屏，
// 而是显示可恢复的错误卡片（含错误信息，兼作后续异常定位的出口）
import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[PaperLens] 渲染异常：', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--danger)]/10">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4 M12 17h.01 M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-medium">界面出现异常</p>
            <p className="mt-1 max-w-[480px] break-all font-mono text-xs leading-5 text-text-faint">
              {this.state.error.message || String(this.state.error)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              重试
            </button>
            <button className="btn" onClick={() => window.location.assign('/')}>
              返回文库
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
