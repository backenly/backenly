'use client'

/**
 * /app/support: your support cases (Backenly Cloud).
 *
 *   Support  ◆ 1 waiting on you                                  [New case]
 *   Backenly AI answers in seconds. A person reads every case.
 *   Open 3   Resolved 1   All 4
 *   ◆  Webhook retries stopped after the region move   Production impaired   Team replied 40m ago
 *      Waiting on you  #1043  API & runtime  checkout-api
 *
 * Every case gets an instant answer from Backenly AI in its thread, and a
 * person on the team follows up. Off Cloud the surface does not exist
 * (notFound, like /app/usage): a self-hosted install has no support team.
 *
 * One request loads every case (the API returns the latest 100), so switching
 * between open and resolved is instant and each tab can show its count. A case
 * names its project by id; the names come from the projects the person can
 * see, read alongside.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { notFound, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { Plus, Search, X } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { KitButton, KitButtonLink, KitInput, KitTab, KitTabs, PageHeader, Skeleton } from '@/components/inspector/kit'
import { EDGE, FOCUS, FOCUS_INSET, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { getProjects } from '@/lib/api/projects'
import { listSupportTickets, SupportApiError, type TicketSummary } from '@/lib/api/support'
import {
  COMMUNITY_URL, caseState, categoryLabel, formatDateTime, isOpenStatus, lastReplyText,
} from '@/components/support/presentation'
import { CaseGlyph, ExternalLink, SeverityTag } from '@/components/support/parts'

type Filter = 'open' | 'resolved' | 'all'

/** Search earns its place once there is something to search through. */
const SEARCH_THRESHOLD = 6

const PANEL = `overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`
/** Phone: glyph | case, the severity and last reply under it. md+: one line of columns. */
const ROW_GRID =
  'grid grid-cols-[12px_minmax(0,1fr)] gap-x-[14px] md:grid-cols-[12px_minmax(0,1fr)_152px_176px] md:items-center md:gap-x-[20px]'

export default function SupportPage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <SupportCenter />
}

function SupportCenter() {
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('open')
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null)
  const [projectNames, setProjectNames] = useState<Map<string, string>>(() => new Map())
  const [error, setError] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const [cases, projects] = await Promise.allSettled([listSupportTickets('all'), getProjects()])
    if (cases.status === 'rejected') {
      if (cases.reason instanceof SupportApiError && cases.reason.status === 401) {
        router.push('/auth/login?redirect=/app/support')
        return
      }
      setError(true)
      return
    }
    // A project name is a nicety: without the list, a case simply does not name it.
    if (projects.status === 'fulfilled') setProjectNames(new Map(projects.value.map((p) => [p.id, p.name])))
    setTickets(cases.value.tickets)
    setError(false)
  }, [router])

  useEffect(() => {
    load()
  }, [load])

  const retry = async () => {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  const counts = useMemo(() => {
    const all = tickets ?? []
    const open = all.filter((t) => isOpenStatus(t.status)).length
    return { open, resolved: all.length - open, all: all.length }
  }, [tickets])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (tickets ?? []).filter((t) => {
      if (filter === 'open' && !isOpenStatus(t.status)) return false
      if (filter === 'resolved' && isOpenStatus(t.status)) return false
      if (!q) return true
      return (
        t.subject.toLowerCase().includes(q) ||
        `#${t.caseNumber}`.includes(q) ||
        categoryLabel(t.category).toLowerCase().includes(q) ||
        (t.projectId ? (projectNames.get(t.projectId) ?? '').toLowerCase().includes(q) : false)
      )
    })
  }, [tickets, filter, query, projectNames])

  const waiting = (tickets ?? []).filter((t) => t.status === 'waiting_on_customer').length
  const hasCases = counts.all > 0

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader
          flush
          title="Support"
          meta={
            waiting > 0 ? (
              <span className="inline-flex items-center gap-[6px] text-[13px] font-medium tabular-nums text-zinc-50">
                <span aria-hidden>
                  <CaseGlyph state="waiting" />
                </span>
                {waiting} waiting on you
              </span>
            ) : null
          }
          description="Backenly AI answers in seconds. A person reads every case."
          actions={
            <KitButtonLink href="/app/support/new" variant="primary" size="lg" icon={Plus}>
              New case
            </KitButtonLink>
          }
        />

        {hasCases && (
          <div className="mb-[12px] flex flex-col gap-[10px] sm:flex-row sm:items-end sm:justify-between">
            <KitTabs className="-ml-[8px] flex-1 border-b-0">
              <KitTab active={filter === 'open'} onClick={() => setFilter('open')} count={counts.open}>
                Open
              </KitTab>
              <KitTab active={filter === 'resolved'} onClick={() => setFilter('resolved')} count={counts.resolved}>
                Resolved
              </KitTab>
              <KitTab active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
                All
              </KitTab>
            </KitTabs>
            {counts.all >= SEARCH_THRESHOLD && <CaseSearch query={query} onChange={setQuery} />}
          </div>
        )}

        <div className={PANEL}>
          {error && !tickets ? (
            <PanelLine>
              <span className="min-w-0 flex-1">Could not load your cases.</span>
              <KitButton size="sm" onClick={retry} loading={retrying}>
                Try again
              </KitButton>
            </PanelLine>
          ) : tickets === null ? (
            <CaseListSkeleton />
          ) : !hasCases ? (
            <PanelLine>No cases yet.</PanelLine>
          ) : visible.length === 0 ? (
            <PanelLine>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {query.trim()
                  ? `No case matches “${query.trim()}”.`
                  : filter === 'open'
                    ? 'No open cases.'
                    : 'No resolved cases yet.'}
              </span>
              {query.trim() && (
                <KitButton size="sm" variant="ghost" icon={X} onClick={() => setQuery('')}>
                  Clear search
                </KitButton>
              )}
            </PanelLine>
          ) : (
            <CaseList tickets={visible} projectNames={projectNames} />
          )}
        </div>

        {tickets !== null && !hasCases && (
          <p className="mt-[12px] text-[12.5px] leading-[18px] text-faint">
            Questions about building with Backenly?{' '}
            <ExternalLink href={COMMUNITY_URL}>Ask the community on Discord</ExternalLink>.
          </p>
        )}
      </div>
    </OrgShell>
  )
}

