'use client'

/**
 * The moving picture at the top of each console tour card.
 *
 * Each scene shows the product doing what its step says, in the product's own
 * words: the install command Connect prints (components/connect/
 * AgentInstallGuide.tsx), a schema arriving the way an agent builds one, the
 * version states Deploy shows, the fixes Autopilot applies on its own
 * (lib/memory/fix-history.ts) and the changes it holds for a person
 * (lib/autonomy/autonomy-level.ts). They follow one small app from stop to
 * stop, so the index Autopilot adds is on the table the agent just created. A
 * picture that promised something the product does not do would undo the
 * sentence under it.
 *
 * Decorative only: the card's title and body carry the meaning, so a scene is
 * hidden from assistive technology and holds nothing focusable. Each one plays
 * once and settles; only status that is genuinely ongoing (the check loop, a
 * change waiting on you) keeps moving. Under reduced motion a scene renders its
 * settled frame and nothing moves.
 *
 * Coordinates are px: the card is a fixed width, so every scene draws into the
 * same 328 × 100 box and can place its parts exactly.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ShieldCheck } from 'lucide-react'
import { StatusDot, Tag } from '@/components/inspector/kit'

export type SceneName = 'connect' | 'database' | 'publish' | 'autopilot' | 'approvals'

/** The console's one easing curve (tailwind.config.ts `ease-linear`). */
const EASE = [0.16, 1, 0.3, 1] as const

interface SceneProps {
  /** Render the settled frame and move nothing (prefers-reduced-motion). */
  still: boolean
  projectId?: string
}

export function TourScene({ name, still, projectId }: SceneProps & { name: SceneName }) {
  const Scene = SCENES[name]
  return (
    <div aria-hidden className="absolute inset-0 p-4">
      <div className="relative h-full w-full">
        <Scene still={still} projectId={projectId} />
      </div>
    </div>
  )
}

/** A transition that starts `delay` seconds into the scene, or none at all when still. */
function at(still: boolean, delay: number, duration = 0.42) {
  return still ? { duration: 0 } : { delay, duration, ease: EASE }
}

function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-zinc-200">{children}</span>
}

/* ── Connect: the command, typed, then the agent on the line ─────────────── */

type Segment = [text: string, className: string]

/**
 * The local install command for Claude Code as Connect builds it
 * (AgentInstallGuide.tsx), with this project's real id. The key is masked:
 * Connect shows a key once, when it is created, and `mcp_live_` is the prefix
 * an MCP key is issued with (lib/auth/key-prefix.ts).
 */
function commandLines(projectId: string): Segment[][] {
  return [
    [['claude', 'text-zinc-100'], [' mcp add ', 'text-zinc-400'], ['backenly', 'text-zinc-100'], [' -- \\', 'text-zinc-600']],
    [['npx -y ', 'text-zinc-400'], ['@backenly/mcp-server', 'text-zinc-200'], [' \\', 'text-zinc-600']],
    [['--project ', 'text-zinc-500'], [projectId, 'text-zinc-300'], [' \\', 'text-zinc-600']],
    [['--key ', 'text-zinc-500'], ['mcp_live_', 'text-zinc-300'], ['••••••••', 'text-zinc-600']],
  ]
}

/** Each segment with the offset of its first character in the whole command, which is what typing counts. */
function withOffsets(lines: Segment[][]) {
  let at = 0
  return lines.map((line) =>
    line.map(([text, className]) => {
      const segment = { text, className, at }
      at += text.length
      return segment
    })
  )
}

const TYPE_START_MS = 260
const TYPE_TICK_MS = 16
const CHARS_PER_TICK = 2

function ConnectScene({ still, projectId }: SceneProps) {
  const lines = withOffsets(commandLines(projectId ?? 'your-project-id'))
  const lastLine = lines[lines.length - 1]
  const total = lastLine[lastLine.length - 1].at + lastLine[lastLine.length - 1].text.length
  const [typed, setTyped] = useState(still ? total : 0)

  useEffect(() => {
    if (still || typed >= total) return
    const timer = setTimeout(
      () => setTyped((n) => Math.min(total, n + CHARS_PER_TICK)),
      typed === 0 ? TYPE_START_MS : TYPE_TICK_MS
    )
    return () => clearTimeout(timer)
  }, [still, typed, total])

  const done = typed >= total

  return (
    <div className="font-mono text-[10.5px] leading-[16px]">
      {lines.map((line, i) => {
        const end = line[line.length - 1].at + line[line.length - 1].text.length
        const active = !done && typed >= line[0].at && typed < end
        return (
          <div key={i} className="flex h-[16px] items-center whitespace-pre">
            <span className="select-none text-zinc-600">{i === 0 ? '$ ' : '    '}</span>
            {line.map((segment, j) => {
              const shown = segment.text.slice(0, Math.max(0, typed - segment.at))
              return shown ? (
                <span key={j} className={segment.className}>
                  {shown}
                </span>
              ) : null
            })}
            {active && <Caret still={still} />}
          </div>
        )
      })}
      <motion.div
        className="mt-2 flex h-[16px] items-center gap-2 font-sans"
        initial={false}
        animate={{ opacity: done ? 1 : 0, y: done ? 0 : 3 }}
        transition={at(still, 0.12, 0.36)}
      >
        <StatusDot tone="operational" label="Agent connected" />
        <span className="text-[11.5px] text-zinc-600">over MCP</span>
      </motion.div>
    </div>
  )
}

