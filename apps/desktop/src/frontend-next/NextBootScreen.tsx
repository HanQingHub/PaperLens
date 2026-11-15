import type { CSSProperties } from 'react'
import WindowControls from '../components/layout/WindowControls'
import { APP_ICONS, resolveAppIcon } from '../features/appIcon/variants'

export default function NextBootScreen({ error, retry, animate }: { error: string | null; retry: () => void; animate: boolean }) {
  return (
    <div className={`pnx-root pnx-boot${animate ? ' pnx-boot-motion' : ''}`}>
      <WindowControls />
      <div className="pnx-boot-shelf" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ '--pnx-book': i } as CSSProperties} />)}
      </div>
      <main className="pnx-boot-copy">
        <img src={APP_ICONS[resolveAppIcon()]} alt="" />
        <span className="pnx-eyebrow">你的私人研究书房</span>
        <h1>PaperLens</h1>
        {error ? (
          <div className="pnx-boot-error" role="alert">
            <strong>书房暂时未能打开</strong>
            <p>{error}</p>
            <button className="btn btn-primary" onClick={retry}>重新连接并重试</button>
          </div>
        ) : (
          <p className="pnx-boot-status"><span aria-hidden />正在整理文献与阅读现场</p>
        )}
      </main>
      <span className="pnx-boot-foot">本地文献 · 离线阅读 · 安静思考</span>
    </div>
  )
}
