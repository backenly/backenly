'use client'

/**
 * The one picture the guide exists to teach: where Backenly sits in the
 * workflow. Two phases, because that is the distinction a new user misses —
 * the agent builds (through MCP), then Backenly runs and watches what was built.
 *
 * Horizontal from md up, a vertical list below it. Decorative arrows are hidden
 * from assistive tech; the list itself carries the order.
 */

import { Bot, Cable, Database, Rocket, ShieldCheck, ChevronRight, type LucideIcon } from 'lucide-react'

interface Node {
  icon: LucideIcon
  title: string
  caption: string
}

const BUILD: Node[] = [
  { icon: Bot, title: 'Your coding agent', caption: 'Claude Code, Cursor, Codex, Cline' },
  { icon: Cable, title: 'Backenly MCP', caption: 'The tools your agent calls' },
  { icon: Database, title: 'Your backend', caption: 'Postgres, auth, APIs, storage' },
]

const RUN: Node[] = [
  { icon: Rocket, title: 'Publish', caption: 'A stable, versioned endpoint' },
  { icon: ShieldCheck, title: 'Backenly watches', caption: 'Detects and repairs what it safely can' },
]

export function WorkflowDiagram({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" role="group" aria-label="How Backenly fits into your workflow">
      <Phase label="Build" hint="through your agent" nodes={BUILD} compact={compact} />
      <Phase label="Run" hint="Backenly keeps it healthy" nodes={RUN} compact={compact} offset={BUILD.length} />
    </div>
  )
}

function Phase({
  label,
  hint,
  nodes,
  compact,
  offset = 0,
}: {
  label: string
  hint: string
  nodes: Node[]
  compact: boolean
  offset?: number
}) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.07] bg-[#0f1015] p-3">
      <p className="mb-2.5 flex items-baseline gap-2 px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</span>
        <span className="text-[11px] text-zinc-600">{hint}</span>
      </p>
      <ol className="flex flex-col gap-1.5 md:flex-row md:items-stretch md:gap-0" start={offset + 1}>
        {nodes.map((n, i) => (
          <li key={n.title} className="flex min-w-0 flex-1 flex-col md:flex-row md:items-stretch">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03]">
                <n.icon className="h-3.5 w-3.5 text-zinc-300" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium leading-snug text-zinc-100">{n.title}</span>
                {!compact && <span className="block text-[11px] leading-snug text-zinc-500">{n.caption}</span>}
              </span>
            </div>
            {i < nodes.length - 1 && (
              <ChevronRight
                aria-hidden
                className="mx-auto my-0.5 h-3.5 w-3.5 flex-shrink-0 rotate-90 self-center text-zinc-600 md:mx-1 md:my-0 md:rotate-0"
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
