import WindowControls from '../components/layout/WindowControls'
import { APP_ICONS, resolveAppIcon } from '../features/appIcon/variants'
import NextStrataSlices from './NextStrataSlices'
import { useStrataDocument } from './strataDocument'

export default function NextBootScreen({ error, retry, animate }: { error: string | null; retry: () => void; animate: boolean }) {
  useStrataDocument()
  return (
    <div className={`pnx-root pnx-boot pnx-sx-boot${animate ? ' pnx-boot-motion' : ''}`}>
      <WindowControls />
      <div className="pnx-sx-boot-rule" aria-hidden><span>PAPERLENS / 研究阅读系统</span><span>STRATA · LOCAL</span></div>
      <div className="pnx-sx-boot-art"><NextStrataSlices size="sm" motion={animate} /></div>
      <main className="pnx-boot-copy pnx-sx-boot-copy">
        <img src={APP_ICONS[resolveAppIcon()]} alt="" />
        <span className="pnx-eyebrow">层析 STRATA</span>
        <h1>PaperLens</h1>
        {error ? (
          <div className="pnx-boot-error" role="alert">
            <strong>暂时未能连接本地服务</strong>
            <p>{error}</p>
            <button className="btn btn-primary" onClick={retry}>重新连接并重试</button>
          </div>
        ) : (
          <p className="pnx-boot-status"><span aria-hidden />正在建立本地索引</p>
        )}
      </main>
      <span className="pnx-boot-foot">本地 · 离线 · 可追溯</span>
    </div>
  )
}
