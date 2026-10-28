/* The shapes the illustrations hand to their card (../FeatureArt). */

/** One keyframe of a track, at `t` seconds into the loop. `ease` is the curve to the next key. */
export interface Key {
  t: number
  /** opacity */
  o?: number
  /** translate, in the art's own units (the viewBox is 1200 × 560) */
  x?: number
  y?: number
  /** uniform scale, or vertical scale only */
  s?: number
  sy?: number
  ease?: string
}

export interface Track {
  /** Every element marked data-a="key" in the art or its signs moves by this track. */
  key: string
  keys: Key[]
  /** transform-origin within the element's own box, e.g. "50% 100%". */
  origin?: string
  /** A loop of its own (ambient motion), in seconds, instead of the scene's. */
  loop?: number
  /** Where in its own loop it starts, in seconds. */
  phase?: number
}

/** The symbols a chip can lead with (lucide glyphs, drawn by ../FeatureArt). */
export type SignIcon = 'clock' | 'alert' | 'check' | 'lock' | 'shield' | 'database' | 'receipt' | 'app' | 'code' | 'sync' | 'flask' | 'undo'

/** A label pinned into the art: a chip on one side of `at`, with a leader to `to`. */
export interface Sign {
  key: string
  label: string
  /** The role colour: the icon's tint and the leader's. */
  tone: string
  icon?: SignIcon
  /** Agent marks (components/landing/AgentMarks ids) shown before the label. */
  marks?: string[]
  /** A small badge before the label, e.g. LIVE. */
  badge?: string
  /** Where the chip's near edge sits, in art units. */
  at: [number, number]
  side: 'above' | 'below' | 'left' | 'right'
  /** The point the leader runs to, in art units; none for a chip that names its neighbour directly. */
  to?: [number, number]
}

export interface Chapter {
  id: string
  label: string
  caption: string
  at: number
  /** The moment a paused or reduced-motion card shows for the step. */
  rest: number
}

export interface Art {
  /** The scene: inner SVG markup for a 1200 × 560 viewBox. */
  svg: string
  signs: Sign[]
  tracks: Track[]
  /** Seconds in one loop. */
  cycle: number
  /** The story told, every step's result in view: what reduced motion shows. */
  still: number
  chapters: Chapter[]
  railLabel: string
  description: string
}

/** Curves (emil-design-eng, design-to-motion): out for arrivals, in-out for travel, a small overshoot for things that land. */
export const EASE = {
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  in: 'cubic-bezier(0.55, 0, 0.75, 0.2)',
  land: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  linear: 'linear',
} as const
