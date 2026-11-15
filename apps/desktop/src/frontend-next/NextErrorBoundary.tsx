import React from 'react'
import WindowControls from '../components/layout/WindowControls'
import { setFrontendStyle } from './stylePreference'

interface State { error: Error | null }

export default class NextErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[PaperLens Next] 渲染异常：', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="pnx-root pnx-fallback">
        <WindowControls />
        <div className="pnx-fallback-card" role="alert">
          <span className="pnx-eyebrow">界面保护</span>
          <h1>全新界面暂时无法显示</h1>
          <p>你的论文、阅读进度与设置仍然保留。可以重试，或立即切回经典界面。</p>
          <code>{this.state.error.message}</code>
          <div className="pnx-row">
            <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>重试新界面</button>
            <button className="btn" onClick={() => setFrontendStyle('classic')}>切回经典界面</button>
          </div>
        </div>
      </div>
    )
  }
}
