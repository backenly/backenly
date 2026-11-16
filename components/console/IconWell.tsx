/**
 * A row's kind icon in a quiet square well: a wrench for a fix Backenly made,
 * a bin for a drop, a branch for a branch. It says what kind of thing the row
 * is; the row's words say its state. Always zinc: colour never carries state
 * here (no traffic lights), and violet stays for marks of Backenly acting.
 *
 *   ┌────┐
 *   │ 🔧 │  Added an index on follows (followee_id)
 *   └────┘  Re-checked: fixed   follows   Nov 11
 *
 * 28px beside a two-line row, 24px in dense lists. The well is a hair lighter
 * at the top than the bottom, like the console's buttons, so it reads as an
 * object without a shadow or a tint.
 */

import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'

type IconLike = LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>

const SIZES = {
  24: { box: 'h-[24px] w-[24px] rounded-[6px]', glyph: 'h-[13px] w-[13px]' },
  28: { box: 'h-[28px] w-[28px] rounded-[7px]', glyph: 'h-[14px] w-[14px]' },
} as const

export function IconWell({
  icon: Icon,
  size = 28,
  quiet = false,
  className = '',
}: {
  icon: IconLike
  size?: keyof typeof SIZES
  /** Something finished or undone: the icon steps back a shade. */
  quiet?: boolean
  className?: string
}) {
  const s = SIZES[size]
  return (
    <span
      aria-hidden
      className={`flex flex-shrink-0 items-center justify-center border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.02))] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${s.box} ${className}`}
    >
      <Icon className={`${s.glyph} ${quiet ? 'text-zinc-500' : 'text-zinc-300'}`} strokeWidth={1.75} />
    </span>
  )
}
