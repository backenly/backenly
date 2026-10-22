'use client'

/**
 * WORKSPACE SETUP  ───────────────────────────────────────────────────────────
 * The Overview of a project with nothing built yet. WorkspaceHome takes over
 * the moment the agent creates something.
 *
 * This used to be one centred icon, a sentence and a button on an otherwise
 * empty canvas, which read as a placeholder rather than a product. It now has
 * the built Overview's frame (the name, one panel, one block of cards) and
 * says two things:
 *
 *   • Setup panel  Left, the next step: the first request to send the agent,
 *                  and Connect until it is connected. Right, the steps, which
 *                  continue the three the Projects page shows a new account
 *                  (ProjectsHome's FirstProject), ticked from real state only.
 *   • Included     What every project already has, one card per section,
 *                  each saying what it is for and opening it.
 *
 * Nothing is fabricated: no table, route or user appears here until the agent
 * genuinely creates it.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowUpRight, Braces, Check, Database, HardDrive, Users, type LucideIcon } from 'lucide-react'
import { AgentPrompt, Tag } from '@/components/inspector/kit'
import { ConnectAgentLink, DocsLink } from '@/components/inspector/AgentEmptyState'
import { AGENT_ICON } from '@/components/connect/AgentBrandIcons'
import { ago } from '@/components/changes/present'
import { EDGE, FOCUS, PLATE, R_PANEL } from '@/components/console/tokens'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'

/** Concrete enough to show what one ask builds: tables, auth and a rule. */
const FIRST_REQUEST =
  "Build the backend for a task tracker: projects, tasks with a status and a due date, and email sign-in. Only a task's owner can edit it."

/** The agents the Connect page has an install command for. */
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' },
  { id: 'antigravity', name: 'Antigravity' },
] as const

const INCLUDED: Array<{ section: string; label: string; icon: LucideIcon; body: string }> = [
  { section: 'database', label: 'Database', icon: Database, body: 'Postgres tables with REST endpoints and row-level security.' },
  { section: 'auth', label: 'Auth & Users', icon: Users, body: 'Sign-up, sign-in and sessions for the people using your app.' },
  { section: 'storage', label: 'Storage', icon: HardDrive, body: 'Buckets for your app’s files, each with its own read rule.' },
  { section: 'functions', label: 'Functions', icon: Braces, body: 'Endpoints, scheduled jobs and code that runs when data changes.' },
]

