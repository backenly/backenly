'use client'

/**
 * The guide's visual primitives, lifted from the console's own reference
 * surface (WorkspaceHome's "Backend agent" panel) rather than invented: a panel
 * with one violet hairline along its top edge, an uppercase eyebrow with a live
 * dot, a white primary action with an up-right arrow, a quiet secondary link.
 * The onboarding should read as part of the console, not as a layer on top.
 */

import type { ReactNode } from 'react'
import { ArrowUpRight, ChevronRight, type LucideIcon } from 'lucide-react'

export const PANEL = 'relative overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]'

/** The one decorative accent the console allows: a hairline glow on a panel's top edge. */
export function Hairline() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent"
    />
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`${PANEL} ${className}`}>
      <Hairline />
      {children}
    </div>
  )
}

type Tone = 'live' | 'ok' | 'bad' | 'muted'

const DOT: Record<Tone, string> = {
  live: 'bg-violet-300',
  ok: 'bg-emerald-400',
  bad: 'bg-rose-400',
  muted: 'bg-zinc-600',
}

/** Uppercase micro-label with a status dot. `pulse` only for "Backenly is waiting on something". */
export function Eyebrow({ children, tone = 'live', pulse = false }: { children: ReactNode; tone?: Tone; pulse?: boolean }) {
  return (
    <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
      <span className="relative flex h-[6px] w-[6px]" aria-hidden>
        {pulse && <span className="absolute inset-[-3px] rounded-full bg-violet-400/30 motion-safe:animate-pulse" />}
        <span className={`relative h-[6px] w-[6px] rounded-full ${DOT[tone]}`} />
      </span>
      {children}
    </p>
  )
}

/**
 * Progress as one segment per step, the way the console draws counts: discrete,
 * not a vague bar. One progressbar role for assistive tech, whatever it looks like.
 */
export function SegmentedProgress({ completed, total, className = '' }: { completed: number; total: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label="Getting started progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={`${completed} of ${total} steps complete`}
      className={`flex gap-1 ${className}`}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1 flex-1 rounded-full motion-safe:transition-colors motion-safe:duration-500 ${
            i < completed ? 'bg-violet-300/80' : 'bg-white/[0.07]'
          }`}
        />
      ))}
    </div>
  )
}

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50'

export function PrimaryAction({
  children,
  onClick,
  icon: Icon = ArrowUpRight,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  icon?: LucideIcon
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
    >
      {children}
      <Icon
        aria-hidden
        className="h-3 w-3 opacity-90 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
      />
    </button>
  )
}

export function SecondaryAction({
  children,
  onClick,
  icon: Icon,
}: {
  children: ReactNode
  onClick: () => void
  icon?: LucideIcon
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08] ${FOCUS}`}
    >
      {Icon && <Icon aria-hidden className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

/** The console's quiet link: muted text, a chevron that moves on hover. */
export function QuietAction({ children, onClick, href }: { children: ReactNode; onClick?: () => void; href?: string }) {
  const cls = `group inline-flex items-center gap-0.5 text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 ${FOCUS}`
  const body = (
    <>
      {children}
      <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
    </>
  )
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  )
}
