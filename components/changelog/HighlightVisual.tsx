'use client'

import { RepairChart } from '@/components/landing-v8/autonomy/RepairChart'
import { RestructurePlan } from '@/components/landing-v8/autonomy/RestructurePlan'
import { HistoryRecord } from '@/components/landing-v8/autonomy/HistoryRecord'
import { CodeBlock } from '@/components/site/CodeBlock'
import type { ChangelogHighlight } from '@/app/changelog/entries'

/* ─────────────────────────────────────────────────────────────
   The picture beside a highlighted change. Each is true of its change:
   the landing's own figure for the same capability (the index repair that
   never blocks a write, the restructure you approve, the record of a day),
   code exactly as the docs and the README give it, or the change's own
   numbers drawn to scale. Nothing here is a mock of the console.
───────────────────────────────────────────────────────────── */

/** public/docs/agents/functions.md (#780): an http function and a sandboxed one. */
const SESSION = `// An http function
import { createSession } from '@/lib/auth/session'

// Call it only after your own check has passed,
// such as a code sent by SMS.
const { token, user } = await createSession(userId)

// A sandboxed function
const session = await ctx.auth.createSession(userId)`

/** README.md, Self-hosted. */
const SELFHOST = `git clone https://github.com/backenly/backenly.git
cd backenly
npm install
npm run selfhost`

export function HighlightVisual({ name }: { name: ChangelogHighlight }) {
  switch (name) {
    case 'repair':
      return <RepairChart />
    case 'restructure':
      return <RestructurePlan />
    case 'history':
      return <HistoryRecord />
    case 'session':
      return <CodeBlock language="ts" label="Sign a user in" code={SESSION} />
    case 'selfhost':
      return <CodeBlock language="bash" label="Self-hosted install" code={SELFHOST} />
    case 'cadence':
      return <Cadence />
  }
}

/**
 * One hour of one project's checks, before and after (August 4): the entry's
 * own numbers. The contract sweep ran every 15 minutes and the infrastructure
 * scan once a day; both now run every minute.
 */
function Cadence() {
  const rows = [
    { name: 'Contract sweep', before: [0, 15, 30, 45], was: 'Every 15 minutes' },
    { name: 'Infrastructure scan', before: [] as number[], was: 'Once a day' },
  ]
  return (
    <figure className="rounded-[8px] border border-white/[0.08] bg-[#0a0a0d] p-[18px] sm:p-[24px]">
      <figcaption className="flex items-baseline justify-between gap-4 text-[13px] text-zinc-400">
        <span>One hour of checks on one project</span>
        <span className="tabular-nums">60 min</span>
      </figcaption>
      <div className="mt-[18px] grid gap-[20px]">
        {rows.map((r) => (
          <div key={r.name}>
            <p className="text-[14px] font-medium text-zinc-100">{r.name}</p>
            <Ticks label="Before" said={r.was} on={r.before} />
            <Ticks label="Now" said="Every minute" on="all" />
          </div>
        ))}
      </div>
    </figure>
  )
}

function Ticks({ label, said, on }: { label: string; said: string; on: number[] | 'all' }) {
  const now = on === 'all'
  return (
    <div className="mt-[10px] grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-[12px] gap-y-[4px] sm:grid-cols-[52px_minmax(0,1fr)_128px]">
      <span className="text-[13px] text-zinc-400">{label}</span>
      <div aria-hidden className="flex h-[18px] min-w-0 items-stretch gap-[1px] sm:gap-[2px]">
        {Array.from({ length: 60 }, (_, i) => (
          <span
            key={i}
            className={`min-w-0 flex-1 rounded-full ${now ? 'bg-zinc-100' : on.includes(i) ? 'bg-zinc-300' : 'bg-white/[0.07]'}`}
          />
        ))}
      </div>
      <span className={`col-start-2 text-[13px] sm:col-start-3 sm:text-right ${now ? 'text-white' : 'text-zinc-400'}`}>{said}</span>
    </div>
  )
}
