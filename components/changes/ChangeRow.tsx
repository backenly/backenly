'use client'

/**
 * One History row, exported so Overview's "Recent changes" shows the same
 * row (project decision 10). Who made the change leads it (decision 7):
 *
 *   (◇)  Created table reviews. Created bucket review-photos…        ✓  2:09 AM  ⋯
 *        Claude Code   Database, Storage, Secrets   #48
 *   (B)  Changed ratings: row-level security off     Recovered automatically  9:14 PM  ⋯
 *        Claude Code   Database   #45
 *        Production healthy. View details
 *
 * A change that applied and verified, which is most of them, is the ✓ glyph
 * alone (screen readers hear "Verified"): the word was printed fourteen times
 * down the page before. Words appear only for an exception: waiting on you,
 * recovered, restored, not verified, needs attention, applying. Times are the
 * clock, under a day heading; the full moment is on hover.
 *
 * The whole row opens the change (History's drawer, ?change=); the links in
 * it and the ⋯ menu stay their own controls.
 */

import type { ReactNode } from 'react'
import { OverflowMenu, StatusGlyph } from '@/components/inspector/kit'
import { ActorMark, ActorWords } from '@/components/console/ActorMark'
import { Time } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { FOCUS_INSET } from '@/components/console/tokens'
import type { ChangeSummary } from '@/lib/changes/history'
import { awaitsDecision, outcomeOf, resourceLabels } from './present'

export type ChangeMenuItem = { label: string; onClick: () => void; danger?: boolean }

/** The actor as ActorMark draws it: a person, a coding agent, or Backenly. */
export function actorOf(c: Pick<ChangeSummary, 'actor'>): { type: 'person' | 'agent' | 'system'; label: string } {
  return { type: c.actor.type === 'person' ? 'person' : c.actor.type === 'agent' ? 'agent' : 'system', label: c.actor.label }
}

/**
 * How a change ended, at the row's right: ✓ alone for the usual healthy end,
 * words for an exception.
 */
export function ChangeOutcome({ c, className = '' }: { c: ChangeSummary; className?: string }) {
  const s = outcomeOf(c)
  switch (c.outcome.state) {
    case 'healthy':
      return <StatusGlyph state="done" label="Verified" className={className} />
    case 'awaiting_approval':
      return <StatusGlyph state="waiting" label="Waiting on you" showLabel className={className} />
    case 'needs_attention':
      return <StatusGlyph state="failed" label="Needs attention" showLabel className={className} />
    case 'in_progress':
      return <StatusGlyph state="busy" label={s.label} showLabel className={className} />
    case 'unverified':
    case 'kept':
      return <span className={`text-[12.5px] font-medium leading-[16px] text-zinc-50 ${className}`}>{s.label}</span>
    case 'restored':
      return (
        <span className={`text-[12.5px] leading-[16px] text-zinc-300 ${className}`}>
          {c.outcome.by ? `Restored by ${c.outcome.by.label}` : 'Restored'}
          {c.outcome.at ? `, ${formatTime(c.outcome.at, formatTime(c.outcome.at, 'day') === formatTime(c.createdAt, 'day') ? 'clock' : 'dateTime')}` : ''}
        </span>
      )
    default:
      return <span className={`text-[12.5px] leading-[16px] text-zinc-300 ${className}`}>{s.label}</span>
  }
}

/** The line under the facts, only when there is something to know. */
function SecondLine({ c, onDetails, onDecide }: { c: ChangeSummary; onDetails?: () => void; onDecide?: (() => void) | null }) {
  const link = (label: string, onClick: () => void) => (
    // Above the row's own button (relative z-[1]), and 24px tall for a finger.
    <button
      type="button"
      onClick={onClick}
      className={`relative z-[1] inline-flex min-h-[24px] items-center rounded-[4px] text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-50 hover:decoration-white/50 ${FOCUS_INSET}`}
    >
      {label}
    </button>
  )
  switch (c.outcome.state) {
    case 'recovered':
      return <>Production healthy.{onDetails && <> {link('View details', onDetails)}</>}</>
    case 'awaiting_approval':
    case 'needs_attention':
      return (
        <>
          <span className="[overflow-wrap:anywhere]">{c.outcome.note ?? 'A person needs to decide what happens to this change.'}</span>
          {onDecide && <>{' '}{link('Review', onDecide)}</>}
        </>
      )
    case 'kept':
    case 'unverified':
      return c.outcome.note ? <span className="[overflow-wrap:anywhere]">{c.outcome.note}</span> : null
    default:
      return null
  }
}