function CaseSearch({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  return (
    <div className="relative w-full sm:w-[260px]">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-[10px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
        strokeWidth={2}
      />
      <KitInput
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search cases"
        aria-label="Search cases"
        className="!pl-[32px] !pr-[32px]"
      />
      {query && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className={`absolute right-[6px] top-1/2 flex h-[24px] w-[24px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 hover:text-zinc-200 ${FOCUS}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/** The panel's one line: empty, nothing matching, or the list could not be read. */
function PanelLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[16px] py-[15px] text-[13px] leading-[20px] text-zinc-300 sm:px-[20px]">
      {children}
    </div>
  )
}

function CaseList({ tickets, projectNames }: { tickets: TicketSummary[]; projectNames: Map<string, string> }) {
  return (
    <>
      <div
        aria-hidden
        className={`hidden border-b ${RULE} bg-white/[0.015] px-[20px] py-[9px] text-[12px] font-medium leading-[16px] text-faint md:grid ${ROW_GRID}`}
      >
        <span className="col-span-2">Case</span>
        <span>Severity</span>
        <span className="text-right">Last reply</span>
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {tickets.map((t) => (
          <li key={t.id}>
            <CaseRow t={t} project={t.projectId ? projectNames.get(t.projectId) ?? null : null} />
          </li>
        ))}
      </ul>
    </>
  )
}

function CaseRow({ t, project }: { t: TicketSummary; project: string | null }) {
  const state = caseState(t.status)
  return (
    <Link
      href={`/app/support/${t.id}`}
      className={`group ${ROW_GRID} px-[16px] py-[13px] transition-colors duration-150 hover:bg-[#121316] sm:px-[20px] ${FOCUS_INSET}`}
    >
      <CaseGlyph state={state} className="mt-[4px] self-start md:mt-0 md:self-center" />
      <div className="min-w-0">
        <p className="text-[14px] font-medium leading-[21px] text-zinc-100 [overflow-wrap:anywhere] group-hover:text-white">
          {t.subject}
        </p>
        <p className="mt-[3px] flex flex-wrap items-center gap-x-[14px] gap-y-[2px] text-[12.5px] leading-[18px] text-faint">
          {state === 'waiting' && <span className="font-medium text-zinc-50">Waiting on you</span>}
          <span className="tabular-nums">#{t.caseNumber}</span>
          <span>{categoryLabel(t.category)}</span>
          {project && <span className="min-w-0 [overflow-wrap:anywhere]">{project}</span>}
        </p>
      </div>
      <div className="col-start-2 mt-[8px] flex flex-wrap items-center gap-x-[12px] gap-y-[6px] md:contents">
        <span className="empty:hidden md:block md:empty:block">
          <SeverityTag severity={t.severity} />
        </span>
        <time
          dateTime={t.lastMessageAt}
          title={formatDateTime(t.lastMessageAt)}
          className="text-[12.5px] leading-[18px] tabular-nums text-faint md:text-right"
        >
          {lastReplyText(t.lastMessageBy, t.lastMessageAt)}
        </time>
      </div>
    </Link>
  )
}

function CaseListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading cases">
      <div className={`hidden border-b ${RULE} px-[20px] py-[11px] md:block`}>
        <Skeleton className="h-[12px] w-[160px]" />
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {[0, 1, 2].map((i) => (
          <li key={i} className={`${ROW_GRID} px-[16px] py-[15px] sm:px-[20px]`}>
            <Skeleton className="mt-[3px] h-[12px] w-[12px] !rounded-full md:mt-0" />
            <div className="space-y-[7px]">
              <Skeleton className="h-[13px] w-3/5" />
              <Skeleton className="h-[11px] w-2/5" />
            </div>
            <span className="hidden md:block" />
            <Skeleton className="ml-auto hidden h-[12px] w-[128px] md:block" />
          </li>
        ))}
      </ul>
    </div>
  )
}
