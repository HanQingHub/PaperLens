// 更新模块启动入口：
// 1. 启动自检（Rust startup_check）：安装版本 vs 应用版本不一致 → “上次更新未完成”；
//    resources 缺失 → 引导重装全量包（P1-6）
// 2. 启动 3s 后按策略后台检查更新（关闭/询问/自动下载，默认询问）
// 浏览器 dev 模式（isTauri=false）下全部 no-op。
import { useEffect, useState } from 'react'
import Modal from '../shared/Modal'
import { updaterAvailable, type StartupCheckResult } from './updaterCore'
import { bootStartupCheck, useUpdater } from '../../stores/updater'
import UpdateDialog from './UpdateDialog'

function StartupWarning({ result, onClose }: { result: StartupCheckResult; onClose: () => void }) {
  return (
    <Modal open title="启动自检发现异常" onClose={onClose} width={480}
      footer={<button className="btn btn-primary px-3 py-1.5 text-xs" onClick={onClose}>知道了</button>}>
      <div className="flex flex-col gap-2.5 text-[13px] leading-6">
        {result.versionMismatch && (
          <p>
            检测到安装版本（v{result.installedVersion}）与应用版本（v{result.appVersion}）不一致，
            上次自动更新可能未完成。请在
            <span className="text-accent"> 设置 → 应用更新 </span>
            中重新检查并完成更新；若反复失败，请下载全量安装包覆盖安装。
          </p>
        )}
        {result.missingResources.length > 0 && (
          <p style={{ color: 'var(--danger)' }}>
            安装目录资源缺失：{result.missingResources.join('、')}。
            词典/模型/OCR 功能可能不可用，请下载全量安装包覆盖安装以修复。
          </p>
        )}
      </div>
    </Modal>
  )
}

export default function UpdaterBoot() {
  const policy = useUpdater((s) => s.policy)
  const check = useUpdater((s) => s.check)
  const [warning, setWarning] = useState<StartupCheckResult | null>(null)

  useEffect(() => {
    if (!updaterAvailable()) return

    // 启动自检：失败静默，不阻塞启动（验收标准 5）
    bootStartupCheck().then((r) => {
      if (r && (r.versionMismatch || r.missingResources.length > 0)) setWarning(r)
    })

    // 后台自动检查：延迟 3s，策略为“关闭”时不查
    if (policy !== 'off') {
      const t = setTimeout(() => check({ manual: false }), 3000)
      return () => clearTimeout(t)
    }
    // 仅启动时执行一次（policy 为初始 localStorage 快照，避免重复触发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {warning && <StartupWarning result={warning} onClose={() => setWarning(null)} />}
      <UpdateDialog />
    </>
  )
}
