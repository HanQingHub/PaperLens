import type { CSSProperties } from 'react'

declare const StrokeText: (props: {
  text?: string
  strokeColor?: string
  fillColor?: string
  strokeWidth?: number
  drawDuration?: number
  fillDelay?: number
  stagger?: number
  ease?: string
  trigger?: 'mount' | 'hover' | 'scroll' | 'loop'
  fillMode?: 'fade' | 'wipe' | 'none'
  fontSize?: number | string
  fontWeight?: number | string
  letterSpacing?: number | string
  reverse?: boolean
  className?: string
  style?: CSSProperties
}) => JSX.Element

export default StrokeText
