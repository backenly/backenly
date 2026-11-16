'use client'

/**
 * Who did it, and how it ended: the marks a "who did what" row is built from
 * (History, Overview's Recent changes, Connect's tool calls).
 *
 *   (D)  Added column likes to posts                       ✓  2:09 AM
 *        demo@example.com, approving Claude Code's request
 *
 * ActorMark is the row's lead (decision 7): 24px and round, a person's
 * initial, a coding agent's prompt mark, or Backenly's own logo. It is
 * decorative (aria-hidden); the row says the name in words.
 *
 * Outcome is the end state at the row's right. The common, healthy outcome is
 * the glyph alone (screen readers still hear its word); only an exception is
 * written out, so "Verified" is never printed fourteen times down a page.
 */

import { StatusGlyph, type GlyphState } from '@/components/inspector/kit'

export type ActorType = 'person' | 'agent' | 'system' | 'backenly'

export interface Actor {
  /** person: someone in the console. agent: a coding agent's key. system / backenly: Backenly itself. */
  type: ActorType
  /** The words the row prints: "Adarsh Jose", "Claude Code", "Backenly". */
  label: string
}

const MARK_SIZE = { 20: 'h-[20px] w-[20px] text-[10px]', 24: 'h-[24px] w-[24px] text-[11px]', 28: 'h-[28px] w-[28px] text-[11.5px]' } as const

/** The row's 24px mark for whoever made the change. */
export function ActorMark({
  actor,
  size = 24,
  className = '',
}: {
  actor: Pick<Actor, 'type' | 'label'>
  size?: keyof typeof MARK_SIZE
  className?: string
}) {
  const box = `relative flex flex-shrink-0 items-center justify-center rounded-full ${MARK_SIZE[size]} ${className}`
  if (actor.type === 'system' || actor.type === 'backenly') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/backenly-icon-hd.svg" alt="" aria-hidden width={size} height={size} className={`flex-shrink-0 ${className}`} />
    )
  }
  if (actor.type === 'agent') {
    return (
      <span aria-hidden className={`${box} bg-[#16171a] ring-1 ring-inset ring-white/[0.12]`}>
        <svg viewBox="0 0 16 16" className="h-[58%] w-[58%] text-zinc-300" fill="none">
          <path d="M3.5 5 6.5 8l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 11.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  const initial = (actor.label.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      className={`${box} bg-[linear-gradient(135deg,#27272a,#18181b)] font-medium leading-none text-zinc-200 ring-1 ring-inset ring-white/[0.12]`}
    >
      {initial}
    </span>
  )
}

/**
 * "demo@example.com, approving Claude Code's request": the who in the row's
 * stronger grey, the rest in its faint one.
 */
export function ActorWords({ label, className = '' }: { label: string; className?: string }) {
  const at = label.indexOf(', ')
  if (at === -1) return <span className={`text-zinc-300 ${className}`}>{label}</span>
  return (
    <span className={className}>
      <span className="text-zinc-300">{label.slice(0, at)}</span>
      {label.slice(at)}
    </span>
  )
}

/**
 * How something ended, at a row's right.
 *
 *   <Outcome glyph="done" label="Verified" />                      ✓
 *   <Outcome glyph="waiting" label="Waiting on you" show />        ◆ Waiting on you
 *   <Outcome label="Recovered automatically" show />               Recovered automatically
 *
 * `show` writes the word out: only for an exception (waiting, failed, not
 * verified, restored, in progress), never for the usual healthy end.
 */
export function Outcome({
  glyph,
  label,
  show = false,
  className = '',
}: {
  glyph?: GlyphState
  /** The outcome in words. Always read to screen readers. */
  label: string
  show?: boolean
  className?: string
}) {
  if (!glyph) {
    return <span className={`text-[12.5px] leading-[16px] text-zinc-300 ${className}`}>{label}</span>
  }
  return <StatusGlyph state={glyph} label={label} showLabel={show} className={className} />
}
