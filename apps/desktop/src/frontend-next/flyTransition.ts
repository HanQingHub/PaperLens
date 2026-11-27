/**
 * 层析 STRATA · 文库 → 阅读台连续空间转场。
 * 约束：飞行纸面是挂在壳层根（.pnx-shell）末尾的 position:fixed 独立浮层，
 * 不进入 .pnx-content 与任何阅读页祖先，不改变它们的 transform —— 选区 / 批注坐标不受影响。
 * 路由切换与动画并行，不阻塞阅读页渲染；结束或兜底计时到点即移除。
 */

const TRAVEL_MS = 620
const FADE_MS = 260

export interface FlyPaper {
  title: string
  subtitle: string
  code: string
  hue: number
}

export function flyToReader(face: HTMLElement | null, paper: FlyPaper, enabled: boolean): void {
  if (!enabled || !face) return
  const host = document.querySelector<HTMLElement>('.pnx-shell')
  const target = host?.querySelector<HTMLElement>(':scope > .pnx-workspace > .pnx-content')
  if (!host || !target || typeof face.getBoundingClientRect !== 'function') return
  const from = face.getBoundingClientRect()
  const area = target.getBoundingClientRect()
  if (from.width < 2 || area.width < 40) return

  const width = Math.min(780, area.width * 0.64)
  const height = Math.max(240, area.height - 28)
  const left = area.left + (area.width - width) / 2
  const top = area.top + 14

  const fly = document.createElement('div')
  fly.className = 'pnx-sx-fly'
  fly.setAttribute('aria-hidden', 'true')
  fly.style.left = `${left}px`
  fly.style.top = `${top}px`
  fly.style.width = `${width}px`
  fly.style.height = `${height}px`
  fly.style.setProperty('--hue', String(paper.hue))
  const sheet = document.createElement('div')
  sheet.className = 'pnx-sx-fly-sheet'
  const band = document.createElement('div')
  band.className = 'pnx-sx-fly-band'
  band.textContent = paper.code
  const title = document.createElement('div')
  title.className = 'pnx-sx-fly-title'
  title.textContent = paper.title
  const sub = document.createElement('div')
  sub.className = 'pnx-sx-fly-sub'
  sub.textContent = paper.subtitle
  const lines = document.createElement('div')
  lines.className = 'pnx-sx-fly-lines'
  for (let i = 0; i < 14; i++) lines.appendChild(document.createElement('i'))
  sheet.append(band, title, sub, lines)
  fly.appendChild(sheet)
  host.appendChild(fly)

  const dx = from.left - left
  const dy = from.top - top
  const sx = from.width / width
  const sy = from.height / height
  const midX = dx * 0.35
  const midY = dy * 0.25 - 40

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    fly.remove()
  }

  if (typeof fly.animate !== 'function') {
    remove()
    return
  }
  const travel = fly.animate(
    [
      { transform: `perspective(1400px) translate(${dx}px, ${dy}px) scale(${sx}, ${sy}) rotateX(52deg) rotateZ(-8deg)`, opacity: 0.9 },
      { transform: `perspective(1400px) translate(${midX}px, ${midY}px) scale(${0.6 + sx * 0.4}, ${0.6 + sy * 0.4}) rotateX(18deg) rotateZ(-2deg)`, opacity: 1, offset: 0.55 },
      { transform: 'perspective(1400px) translate(0px, 0px) scale(1, 1) rotateX(0deg) rotateZ(0deg)', opacity: 1 },
    ],
    { duration: TRAVEL_MS, easing: 'cubic-bezier(.7,0,.2,1)', fill: 'forwards' },
  )
  travel.onfinish = () => {
    const fade = fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' })
    fade.onfinish = remove
  }
  window.setTimeout(remove, TRAVEL_MS + FADE_MS + 200)
}
