import type { CSSProperties } from 'react'

declare const Threads: (props: {
  color?: [number, number, number]
  amplitude?: number
  distance?: number
  enableMouseInteraction?: boolean
  className?: string
  style?: CSSProperties
} & Record<string, unknown>) => JSX.Element

export default Threads
