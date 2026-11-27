'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { usePlayOnce } from './play'

/* ─────────────────────────────────────────────────────────────
   "Every change on the record", shown as the record itself (founders,
   2026-11-15; three designers in review, every claim checked in lib/changes).
   Repair proves with a measurement and Restructure with a plan a person
   approves; History proves with what was written down.

   The same project's day, in the console's own words and order, newest first
   (lib/changes/history.ts): Backenly's 03:07 index from the Repair box, and the
   agent's request to remove movies.runtime that Repair held at 03:12, approved
   by a person at 09:14. A restore is not a row of its own in History; it is
   how the change it restored ended ("Restored by …", ChangeHistory.tsx), and
   its steps are written onto that change's own record (recovery.ts). So
   nothing is inserted and nothing already written moves: one status line
   turns, the evidence appears in space kept for it, and the change's record
   grows at its end.

   The change left standing is in Storage on purpose: a later change to the
   same table would block the restore until it was restored first (plan.ts).
   Restructure's architecture change is left out: its steps are separate
   entries, so one row titled with the plan's headline would be false.
───────────────────────────────────────────────────────────── */

type Actor = 'backenly' | 'person' | 'agent'
type Step = readonly [time: string, what: string]
type Entry = {
  at: string
  actor: Actor
  who: string
  where: string
  title: ReactNode
  plain: string
  steps: readonly Step[]
  /** Shown from sm up; a phone gets the three that tell the story. */
  wide?: boolean
}

const code = (s: string) => <span className="font-mono text-[0.92em] text-zinc-200">{s}</span>

const ENTRIES: readonly Entry[] = [
  {
    at: '11:40',
    actor: 'agent',
    who: 'Claude Code',
    where: 'Storage',
    title: <>Created bucket {code('posters')}</>,
    plain: 'Created bucket posters',
    steps: [['11:40:12', 'Checkpoint taken'], ['11:40:12', 'Applied'], ['11:40:13', 'Verified']],
  },
  {
    at: '09:14',
    actor: 'person',
    who: 'You, approving Claude Code’s request',
    where: 'Database',
    title: <>Removed column {code('runtime')} from {code('movies')}</>,
    plain: 'Removed column runtime from movies',
    steps: [
      ['09:14:06', 'Checkpoint taken'],
      ['09:14:06', 'Applied'],
      ['09:14:07', 'Verified'],
      ['12:15:40', 'Restore started'],
      ['12:15:41', 'Restore verified'],
    ],
  },
  {
    at: '03:07',
    actor: 'backenly',
    who: 'Backenly autonomy',
    where: 'Database',
    title: <>Added an index to {code('watchlist_items')}</>,
    plain: 'Added an index to watchlist_items',
    steps: [['03:07:41', 'Checkpoint taken'], ['03:07:41', 'Applied'], ['03:07:42', 'Verified']],
  },
  {
    at: '03:05',
    actor: 'agent',
    who: 'Claude Code',
    where: 'Database',
    title: <>Added column {code('movie_id')} to {code('watchlist_items')}</>,
    plain: 'Added column movie_id to watchlist_items',
    steps: [['03:05:18', 'Checkpoint taken'], ['03:05:18', 'Applied'], ['03:05:19', 'Verified']],
    wide: true,
  },
]

/** The restored change, and how many of its steps were written when it was made (the rest are the restore's). */
const RESTORED = 1
const MADE = 3

/** Violet only where Backenly acted; white for a person; zinc for an agent. */
const RULE: Record<Actor, string> = { backenly: 'bg-violet-400', person: 'bg-zinc-100', agent: 'bg-zinc-500' }
const WHO: Record<Actor, string> = { backenly: 'text-violet-200', person: 'text-white', agent: 'text-zinc-300' }

/** The status line turns, the bracket draws up to the change that stays, the evidence lands, the record grows. */
const MARKS = [0, 120, 300, 640, 840, 900, 960] as const

