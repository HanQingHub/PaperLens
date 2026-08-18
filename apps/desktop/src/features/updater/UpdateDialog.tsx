// 更新对话框：发现新版本 / 下载进度 / 就绪安装 / 失败重试
import Modal from '../shared/Modal'
import { useUpdater } from '../../stores/updater'

function fmtMB(bytes: number): string {
  return `${(bytes / (1 << 20)).toFixed(1)} MB`
}

export default function UpdateDialog() {
  const { phase, dialogOpen, setDialogOpen, update, currentVersion, progress, error, download, install } = useUpdater()
  if (!update) return null

  const v = update.version
  const percent =
    progress && progress.total ? Math.min(100, (progress.downloaded / progress.total) * 100) : null

  let footer: React.ReactNode
  if (phase === 'downloading') {
    footer = (
      <button className="btn px-3 py-1.5 text-xs" onClick={() => setDialogOpen(false)}>
        后台下载
      </button>
    )
  } else if (phase === 'ready') {
    footer = (
      <>
        <button className="btn px-3 py-1.5 text-xs" onClick={() => setDialogOpen(false)}>
          稍后
        </button>
        <button className="btn btn-primary px-3 py-1.5 text-xs" onClick={install}>
          重启并安装
        </button>
      </>
    )
  } else if (phase === 'error') {
    footer = (
      <>
        <button className="btn px-3 py-1.5 text-xs" onClick={() => setDialogOpen(false)}>
          关闭
        </button>
        <button className="btn btn-primary px-3 py-1.5 text-xs" onClick={download}>
          重试下载
        </button>
      </>
    )
  } else {
    footer = (
      <>
        <button className="btn px-3 py-1.5 text-xs" onClick={() => setDialogOpen(false)}>
          稍后
        </button>
        <button className="btn btn-primary px-3 py-1.5 text-xs" onClick={download}>
          立即更新
        </button>
      </>
    )
  }

  return (
    <Modal
      open={dialogOpen}
      title={phase === 'ready' ? `更新就绪 · v${v}` : `发现新版本 · v${v}`}
      onClose={() => setDialogOpen(false)}
      footer={footer}
    >
      <div className="flex flex-col gap-3 text-[13px] leading-6">
        {phase === 'ready' ? (
          <p>
            v{v} 已下载完成并验签通过。点击「重启并安装」后应用将退出并静默完成升级
            （个人数据与词典/模型资源不受影响），随后自动启动新版本。
          </p>
        ) : (
          <p>
            当前版本 v{currentVersion}，可升级到 <span className="font-medium text-accent">v{v}</span>
            。更新仅替换程序本体（约 60MB），数据目录与内置词典/模型保持不变。
          </p>
        )}

        {update.notes && phase !== 'ready' && (
          <div className="rounded-lg border border-border bg-panel-soft px-3 py-2.5">
            <div className="mb-1 text-[11.5px] font-medium text-text-faint">更新日志</div>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12.5px]">{update.notes}</div>
          </div>
        )}

        {phase === 'downloading' && (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft">
              <div
                className="pl-progress h-full rounded-full transition-[width] duration-300"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-text-faint">
              {percent != null ? `${percent.toFixed(1)}% · ` : ''}
              {progress ? `${fmtMB(progress.downloaded)}${progress.total ? ` / ${fmtMB(progress.total)}` : ''}` : ''}
            </div>
          </div>
        )}

        {phase === 'error' && error && (
          <p
            className="rounded-lg border px-3 py-2 text-[12.5px]"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
