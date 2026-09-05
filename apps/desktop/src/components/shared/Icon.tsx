// 全仓统一 SVG 图标：替代所有 emoji/文字符号图标（emoji 跨字体渲染不一致）。
// 范本同 WindowControls 内联 SVG：24 viewBox、stroke=currentColor、round caps。
interface IconProps {
  size?: number
  className?: string
}

function Base({ size = 12, className = '', children, filled = false }: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const IconX = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
)
export const IconCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Base>
)
export const IconStar = (p: IconProps) => (
  <Base {...p} filled>
    <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
  </Base>
)
export const IconStarOutline = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
  </Base>
)
export const IconPencil = (p: IconProps) => (
  <Base {...p}>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </Base>
)
export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </Base>
)
export const IconSpeaker = (p: IconProps) => (
  <Base {...p}>
    <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Base>
)
export const IconHistory = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 3.5V8H8M12 7.5V12l3 2" />
  </Base>
)
export const IconPin = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 4h6l1 7 3 3v2H5v-2l3-3zM12 16v5" />
  </Base>
)
export const IconPlus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
)
export const IconMinus = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h14" />
  </Base>
)
export const IconEllipsis = (p: IconProps) => (
  <Base {...p} filled>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </Base>
)
export const IconFit = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Base>
)
export const IconQuote = (p: IconProps) => (
  <Base {...p} filled>
    <path d="M10 8c-3 1-5 3.5-5 7v1h5v-6H7.5C8 9 9 8.5 10 8.2zM20 8c-3 1-5 3.5-5 7v1h5v-6h-2.5c.5-1 1.5-1.5 2.5-1.8z" />
  </Base>
)
export const IconMenu = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Base>
)
export const IconBook = (p: IconProps) => (
  <Base {...p}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </Base>
)
export const IconSpark = (p: IconProps) => (
  <Base {...p} filled>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z" />
  </Base>
)
export const IconFlame = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 22c4 0 7-2.8 7-6.8 0-3.1-2-5.3-3.5-7C14 6.5 13 5 13 2c-3 2-5 4.5-5.8 7C6 9.5 5 10.5 5 13c0 5 3 9 7 9z" />
  </Base>
)
export const IconPlay = (p: IconProps) => (
  <Base {...p} filled>
    <path d="M7 4.5v15l13-7.5z" />
  </Base>
)
export const IconPause = (p: IconProps) => (
  <Base {...p} filled>
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </Base>
)
export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </Base>
)