function hasSecondLine(c: ChangeSummary): boolean {
  if (c.outcome.state === 'recovered' || awaitsDecision(c)) return true
  return (c.outcome.state === 'kept' || c.outcome.state === 'unverified') && !!c.outcome.note
}

export function ChangeRow({
  change: c,
  onOpen,
  href,
  menu,
  menuLabel,
  onDecide,
  showParts = true,
  current = false,
  timeMode = 'clock',
}: {
  change: ChangeSummary
  /** Open the change (History's drawer). */
  onOpen?: () => void
  /** Or link to it (Overview links to History's drawer). */
  href?: string
  /** The row's ⋯ items. */
  menu?: ChangeMenuItem[]
  menuLabel?: string
  /** Review, on a row that waits on a decision. */
  onDecide?: (() => void) | null
  /** The parts it touched, as a fact. Off on a list filtered to one part. */
  showParts?: boolean
  /** The change open in the drawer. */
  current?: boolean
  /** 'clock' under a day heading (History); 'ago' in a short list (Overview). */
  timeMode?: 'clock' | 'ago'
}) {
  const s = outcomeOf(c)
  const label = `Change #${c.seq}: ${c.summary}. ${s.label}`
  const opener = 'w-full text-left text-[13.5px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50 [overflow-wrap:anywhere] line-clamp-2 sm:line-clamp-1 after:absolute after:inset-0 after:content-[\'\'] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70'
  const title: ReactNode = href ? (
    <a href={href} aria-label={label} className={opener}>
      {c.summary}
    </a>
  ) : (
    <button type="button" onClick={onOpen} aria-label={label} className={opener}>
      {c.summary}
    </button>
  )
  return (
    <li aria-current={current || undefined} className={`group relative transition-colors ${current ? 'bg-white/[0.04]' : 'hover:bg-[#121316]'}`}>
      <div className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-x-[12px] px-[16px] py-[12px] sm:px-[20px] ${menu ? 'pr-[48px] sm:pr-[56px]' : ''}`}>
        <ActorMark actor={actorOf(c)} size={24} className="-mt-[1.5px]" />
        <span className="min-w-0">
          {title}
          {/* Wraps rather than truncates: a name cut to "Y…" says nothing. */}
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] leading-[18px] text-faint">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <ActorWords label={c.actor.label} />
            </span>
            {showParts && <span>{resourceLabels(c.resources)}</span>}
            <span className="tabular-nums">#{c.seq}</span>
            {/* On a phone an exception takes its own line; the healthy ✓ needs none. */}
            {c.outcome.state !== 'healthy' && (
              <span className="basis-full sm:hidden">
                <ChangeOutcome c={c} />
              </span>
            )}
          </span>
          {hasSecondLine(c) && (
            <span className="mt-1 block text-[12.5px] leading-[18px] text-zinc-400">
              <SecondLine c={c} onDetails={onOpen} onDecide={onDecide} />
            </span>
          )}
        </span>
        <span className="flex items-center gap-[12px] pt-[2px]">
          <ChangeOutcome c={c} className={c.outcome.state === 'healthy' ? '' : 'hidden sm:inline-flex'} />
          <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums text-faint">
            <Time iso={c.createdAt} mode={timeMode} />
          </span>
        </span>
      </div>
      {menu && menu.length > 0 && (
        <div className="absolute right-[8px] top-[10px] z-[1] sm:right-[12px]">
          <OverflowMenu label={menuLabel ?? `Actions for change #${c.seq}`} items={menu} width="w-[220px]" />
        </div>
      )}
    </li>
  )
}
