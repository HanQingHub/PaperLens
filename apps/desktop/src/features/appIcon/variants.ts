import { useAuth } from '../../stores/auth'
import type { AppIconVariant } from '../../api/types'
import orbitUrl from '../../assets/icons/orbit.png'
import diamondUrl from '../../assets/icons/diamond.png'

export const APP_ICONS: Record<AppIconVariant, string> = {
  orbit: orbitUrl,
  diamond: diamondUrl,
}

export function resolveAppIcon(): AppIconVariant {
  const st = useAuth.getState()
  if (st.user) {
    return (st.settings.app_icon as AppIconVariant) ?? 'orbit'
  }
  try {
    const v = localStorage.getItem('pl_app_icon')
    return v === 'diamond' ? 'diamond' : 'orbit'
  } catch {
    return 'orbit'
  }
}

export function persistAppIconLocal(v: AppIconVariant) {
  try {
    localStorage.setItem('pl_app_icon', v)
  } catch {}
}
