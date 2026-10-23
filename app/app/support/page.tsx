'use client'

/**
 * /app/support: the account's support cases (Backenly Cloud).
 *
 * The AWS-Support-shaped center: every case gets an instant AI first response
 * in its thread and the team follows up within the plan's target. Off Cloud
 * the surface does not exist (notFound, like /app/usage) — a self-hosted
 * install has no support team behind it.
 *
 * One request loads every case (the API returns the latest 100), so switching
 * between open and resolved is instant and each tab can show its count.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { notFound, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useOrgHrefs } from '@cloud/org-routing'
import { BookOpen, LifeBuoy, Plus, Search, Sparkles, X } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  EmptyState, KitButton, KitButtonLink, KitInput, KitTab, KitTabs, PageHeader, Skeleton, StatusDot, Tag,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import {
  listSupportTickets, timeAgo, SupportApiError,
  type SupportLevel, type TicketSummary,
} from '@/lib/api/support'
import {
  SEVERITY_TAG_TONE, STATUS_BADGE, categoryLabel, formatDateTime, severityLabel, teamTargetLabel,
} from '@/components/support/presentation'

type Filter = 'open' | 'resolved' | 'all'

const OPEN = new Set(['open', 'waiting_on_customer'])

/** Search earns its place once there is something to search through. */
const SEARCH_THRESHOLD = 6

export default function SupportPage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <SupportCenter />
}