export function HistoryRecord() {
  const ref = useRef<HTMLElement>(null)
  const t = usePlayOnce(ref, MARKS)
  const shown = (m: number) => t >= m
  const [sel, setSel] = useState(RESTORED)
  const [peek, setPeek] = useState<number | null>(null)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  const panelId = useId()
  const at = peek ?? sel
  const e = ENTRIES[at]

  // Up and down move through the record; a row hidden on a phone is skipped.
  const keys = (i: number) => (ev: KeyboardEvent<HTMLButtonElement>) => {
    const d = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    ev.preventDefault()
    for (let j = i + d; j >= 0 && j < ENTRIES.length; j += d) {
      const b = rows.current[j]
      if (b && b.offsetParent !== null) {
        b.focus()
        return
      }
    }
  }

  const rise = (m: number) => ({ opacity: shown(m) ? 1 : 0, transform: shown(m) ? 'none' : 'translateY(4px)' })

  return (
    <figure ref={ref} className="overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d]">
      <div className="grid lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)]">
        {/* The record. */}
        <div className="min-w-0 px-[10px] pb-[12px] pt-[18px] sm:px-[18px] sm:pb-[16px] sm:pt-[24px]">
          <div className="px-[10px]">
            <p className="text-[14.5px] font-medium tracking-[-0.01em] text-zinc-100">Changes to movie-reviews today</p>
            {/* Says where the 12:15 restore is shown (review of 2026-11-27: a restore inside a "newest first" list read as out of order). */}
            <p className="mt-[4px] text-[12.5px] text-faint">Newest change first. A restore shows on the change it undid.</p>
          </div>

          <ol aria-label="Changes to movie-reviews today, newest first" onPointerLeave={() => setPeek(null)} className="mt-[14px] grid gap-[2px] pl-[16px] sm:pl-[20px]">
            {ENTRIES.map((entry, i) => {
              const on = i === at
              return (
                <li
                  key={entry.at}
                  onPointerEnter={() => setPeek(i)}
                  className={`relative grid-cols-[36px_2px_minmax(0,1fr)] gap-x-[10px] rounded-[6px] px-[10px] py-[11px] transition-colors duration-150 sm:grid-cols-[40px_2px_minmax(0,1fr)] sm:gap-x-[12px] sm:px-[12px] ${entry.wide ? 'hidden sm:grid' : 'grid'} ${on ? 'bg-white/[0.04]' : ''}`}
                >
                  {/* The change made after the restored one: bracketed, and left as it is. */}
                  {i === RESTORED - 1 && (
                    <span
                      aria-hidden
                      className="absolute -left-[13px] top-[20px] h-[calc(100%+2px)] w-[7px] origin-bottom border-y border-l border-white/55 transition-transform duration-[360ms] ease-[cubic-bezier(0.65,0,0.35,1)] sm:-left-[16px]"
                      style={{ transform: shown(300) ? 'scaleY(1)' : 'scaleY(0)' }}
                    />
                  )}
                  <time className="font-mono text-[12.5px] leading-[18px] tabular-nums text-faint">{entry.at}</time>
                  <span aria-hidden className={`w-[2px] rounded-[1px] ${RULE[entry.actor]}`} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-[12px] text-[12.5px] leading-[18px]">
                      <span className={`min-w-0 ${WHO[entry.actor]}`}>{entry.who}</span>
                      <span className="ml-auto hidden shrink-0 text-faint sm:inline">{entry.where}</span>
                    </div>
                    <p className="mt-[4px] text-[14.5px] leading-[1.45] tracking-[-0.005em] text-zinc-100">
                      {/* The row's one button, stretched over the row (as the console does). */}
                      <button
                        ref={(b) => {
                          rows.current[i] = b
                        }}
                        type="button"
                        aria-pressed={i === sel}
                        aria-controls={panelId}
                        onFocus={() => setSel(i)}
                        onClick={() => setSel(i)}
                        onKeyDown={keys(i)}
                        className="text-left after:absolute after:inset-0 after:rounded-[6px] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-white/50"
                      >
                        {entry.title}
                      </button>
                    </p>
                    {/* The bracket's words, there from the start so nothing reflows when it draws (review of 2026-11-27: unlabelled, it read as a join). */}
                    {i === RESTORED - 1 && (
                      <p className="mt-[4px] text-[12.5px] leading-[18px] text-zinc-400 transition-opacity duration-200 ease-out" style={{ opacity: shown(300) ? 1 : 0 }}>
                        Made later. The restore leaves it as it is.
                      </p>
                    )}
                    {i === RESTORED && (
                      <>
                        <div className="mt-[6px] grid text-[12.5px] leading-[18px] [&>*]:[grid-area:1/1]">
                          <span aria-hidden className="text-zinc-400 transition-opacity duration-[120ms]" style={{ opacity: shown(0) ? 0 : 1 }}>
                            Kept in its vault: 1,284 values
                          </span>
                          <span className="inline-flex items-center gap-[6px] font-medium text-white transition-[opacity,transform] duration-200 ease-out" style={rise(120)}>
                            <RotateCcw aria-hidden className="h-[13px] w-[13px] shrink-0 text-zinc-200" strokeWidth={2} />
                            Restored by you at 12:15
                          </span>
                        </div>
                        <div className="mt-[6px] max-w-[54ch] text-[13px] leading-[1.5] text-zinc-300 transition-[opacity,transform] duration-[240ms] ease-out [text-wrap:pretty]" style={rise(640)}>
                          {/* Two facts, one line each: what came back, and what newer rows got. The later change that stays is said on its own row. */}
                          <p>{code('runtime')} is back with its 1,284 values.</p>
                          <p>The 4 movies added since have no runtime.</p>
                        </div>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        {/* One change's own record, as History keeps it. */}
        <div id={panelId} className="min-w-0 border-t border-white/[0.07] px-[20px] pb-[22px] pt-[20px] sm:px-[28px] lg:border-l lg:border-t-0 lg:pb-[26px] lg:pt-[24px]">
          <p className="text-[12.5px] text-faint">Every step, as recorded</p>
          <p className="mt-[8px] text-[15px] font-medium leading-[1.4] tracking-[-0.01em] text-white">{e.title}</p>
          <p className={`mt-[4px] text-[12.5px] leading-[18px] ${WHO[e.actor]}`}>{e.who}</p>
          <ol className="mt-[16px] grid min-h-[136px] content-start gap-[7px]">
            {e.steps.map(([time, what], k) => (
              <li
                key={`${at}-${k}`}
                className={`flex gap-[14px] text-[13px] leading-[19px] ${k === MADE ? 'mt-[10px]' : ''}`}
                style={at === RESTORED && k >= MADE ? { opacity: shown(840 + (k - MADE) * 60) ? 1 : 0, transition: 'opacity 180ms ease-out' } : undefined}
              >
                <time className="w-[62px] shrink-0 font-mono text-[12px] tabular-nums text-faint">{time}</time>
                <span className="text-zinc-200">{what}</span>
              </li>
            ))}
          </ol>
          <p className="mt-[16px] text-[12.5px] text-faint">Choose any change to read its steps.</p>
          <p className="sr-only" aria-live="polite">
            {ENTRIES[sel].plain}: {ENTRIES[sel].steps.map(([time, what]) => `${what} at ${time}`).join(', ')}.
          </p>
        </div>
      </div>
    </figure>
  )
}