export function WorkspaceSetup({ projectId, projectName }: { projectId: string; projectName: string | null }) {
  const agent = useAgentConnection(projectId)
  const connected = agent.connected
  const via = [
    agent.client && `through ${agent.client}`,
    agent.lastSeenAt && `last call ${ago(agent.lastSeenAt)}`,
  ].filter(Boolean).join(', ')

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <header className="min-w-0 pb-3">
          <h1 className="truncate text-[26px] font-semibold leading-[32px] tracking-[-0.028em] text-zinc-50">
            {projectName ?? 'Untitled project'}
          </h1>
        </header>

        <section aria-labelledby="setup-heading" className={`overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`}>
          <div className="grid gap-10 px-5 py-7 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
            {/* ── Left: the next step ── */}
            <div className="min-w-0">
              <h2
                id="setup-heading"
                className="text-[21px] font-semibold leading-[30px] tracking-[-0.022em] text-zinc-50 [text-wrap:balance]"
              >
                {connected ? 'Your agent is connected' : 'Your backend is ready to build'}
              </h2>
              <p className="mt-2 max-w-[54ch] text-[14px] leading-[22px] text-zinc-400 [text-wrap:pretty]">
                {connected
                  ? 'Ask it for what your app needs in plain words, or start with the request below. This page fills in as it builds.'
                  : 'Your coding agent builds it over MCP: schema, APIs, auth and storage. Backenly runs what it builds and keeps every change reversible.'}
              </p>
              <AgentPrompt prompt={FIRST_REQUEST} className="mt-6" />
              {/* A row that starts with the ghost docs link is pulled left so
                  its label lines up with the text above. Connect's space is
                  held while the answer loads, as the top bar does. */}
              <div className={`mt-5 flex flex-wrap items-center gap-2 ${connected ? '-ml-3' : ''}`}>
                {!connected && <ConnectAgentLink projectId={projectId} className={agent.needsConnect ? '' : 'invisible'} />}
                <DocsLink slug="connect" />
              </div>
            </div>

            {/* ── Right: the setup sequence ── */}
            <ol aria-label="Setup" className="min-w-0 lg:pt-1">
              <Step
                n={1}
                state="done"
                title="Create a project"
                body="Backenly provisioned an isolated Postgres schema with its own auth, storage, functions and REST API."
              />
              <Step
                n={2}
                state={connected ? 'done' : 'current'}
                title="Connect your coding agent"
                body={
                  connected
                    ? `Connected${via ? ` ${via}` : ''}.`
                    : 'Generate a scoped key, then run one install command. Any MCP client works.'
                }
              >
                {!connected && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {AGENTS.map(({ id, name }) => {
                      const Mark = AGENT_ICON[id]
                      return (
                        <Tag key={id}>
                          <Mark size={12} />
                          {name}
                        </Tag>
                      )
                    })}
                  </div>
                )}
              </Step>
              <Step
                n={3}
                state={connected ? 'current' : 'next'}
                title="Describe what to build"
                body="Ask in plain words. Each request lands as a planned, verified change you can roll back."
                last
              />
            </ol>
          </div>
        </section>
      </div>

      <section aria-labelledby="included-heading" className="space-y-3">
        <h2 id="included-heading" className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">
          Included in this project
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {INCLUDED.map((item) => (
            <Link
              key={item.section}
              href={`/app/projects/${projectId}/${item.section}`}
              className={`group ${R_PANEL} border ${EDGE} ${PLATE} flex flex-col gap-3 p-4 transition-[border-color,background-color] duration-150 hover:border-white/[0.14] hover:bg-[#111215] ${FOCUS}`}
            >
              <span className="flex items-center gap-2.5">
                <span className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.08] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <item.icon className="h-[15px] w-[15px] text-zinc-400" strokeWidth={1.75} />
                </span>
                <span className="truncate text-[13px] font-medium text-zinc-200">{item.label}</span>
                <ArrowUpRight
                  className="ml-auto h-4 w-4 flex-shrink-0 text-zinc-600 transition-[color,transform] duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-zinc-300"
                  strokeWidth={1.75}
                />
              </span>
              <span className="text-[13px] leading-[20px] text-zinc-500 [text-wrap:pretty]">{item.body}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}

/**
 * One step on a rail, as on the Connect page (AgentInstallGuide's Step), with
 * three states: done (ticked), current (the next thing to do) and next.
 */
function Step({
  n,
  state,
  title,
  body,
  last = false,
  children,
}: {
  n: number
  state: 'done' | 'current' | 'next'
  title: string
  body: string
  last?: boolean
  children?: ReactNode
}) {
  return (
    <li className={`relative flex gap-4 ${last ? '' : 'pb-7'}`}>
      {!last && <span aria-hidden className="absolute bottom-0 left-[11px] top-[28px] w-px bg-white/[0.08]" />}
      <span
        aria-hidden
        className={`relative z-[1] mt-px flex h-[23px] w-[23px] flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${
          state === 'done'
            ? 'bg-emerald-400/15 text-emerald-300'
            : state === 'current'
            ? 'border border-white/[0.28] bg-[#0f1012] text-zinc-50'
            : 'border border-white/[0.10] bg-[#0f1012] text-zinc-500'
        }`}
      >
        {state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3
          className={`text-[14px] font-semibold leading-[22px] tracking-[-0.01em] ${
            state === 'next' ? 'text-zinc-400' : 'text-zinc-100'
          }`}
        >
          <span className="sr-only">{state === 'done' ? 'Done: ' : `Step ${n}: `}</span>
          {title}
        </h3>
        <p className="mt-0.5 text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{body}</p>
        {children}
      </div>
    </li>
  )
}