function SupportCenter() {
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('open')
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null)
  const [level, setLevel] = useState<SupportLevel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await listSupportTickets('all')
      setTickets(r.tickets)
      setLevel(r.level)
      setError(null)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push('/auth/login?redirect=/app/support')
        return
      }
      setError(e instanceof Error ? e.message : 'Could not load cases')
    }
  }, [router])

  useEffect(() => {
    load()
  }, [load])

  const counts = useMemo(() => {
    const all = tickets ?? []
    const open = all.filter((t) => OPEN.has(t.status)).length
    return { open, resolved: all.length - open, all: all.length }
  }, [tickets])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (tickets ?? []).filter((t) => {
      if (filter === 'open' && !OPEN.has(t.status)) return false
      if (filter === 'resolved' && OPEN.has(t.status)) return false
      if (!q) return true
      return (
        t.subject.toLowerCase().includes(q) ||
        `#${t.caseNumber}`.includes(q) ||
        categoryLabel(t.category).toLowerCase().includes(q)
      )
    })
  }, [tickets, filter, query])

  const waitingOnYou = (tickets ?? []).filter((t) => t.status === 'waiting_on_customer').length

  return (
    <OrgShell>
      <PageHeader
        title="Support"
        description="Backenly AI answers every case in seconds, and a person on the team reads and follows up on each one."
        actions={
          <KitButtonLink href="/app/support/new" variant="primary" icon={Plus}>
            New case
          </KitButtonLink>
        }
      />

      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <SupportLevelStrip level={level} />

        {waitingOnYou > 0 && (
          <p className="mt-4 flex items-center gap-2 text-[13px] text-zinc-300">
            <StatusDot tone="attention" />
            {waitingOnYou === 1 ? 'One case is waiting on your reply.' : `${waitingOnYou} cases are waiting on your reply.`}
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <KitTabs className="flex-1 border-b-0">
            <KitTab active={filter === 'open'} onClick={() => setFilter('open')} count={tickets ? counts.open : undefined}>
              Open
            </KitTab>
            <KitTab active={filter === 'resolved'} onClick={() => setFilter('resolved')} count={tickets ? counts.resolved : undefined}>
              Resolved
            </KitTab>
            <KitTab active={filter === 'all'} onClick={() => setFilter('all')} count={tickets ? counts.all : undefined}>
              All
            </KitTab>
          </KitTabs>
          {(tickets?.length ?? 0) >= SEARCH_THRESHOLD && (
            <div className="relative w-full pb-1.5 sm:w-[260px]">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-[calc(50%-3px)] h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
                strokeWidth={2}
              />
              <KitInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search cases…"
                aria-label="Search cases"
                className="pl-8 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className={`absolute right-1.5 top-[calc(50%-3px)] flex h-[24px] w-[24px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 hover:text-zinc-200 ${FOCUS}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className={`overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`}>
          {error ? (
            <EmptyState
              icon={LifeBuoy}
              title="Could not load your cases"
              description={error}
              action={<KitButton onClick={load}>Try again</KitButton>}
            />
          ) : tickets === null ? (
            <CaseListSkeleton />
          ) : tickets.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title="No cases yet"
              description="When something is broken or unclear, open a case. Backenly AI answers in seconds, and the team follows up on every case."
              action={
                <>
                  <KitButtonLink href="/app/support/new" variant="primary" icon={Plus}>
                    New case
                  </KitButtonLink>
                  <KitButtonLink href="/docs" icon={BookOpen} external>
                    Read the docs
                  </KitButtonLink>
                </>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={query ? Search : LifeBuoy}
              title={query ? 'No matching cases' : filter === 'open' ? 'No open cases' : 'No resolved cases yet'}
              description={
                query
                  ? `No case subject or number matches “${query.trim()}”.`
                  : filter === 'open'
                    ? 'Everything you filed is resolved. Open a new case if something comes up.'
                    : 'Cases you or the team mark resolved appear here.'
              }
              action={
                query ? (
                  <KitButton icon={X} onClick={() => setQuery('')}>
                    Clear search
                  </KitButton>
                ) : undefined
              }
            />
          ) : (
            <CaseList tickets={visible} />
          )}
        </div>
      </div>
    </OrgShell>
  )
}

/**
 * What the account's plan gets, as one strip: the instant answer, the team's
 * reply target, and the plan with the way to change it.
 */
function SupportLevelStrip({ level }: { level: SupportLevel | null }) {
  const orgHrefs = useOrgHrefs()
  const cells: Array<{ label: string; value: React.ReactNode; sub: React.ReactNode }> = [
    {
      label: 'Instant answer',
      value: (
        <span className="inline-flex items-center gap-1.5">
          <Sparkles aria-hidden className="h-3.5 w-3.5 text-violet-300" strokeWidth={1.75} />
          Backenly AI
        </span>
      ),
      sub: 'In seconds, grounded in the docs',
    },
    {
      label: 'Team reply',
      value: level ? teamTargetLabel(level.targetResponseHours) : <Skeleton className="h-[16px] w-24" />,
      sub: level?.priority ? 'Priority queue' : 'Every case is read by a person',
    },
    {
      label: 'Plan',
      value: level ? `${level.plan} support` : <Skeleton className="h-[16px] w-20" />,
      sub:
        level && level.allowedSeverities.length < 4 ? (
          <Link
            href={orgHrefs.billing}
            className={`rounded-[3px] text-zinc-300 underline decoration-white/20 underline-offset-[3px] hover:text-zinc-100 ${FOCUS}`}
          >
            Upgrade for production severities
          </Link>
        ) : (
          'Every severity, production down included'
        ),
    },
  ]
  return (
    <dl className={`grid grid-cols-1 overflow-hidden ${R_PANEL} border ${EDGE} bg-white/[0.06] sm:grid-cols-3 gap-px`}>
      {cells.map((c) => (
        <div key={c.label} className={`${PLATE} min-w-0 px-4 py-3.5`}>
          <dt className="text-[12px] leading-[16px] text-faint">{c.label}</dt>
          <dd className="mt-1.5 text-[14px] font-medium leading-[20px] text-zinc-100">{c.value}</dd>
          <dd className="mt-0.5 truncate text-[12px] leading-[17px] text-faint">{c.sub}</dd>
        </div>
      ))}
    </dl>
  )
}

const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_150px_150px_92px] md:items-center md:gap-4'

function CaseList({ tickets }: { tickets: TicketSummary[] }) {
  return (
    <>
      <div
        aria-hidden
        className={`hidden border-b ${RULE} bg-white/[0.015] px-4 py-2 text-[12px] font-medium text-faint ${ROW_GRID}`}
      >
        <span>Case</span>
        <span>Status</span>
        <span>Severity</span>
        <span className="text-right">Last update</span>
      </div>
      <ul className="divide-y divide-white/[0.05]">
        {tickets.map((t) => (
          <li key={t.id}>
            <CaseRow t={t} />
          </li>
        ))}
      </ul>
    </>
  )
}

function CaseRow({ t }: { t: TicketSummary }) {
  const status = STATUS_BADGE[t.status] ?? { tone: 'neutral' as const, label: t.status }
  const production = t.severity === 'high' || t.severity === 'urgent'
  return (
    <Link
      href={`/app/support/${t.id}`}
      className={`group block px-4 py-3 transition-colors duration-150 hover:bg-[#121316] ${ROW_GRID} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60`}
    >
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-medium leading-[20px] text-zinc-100 group-hover:text-white">{t.subject}</p>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] leading-[17px] text-faint">
          <span className="tabular-nums">#{t.caseNumber}</span>
          <span className="truncate">{categoryLabel(t.category)}</span>
          {t.aiState === 'replied' && (
            <span className="inline-flex items-center gap-1">
              <Sparkles aria-hidden className="h-3 w-3 text-violet-300" strokeWidth={2} />
              AI answered
            </span>
          )}
        </p>
      </div>
      <div className="mt-2 flex items-center gap-3 md:mt-0">
        <StatusDot tone={status.tone} label={<span className="text-[12.5px]">{status.label}</span>} />
        <span className="ml-auto text-[12px] tabular-nums text-faint md:hidden">{timeAgo(t.lastMessageAt)}</span>
      </div>
      <div className="mt-2 md:mt-0">
        {production ? (
          <Tag tone={SEVERITY_TAG_TONE[t.severity]}>{severityLabel(t.severity)}</Tag>
        ) : (
          <span className="text-[12.5px] text-zinc-400">{severityLabel(t.severity)}</span>
        )}
      </div>
      <time
        dateTime={t.lastMessageAt}
        title={formatDateTime(t.lastMessageAt)}
        className="hidden text-right text-[12px] tabular-nums text-faint md:block"
      >
        {timeAgo(t.lastMessageAt)}
      </time>
    </Link>
  )
}

function CaseListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading cases">
      <div className={`hidden border-b ${RULE} px-4 py-2 md:block`}>
        <Skeleton className="h-[12px] w-40" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className={`border-b ${RULE} px-4 py-3 last:border-b-0 ${ROW_GRID}`}>
          <div className="space-y-2">
            <Skeleton className="h-[13px] w-3/5" />
            <Skeleton className="h-[11px] w-2/5" />
          </div>
          <Skeleton className="mt-2 h-[12px] w-24 md:mt-0" />
          <Skeleton className="mt-2 hidden h-[12px] w-20 md:mt-0 md:block" />
          <Skeleton className="ml-auto hidden h-[12px] w-12 md:block" />
        </div>
      ))}
    </div>
  )
}
