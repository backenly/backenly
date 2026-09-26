'use client'

/**
 * What Backenly does once there is a backend: the loop, then the four
 * properties every autonomous action has. Deliberately bounded: it repairs
 * the conditions it has a fix for and reports everything else, and saying so
 * is part of the explanation, not a footnote.
 */

import { AUTONOMY_GUARANTEES, AUTONOMY_STAGES } from './guide-copy'

export function AutonomyLoop({ stacked = false }: { stacked?: boolean }) {
  return (
    <div className="space-y-3">
      <ol className={`grid gap-1.5 ${stacked ? '' : 'sm:grid-cols-5'}`} aria-label="How Backenly looks after a backend">
        {AUTONOMY_STAGES.map((stage, i) => (
          <li key={stage.name} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-100">
              <span className="font-mono text-[10px] tabular-nums text-zinc-600" aria-hidden>
                {i + 1}
              </span>
              {stage.name}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">{stage.body}</p>
          </li>
        ))}
      </ol>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Every autonomous action is">
        {AUTONOMY_GUARANTEES.map((g) => (
          <li key={g.name} className="text-[11px] text-zinc-500">
            <span className="font-medium text-zinc-300">{g.name}.</span> {g.body}
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Backenly repairs the conditions it has a verified fix for. Everything else is reported to you.
      </p>
    </div>
  )
}
