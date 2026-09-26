'use client'

/**
 * What Backenly does once there is a backend: the loop, then the four
 * properties every autonomous action has. Deliberately bounded: it repairs
 * the conditions it has a fix for and reports everything else, and saying so
 * is part of the explanation, not a footnote.
 *
 * Drawn as the Overview draws its self-healing loop: numbered stages on one
 * rail, the return path named, so a user who has seen one recognises the other.
 */

import { ChevronRight, CornerDownLeft, ShieldCheck, BadgeCheck, ScrollText, Undo2, type LucideIcon } from 'lucide-react'
import { AUTONOMY_GUARANTEES, AUTONOMY_STAGES } from './guide-copy'

const GUARANTEE_ICON: Record<string, LucideIcon> = {
  Governed: ShieldCheck,
  Verified: BadgeCheck,
  Auditable: ScrollText,
  Reversible: Undo2,
}

export function AutonomyLoop({ stacked = false }: { stacked?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.07] bg-[#0f1015]">
      <ol
        className={`grid gap-px bg-white/[0.05] ${stacked ? '' : 'sm:grid-cols-5'}`}
        aria-label="How Backenly looks after a backend"
      >
        {AUTONOMY_STAGES.map((stage, i) => (
          <li key={stage.name} className="relative bg-[#0f1015] px-3 py-2.5">
            <p className="flex items-center gap-2 text-[11.5px] font-medium text-zinc-100">
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full font-mono text-[9.5px] tabular-nums text-violet-200 ring-1 ring-violet-300/40"
                aria-hidden
              >
                {i + 1}
              </span>
              {stage.name}
              {!stacked && i < AUTONOMY_STAGES.length - 1 && (
                <ChevronRight className="ml-auto hidden h-3 w-3 text-zinc-700 sm:block" aria-hidden />
              )}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">{stage.body}</p>
          </li>
        ))}
      </ol>
      <p className="flex items-center gap-1.5 border-t border-white/[0.05] px-3 py-2 font-mono text-[10.5px] text-zinc-600">
        <CornerDownLeft className="h-3 w-3" aria-hidden />
        Verify feeds the next Observe
      </p>
      <ul
        className={`grid gap-x-4 gap-y-2 border-t border-white/[0.05] px-3 py-2.5 ${stacked ? '' : 'sm:grid-cols-2'}`}
        aria-label="Every autonomous action is"
      >
        {AUTONOMY_GUARANTEES.map((g) => {
          const Icon = GUARANTEE_ICON[g.name] ?? ShieldCheck
          return (
            <li key={g.name} className="flex items-start gap-2 text-[11.5px] leading-snug text-zinc-500">
              <Icon className="mt-px h-3.5 w-3.5 flex-shrink-0 text-zinc-400" aria-hidden />
              <span>
                <span className="font-medium text-zinc-200">{g.name}.</span> {g.body}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-white/[0.05] px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
        Backenly repairs the conditions it has a verified fix for. Everything else is reported to you.
      </p>
    </div>
  )
}
