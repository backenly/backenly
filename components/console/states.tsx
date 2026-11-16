'use client'

/**
 * A panel with nothing in it, and a panel that could not be read: the two
 * templates every section uses (project decision 12, 2026-11-16). Both sit at
 * the top left of the real panel or pane, inside it; the page's headers,
 * rails and column heads stay where they are.
 *
 *   No tables yet                                       15px medium white
 *   Your coding agent creates tables as it builds. Connect your agent, then send it this.
 *   ┌ Ask your agent ───────────────────────── Copy ┐   1-3 requests, at most 560px
 *   │ Create a movies table with title and year.    │   only where the agent builds the thing
 *   └───────────────────────────────────────────────┘
 *   Database docs
 *
 *   ✕  Could not load tables. The SQL editor still works.          [Try again]
 *
 * No icon, tile, ghost picture, centred stack or button in an empty panel:
 * the section's create button stays in its bar, and connecting the agent
 * lives in the top bar and the sidebar (decision 1).
 */

import { useId, type ReactNode } from 'react'
import { CopyButton, KitButton, StatusGlyph } from '@/components/inspector/kit'
import { EDGE, FOCUS, RULE, R_PANEL, WELL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import type { DocSlug } from '@/app/docs/content'
import { formatTime, type Moment } from './format'

/** The longest first sentence an empty panel may say (decision 12). */
export const EMPTY_SENTENCE_MAX = 90

/** What the empty panel knows about the project's agent: useAgentConnection's answer, passed in. */
export interface AgentState {
  status: 'loading' | 'connected' | 'disconnected'
  /** The connected client's name ("Claude Code"), when known. */
  client?: string | null
}

/**
 * The second sentence: how the requests reach the agent. Nothing while the
 * connection is unknown or when there is nothing to send.
 *
 *   disconnected, may connect     Connect your agent, then send it this.
 *   disconnected, may not         Ask an owner or admin to connect an agent.
 *   connected                     Send Claude Code this to start.   ("your agent" with no name)
 *
 * With two or three requests, "this" becomes "one of these".
 */
export function agentSentence(agent: AgentState | null | undefined, requests: number, canConnect = true): string | null {
  if (!agent || agent.status === 'loading' || requests === 0) return null
  const what = requests > 1 ? 'one of these' : 'this'
  if (agent.status === 'connected') {
    const client = agent.client?.trim() || 'your agent'
    return `Send ${client} ${what} to start.`
  }
  if (!canConnect) return 'Ask an owner or admin to connect an agent.'
  return `Connect your agent, then send it ${what}.`
}

/** Where a section's docs live: on the Cloud site, or backenly.com for a self-hosted build. */
export function docsHref(slug: DocSlug): string {
  return CLOUD_CONTROL_PLANE ? `/docs/${slug}` : `https://backenly.com/docs/${slug}`
}

export interface EmptyPanelProps {
  /** "No tables yet". */
  title: string
  /** What appears here, in one sentence of at most 90 characters. */
  sentence: string
  /** 1-3 requests the agent can be sent, only where the agent builds the thing. */
  requests?: readonly string[]
  /** The project's agent connection (useAgentConnection), which picks the second sentence. */
  agent?: AgentState | null
  /** The person can connect an agent (an owner or admin). Others are told who can. */
  canConnect?: boolean
  /** The section's docs: `{ label: 'Database docs', slug: 'database' }`, or an `href` of its own. */
  docs?: { label: string; slug?: DocSlug; href?: string }
  /** One real fact instead of requests, for sections nobody asks the agent for (an endpoint with Copy). */
  children?: ReactNode
  /** The title's heading level in the page's outline: h3 under a section heading, h2 in an instrument pane. */
  headingLevel?: 2 | 3 | 4
  className?: string
}

export function EmptyPanel({
  title,
  sentence,
  requests = [],
  agent,
  canConnect = true,
  docs,
  children,
  headingLevel = 3,
  className = '',
}: EmptyPanelProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  if (process.env.NODE_ENV !== 'production' && sentence.length > EMPTY_SENTENCE_MAX) {
    console.warn(`EmptyPanel: "${sentence}" is ${sentence.length} characters; keep it to ${EMPTY_SENTENCE_MAX}.`)
  }
  const shown = requests.slice(0, 3)
  const second = agentSentence(agent, shown.length, canConnect)
  const href = docs ? docs.href ?? (docs.slug ? docsHref(docs.slug) : null) : null
  return (
    <div className={`px-[20px] py-[18px] ${className}`}>
      <Heading className="text-[15px] font-medium leading-[22px] tracking-[-0.012em] text-white [text-wrap:balance]">{title}</Heading>
      <p className="mt-[4px] max-w-[640px] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
        {sentence}
        {second && <> {second}</>}
      </p>
      {shown.length > 0 && <AskYourAgent requests={shown} className="mt-[16px]" />}
      {children && <div className="mt-[16px]">{children}</div>}
      {docs && href && (
        <p className="mt-[16px] text-[13px] leading-[20px]">
          {/* In a new tab, so the console keeps its place. */}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`}
          >
            {docs.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </div>
  )
}

/**
 * The requests to send the agent, one click each to copy. Prose, so Geist,
 * not mono. One request: one Copy in the head. Two or three: a copy button
 * on each line, since each is its own choice.
 */
export function AskYourAgent({ requests, label = 'Ask your agent', className = '' }: { requests: readonly string[]; label?: string; className?: string }) {
  const headId = useId()
  const list = requests.slice(0, 3)
  const single = list.length === 1
  return (
    <div role="group" aria-labelledby={headId} className={`w-full max-w-[560px] overflow-hidden ${R_PANEL} border ${EDGE} ${WELL} ${className}`}>
      <div className={`flex min-h-[34px] items-center justify-between gap-3 border-b ${RULE} pl-[14px] pr-[4px]`}>
        <p id={headId} className="py-[8px] text-[12px] leading-[16px] text-faint">
          {label}
        </p>
        {single && <CopyButton value={list[0]} label="Copy" showLabel />}
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {list.map((r) => (
          <li key={r} className={`flex items-start gap-3 py-[8px] pl-[14px] ${single ? 'pr-[14px]' : 'pr-[6px]'}`}>
            <p className="min-w-0 flex-1 py-[3px] text-[13px] leading-[20px] text-zinc-200 [overflow-wrap:anywhere] [text-wrap:pretty]">{r}</p>
            {!single && <CopyButton value={r} label="Copy request" />}
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface ErrorRowProps {
  /** What could not be read, plural and lower case: "tables", "function runs". */
  things: string
  /** What still works, only when it is true: "The SQL editor still works." */
  stillWorks?: ReactNode
  onRetry: () => void
  retrying?: boolean
  /**
   * When the panel still shows data from an earlier read: a refresh failed.
   * The rows stay and one faint line says how old they are.
   */
  staleAt?: Moment | null
  className?: string
}

/**
 * The panel's error row.
 *
 * First load failed (no `staleAt`): it replaces the rows. The caller clears
 * whatever the panel showed before, so stale rows are never read as current.
 *   ✕  Could not load tables. The SQL editor still works.          [Try again]
 *
 * A refresh failed (`staleAt`): the rows stay, with this line above them.
 *   Could not refresh. Showing tables from 2:14 PM.                [Try again]
 */
export function ErrorRow({ things, stillWorks, onRetry, retrying = false, staleAt, className = '' }: ErrorRowProps) {
  if (staleAt) {
    // "from 2:14 PM" today; with the date once it is older than that.
    const at = formatTime(staleAt, formatTime(staleAt, 'day') === 'Today' ? 'clock' : 'dateTime')
    return (
      <div role="status" className={`flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-b ${RULE} px-[16px] py-[8px] sm:px-[20px] ${className}`}>
        <p className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-faint">
          Could not refresh. Showing {things} from {at}.
        </p>
        <KitButton size="sm" onClick={onRetry} loading={retrying}>
          Try again
        </KitButton>
      </div>
    )
  }
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-x-[12px] gap-y-[10px] px-[16px] py-[14px] sm:px-[20px] ${className}`}>
      <StatusGlyph state="failed" label="Error" />
      <p className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-200 [overflow-wrap:anywhere]">
        Could not load {things}.{stillWorks && <span className="text-zinc-400"> {stillWorks}</span>}
      </p>
      <KitButton size="sm" onClick={onRetry} loading={retrying}>
        Try again
      </KitButton>
    </div>
  )
}

/**
 * An action the server refused, on its own line under the row it was asked
 * from, in the server's own words. Never a toast, never silently dropped.
 */
export function RefusedLine({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={`text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere] ${className}`}>
      {children}
    </p>
  )
}
