// 外部链接打开：Tauri 走自定义命令（系统默认浏览器，http/https 白名单在 Rust 侧校验），
// 浏览器 dev 模式回退 window.open。
import { invoke, isTauri } from '@tauri-apps/api/core'

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_external', { url })
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