function Caret({ still }: { still: boolean }) {
  return (
    <motion.span
      className="ml-px inline-block h-[12px] w-[6px] bg-zinc-300"
      animate={still ? undefined : { opacity: [1, 1, 0, 0] }}
      transition={still ? undefined : { duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1], ease: 'linear' }}
    />
  )
}

/* ── Database: tables arriving the way an agent creates them ──────────────── */

const TABLES = [
  { name: 'users', x: 0, y: 6, columns: [['id', 'uuid'], ['email', 'text']] },
  { name: 'teams', x: 116, y: 26, columns: [['id', 'uuid'], ['owner_id', 'uuid']] },
  { name: 'tasks', x: 232, y: 6, columns: [['team_id', 'uuid'], ['title', 'text']] },
] as const

/**
 * The foreign keys, each drawn from the referenced column's row to the
 * referencing one. A node's header is 22px under a 1px edge and its rows are
 * 16px after 3px of padding, so the first row's centre sits 34px down and the
 * second's 50px.
 */
const RELATIONS = [
  { path: 'M96 40 C106 40 106 76 116 76', end: [116, 76] },
  { path: 'M212 60 C222 60 222 40 232 40', end: [232, 40] },
] as const

function DatabaseScene({ still }: SceneProps) {
  return (
    <>
      <svg className="absolute inset-0 overflow-visible" width="328" height="100" fill="none">
        {RELATIONS.map((r, i) => (
          <g key={r.path}>
            <motion.path
              d={r.path}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="1"
              initial={still ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={at(still, 0.5 + i * 0.5, 0.4)}
            />
            <motion.circle
              cx={r.end[0]}
              cy={r.end[1]}
              r="2"
              fill="#a1a1aa"
              initial={still ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={at(still, 0.86 + i * 0.5, 0.2)}
            />
          </g>
        ))}
      </svg>
      {TABLES.map((table, i) => (
        <motion.div
          key={table.name}
          className="absolute w-[96px] rounded-[6px] border bg-[#111215]"
          style={{ left: table.x, top: table.y }}
          initial={still ? false : { opacity: 0, y: 5, borderColor: 'rgba(255,255,255,0.34)' }}
          animate={{ opacity: 1, y: 0, borderColor: 'rgba(255,255,255,0.09)' }}
          transition={
            still
              ? { duration: 0 }
              : {
                  delay: 0.15 + i * 0.5,
                  duration: 0.42,
                  ease: EASE,
                  borderColor: { delay: 0.35 + i * 0.5, duration: 0.9 },
                }
          }
        >
          <div className="flex h-[22px] items-center justify-between border-b border-white/[0.06] px-2">
            <span className="font-mono text-[10.5px] text-zinc-100">{table.name}</span>
            {/* Access policies arrive with the tables they protect. */}
            <motion.span
              initial={still ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={at(still, 1.6 + i * 0.15, 0.3)}
            >
              <ShieldCheck className="h-[11px] w-[11px] text-emerald-400" strokeWidth={2} />
            </motion.span>
          </div>
          <div className="py-[3px]">
            {table.columns.map(([column, type]) => (
              <div key={column} className="flex h-[16px] items-center justify-between px-2 font-mono text-[10px]">
                <span className="text-zinc-300">{column}</span>
                <span className="text-zinc-600">{type}</span>
              </div>
            ))}
          </div>
        </motion.div>
      ))}
    </>
  )
}

/* ── Publish: a version your agent asked for, waiting on you ──────────────── */

function PublishScene({ still }: SceneProps) {
  return (
    <div className="overflow-hidden rounded-[7px] border border-white/[0.08] bg-[#0f1012]">
      {/* Arrives on top of the list and stays there: it never publishes itself. */}
      <motion.div
        className="overflow-hidden"
        initial={still ? false : { height: 0, opacity: 0 }}
        animate={{ height: 30, opacity: 1 }}
        transition={at(still, 0.55, 0.5)}
      >
        <VersionRow
          version={3}
          note="Requested by your agent"
          status={<StatusDot tone="attention" label="Waiting for you" pulse={!still} />}
          divider
        />
      </motion.div>
      <VersionRow version={2} note="Published" status={<StatusDot tone="operational" label="Serving" />} />
      <VersionRow version={1} note="Published" divider="top" />
    </div>
  )
}

function VersionRow({
  version,
  note,
  status,
  divider,
}: {
  version: number
  note: string
  status?: ReactNode
  divider?: true | 'top'
}) {
  const rule = divider === 'top' ? 'border-t border-white/[0.06]' : divider ? 'border-b border-white/[0.06]' : ''
  return (
    <div className={`flex h-[30px] items-center gap-2.5 px-3 ${rule}`}>
      <span className="w-[20px] text-[12px] font-medium tabular-nums text-zinc-200">v{version}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">{note}</span>
      {status}
    </div>
  )
}

/* ── Autopilot: the loop, what it fixed, and what it held back ────────────── */

const FIXES = [
  { what: <>Created index on <Code>tasks.team_id</Code></>, outcome: 'Reversible', held: false },
  { what: <>Applied RLS policy to <Code>comments</Code></>, outcome: 'Reversible', held: false },
  { what: <>Drop column <Code>users.legacy_id</Code></>, outcome: 'Held for you', held: true },
]

function AutopilotScene({ still }: SceneProps) {
  return (
    <>
      <div className="flex h-[20px] items-center justify-between">
        <span className="flex items-center gap-2 text-[12px] text-zinc-300">
          <LoopMark still={still} />
          Checking continuously
        </span>
        <Tag>Autopilot</Tag>
      </div>
      <div className="mt-[10px] space-y-[3px]">
        {FIXES.map((fix, i) => (
          <motion.div
            key={fix.outcome + i}
            className="flex h-[20px] items-center gap-2.5"
            initial={still ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={at(still, 0.45 + i * 0.55, 0.36)}
          >
            {/* Grey while it is applied and verified, then the outcome's colour. */}
            <motion.span
              className="h-[6px] w-[6px] flex-shrink-0 rounded-full"
              initial={still ? false : { backgroundColor: '#52525b' }}
              animate={{ backgroundColor: fix.held ? '#fbbf24' : '#34d399' }}
              transition={at(still, 0.8 + i * 0.55, 0.3)}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-300">{fix.what}</span>
            <span className={`text-[11.5px] ${fix.held ? 'text-amber-200' : 'text-zinc-500'}`}>{fix.outcome}</span>
          </motion.div>
        ))}
      </div>
    </>
  )
}

function LoopMark({ still }: { still: boolean }) {
  return (
    <motion.svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      animate={still ? undefined : { rotate: 360 }}
      transition={still ? undefined : { duration: 1.8, repeat: Infinity, ease: 'linear' }}
    >
      <circle cx="6" cy="6" r="4.75" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
      <path d="M6 1.25 A4.75 4.75 0 0 1 10.75 6" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" strokeLinecap="round" />
    </motion.svg>
  )
}

/* ── Approvals: what Backenly will not ship without you ───────────────────── */

function ApprovalsScene({ still }: SceneProps) {
  return (
    <>
      <motion.div
        className="absolute inset-x-[14px] top-[4px] h-[56px] rounded-[8px] border border-white/[0.07] bg-[#0f1012]"
        initial={still ? false : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={at(still, 0.2, 0.45)}
      >
        <div className="flex h-[20px] items-center justify-between px-3 text-[11.5px] text-zinc-500">
          <span>Enable Google sign-in</span>
          <span>Auth</span>
        </div>
      </motion.div>
      <motion.div
        className="absolute inset-x-0 top-[24px] rounded-[8px] border border-white/[0.10] bg-[#131417] px-3 py-[9px] shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]"
        initial={still ? false : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={at(still, 0.5, 0.5)}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium text-zinc-100">
            <StatusDot tone="attention" pulse={!still} />
            <span className="truncate">
              Drop column <Code>users.legacy_id</Code>
            </span>
          </span>
          <Tag>Destructive</Tag>
        </div>
        <div className="mt-[7px] flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-zinc-500">Requested by your agent</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-flex h-[22px] items-center rounded-[6px] border border-white/[0.10] px-2 text-[11px] font-medium text-zinc-300">
              Reject
            </span>
            {/* Invites the decision; never makes it. */}
            <motion.span
              className="inline-flex h-[22px] items-center rounded-[6px] bg-white px-2 text-[11px] font-semibold text-zinc-950"
              animate={
                still ? undefined : { boxShadow: ['0 0 0 0px rgba(255,255,255,0.4)', '0 0 0 6px rgba(255,255,255,0)'] }
              }
              transition={still ? undefined : { delay: 1.2, duration: 1.1, repeat: 1, repeatDelay: 0.5, ease: 'easeOut' }}
            >
              Approve
            </motion.span>
          </span>
        </div>
      </motion.div>
    </>
  )
}

const SCENES: Record<SceneName, (props: SceneProps) => JSX.Element> = {
  connect: ConnectScene,
  database: DatabaseScene,
  publish: PublishScene,
  autopilot: AutopilotScene,
  approvals: ApprovalsScene,
}
