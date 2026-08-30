// 自动更新：tauri-plugin-updater 薄封装。
// 浏览器 dev 模式（vite 直连、无 Tauri 壳）下所有调用前必须先判 updaterAvailable()。
import { isTauri, invoke } from '@tauri-apps/api/core'
import { check as pluginCheck, type Update } from '@tauri-apps/plugin-updater'

/** 远端更新描述（check 返回的非空结果） */
export interface RemoteUpdate {
  version: string
  notes: string | null
  date: string | null
  /** 插件原始 Update 对象，download/install 需要持有同一实例 */
  raw: Update
}

/** Rust 侧 startup_check 命令的返回（camelCase 见 lib.rs） */
export interface StartupCheckResult {
  installed: boolean
  installedVersion: string | null
  appVersion: string
  versionMismatch: boolean
  missingResources: string[]
}

/** 检查请求超时（设计文档：~30s 防镜像悬挂） */
const CHECK_TIMEOUT_MS = 30_000

export function updaterAvailable(): boolean {
  return isTauri()
}

/** 请求 manifest（endpoints 按序回退由插件内置）；无更新返回 null */
export async function checkForUpdate(): Promise<RemoteUpdate | null> {
  const update = await pluginCheck({ timeout: CHECK_TIMEOUT_MS })
  if (!update) return null
  return {
    version: update.version,
    notes: update.body ?? null,
    date: update.date ?? null,
    raw: update,
  }
}

export type DownloadProgressFn = (downloaded: number, total: number | null) => void

/**
 * 带进度回调的下载。plugin 的 Progress 事件只含增量 chunkLength，
 * 这里累计后回调，避免调用方自己维护累加器。
 */
export function downloadUpdate(
  u: RemoteUpdate,
  onProgress: DownloadProgressFn,
): Promise<void> {
  let downloaded = 0
  let total: number | null = null
  return u.raw
    .download((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null
        onProgress(0, total)
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        onProgress(downloaded, total)
      }
    })
    .then(() => undefined)
}

/** 安装：Windows 下插件拉起 NSIS（quiet → /S）并 exit(0)，正常不返回 */
export function installUpdate(u: RemoteUpdate): Promise<void> {
  return u.raw.install()
}

/** 启动自检：注册表安装版本 vs 应用版本 + resources 完整性（P1-6） */
export function runStartupCheck(): Promise<StartupCheckResult> {
  return invoke<StartupCheckResult>('startup_check')
}

/**
 * 快捷方式自愈：把残留的桌面/开始菜单 .lnk 校正到注册表登记的安装目录。
 * 仅在启动自检发现 versionMismatch 时调用；非 Windows 返回空清单。
 */
export function fixShortcuts(): Promise<string[]> {
  return invoke<string[]>('fix_shortcut')
}
