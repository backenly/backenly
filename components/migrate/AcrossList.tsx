'use client'

import { useState } from 'react'
import { ArrowRight, Minus } from 'lucide-react'
import { useOnScreen } from '@/components/landing-v7/shared'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import type { Across, AcrossKind } from '@/app/migrate/content'

/* ─────────────────────────────────────────────────────────────
   "What comes across" for one source, drawn rather than tabled: each thing
   you have now, a line across to what it becomes on Backenly, and how the
   line ends: an arrow when it moves, a gate when it waits for your approval,
   a stop short of Backenly when it stays behind. The lines draw once, one
   after another, when the list scrolls into view; reduced motion shows them
   drawn. Black and zinc only: no traffic-light colours.
───────────────────────────────────────────────────────────── */

/** How a row's line ends, in words: shown above the row on a phone (where the lines are not drawn) and read out everywhere. */
const KIND_WORD: Record<AcrossKind, string> = {
  moves: 'Moves',
  approve: 'Waits for your approval',
  stays: 'Stays behind',
}

function Line({ kind, drawn, delay }: { kind: AcrossKind; drawn: boolean; delay: number }) {
  const reach = kind === 'stays' ? 'w-[55%]' : 'w-full'
  return (
    <span aria-hidden className="relative flex h-[18px] items-center">
      <span className={`relative h-px ${reach} overflow-hidden`}>
        <span
          className={`absolute inset-0 origin-left transition-transform duration-[700ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
            kind === 'stays' ? 'bg-[repeating-linear-gradient(90deg,rgba(161,161,170,0.55)_0_4px,transparent_4px_8px)]' : 'bg-zinc-400/70'
          }`}
          style={{ transform: drawn ? 'scaleX(1)' : 'scaleX(0)', transitionDelay: `${delay}ms` }}
        />
      </span>
      <span
        className="ml-[-1px] flex shrink-0 items-center transition-opacity duration-300 motion-reduce:transition-none"
        style={{ opacity: drawn ? 1 : 0, transitionDelay: `${delay + 520}ms` }}
      >
        {kind === 'moves' && <ArrowRight className="h-[13px] w-[13px] text-zinc-300" strokeWidth={2} />}
        {kind === 'approve' && <span className="ml-[2px] h-[9px] w-[9px] rounded-full border-[1.5px] border-zinc-200" />}
        {kind === 'stays' && <Minus className="h-[13px] w-[13px] rotate-90 text-zinc-500" strokeWidth={2.25} />}
      </span>
    </span>
  )
}

export function AcrossList({ rows, from }: { rows: Across[]; from: string }) {
  const quiet = useSettledReducedMotion()
  const [ref, onScreen] = useOnScreen<HTMLUListElement>('0px 0px -12% 0px')
  // Drawn once, the first time the list is seen (set while rendering, as React suggests for state that follows another).
  const [seen, setSeen] = useState(false)
  if (onScreen && !seen) setSeen(true)
  const drawn = seen || quiet

  return (
    <div>
      <ul ref={ref} aria-label={`What moves from ${from} to Backenly`} className="divide-y divide-white/[0.07] border-y border-white/[0.07]">
        {rows.map((row, i) => (
          <li key={row.have} className="grid gap-x-[16px] gap-y-[6px] py-[15px] sm:grid-cols-[minmax(0,190px)_72px_minmax(0,1fr)] sm:items-start">
            <p className="text-[14.5px] font-medium leading-[1.5] text-zinc-100">{row.have}</p>
            <span className="hidden pt-[2px] sm:block">
              <Line kind={row.kind} drawn={drawn} delay={i * 110} />
            </span>
            <p className={`text-[14.5px] leading-[1.55] [text-wrap:pretty] ${row.kind === 'stays' ? 'text-zinc-400' : 'text-zinc-300'}`}>
              <span className="mb-[4px] block text-[12.5px] font-medium text-zinc-400 sm:sr-only">
                {KIND_WORD[row.kind]}
                <span className="sr-only">: </span>
              </span>
              {row.becomes}
            </p>
          </li>
        ))}
      </ul>
      <p aria-hidden className="mt-[14px] hidden flex-wrap items-center gap-x-[20px] gap-y-[8px] text-[12.5px] text-zinc-400 sm:flex">
        <span className="inline-flex items-center gap-[8px]">
          <span className="h-px w-[18px] bg-zinc-400/70" />
          <ArrowRight className="-ml-[9px] h-[11px] w-[11px] text-zinc-300" strokeWidth={2} />
          Moves
        </span>
        <span className="inline-flex items-center gap-[8px]">
          <span className="h-px w-[18px] bg-zinc-400/70" />
          <span className="-ml-[6px] h-[8px] w-[8px] rounded-full border-[1.5px] border-zinc-200" />
          Waits for your approval
        </span>
        <span className="inline-flex items-center gap-[8px]">
          <span className="h-px w-[18px] bg-[repeating-linear-gradient(90deg,rgba(161,161,170,0.55)_0_4px,transparent_4px_8px)]" />
          Stays behind
        </span>
      </p>
    </div>
  )
}
