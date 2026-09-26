'use client'

/**
 * The one picture the guide exists to teach: where Backenly sits in the
 * workflow. Two phases, because that is the distinction a new user misses:
 * the agent builds (through MCP), then Backenly runs and watches what was built.
 *
 * Five equal columns under two phase labels from md up; a vertical list below
 * it. Connectors are decorative and hidden from assistive tech; the ordered
 * list carries the sequence.
 */

import { Bot, Cable, ChevronRight, Database, Rocket, ShieldCheck, type LucideIcon } from 'lucide-react'

interface Node {
  icon: LucideIcon
  title: string
  caption: string
  run?: boolean
}

const NODES: Node[] = [
  { icon: Bot, title: 'Your coding agent', caption: 'Claude Code, Cursor, Codex, Cline' },
  { icon: Cable, title: 'Backenly MCP', caption: 'The tools your agent calls' },
  { icon: Database, title: 'Your backend', caption: 'Postgres, auth, APIs, storage' },
  { icon: Rocket, title: 'Publish', caption: 'A stable, versioned endpoint', run: true },
  { icon: ShieldCheck, title: 'Backenly watches', caption: 'Detects and repairs what it safely can', run: true },
]

function PhaseLabel({ label, hint, run = false }: { label: string; hint: string; run?: boolean }) {
  return (
    <p className="flex items-center gap-2">
      <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${run ? 'text-violet-300/80' : 'text-zinc-500'}`}>
        {label}
      </span>
      <span className="text-[11px] text-zinc-600">{hint}</span>
      <span aria-hidden className={`h-px flex-1 ${run ? 'bg-violet-300/20' : 'bg-white/[0.07]'}`} />
    </p>
  )
}

/** `bare` drops the frame when the diagram already sits inside a panel. */
export function WorkflowDiagram({ compact = false, bare = false }: { compact?: boolean; bare?: boolean }) {
  return (
    <div
      role="group"
      aria-label="How Backenly fits into your workflow"
      className={bare ? '' : 'rounded-xl border border-white/[0.07] bg-[#0f1015] p-4'}
    >
      <div className="mb-3 hidden gap-4 md:grid md:grid-cols-5">
        <div className="col-span-3">
          <PhaseLabel label="Build" hint="through your agent" />
        </div>
        <div className="col-span-2">
          <PhaseLabel label="Run" hint="Backenly keeps it healthy" run />
        </div>
      </div>
      <ol className="grid gap-2 md:grid-cols-5 md:gap-4">
        {NODES.map((n, i) => (
          <li key={n.title} className="relative min-w-0">
            {i === 0 && (
              <div className="mb-2 md:hidden">
                <PhaseLabel label="Build" hint="through your agent" />
              </div>
            )}
            {i === 3 && (
              <div className="mb-2 mt-2 md:hidden">
                <PhaseLabel label="Run" hint="Backenly keeps it healthy" run />
              </div>
            )}
            <div
              className={`flex min-w-0 items-start gap-3 rounded-lg border px-3 py-3 md:h-full ${
                n.run ? 'border-violet-300/15 bg-violet-300/[0.03]' : 'border-white/[0.07] bg-[#16171d]'
              }`}
            >
              <span className="relative mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03]">
                <n.icon className={`h-4 w-4 ${n.run ? 'text-violet-200' : 'text-zinc-300'}`} aria-hidden />
                <span
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#0f1015] font-mono text-[9px] tabular-nums text-zinc-500 ring-1 ring-white/[0.1]"
                  aria-hidden
                >
                  {i + 1}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium leading-snug text-zinc-100">{n.title}</span>
                {!compact && <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{n.caption}</span>}
              </span>
            </div>
            {i < NODES.length - 1 && (
              <ChevronRight
                aria-hidden
                className="absolute -right-[13px] top-1/2 z-10 hidden h-3 w-3 -translate-y-1/2 text-zinc-600 md:block"
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
