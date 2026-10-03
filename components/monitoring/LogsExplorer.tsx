'use client'

/**
 * Logs explorer.
 *
 * `/api/logs` has had eight tenant-isolated, zod-validated filters and paging
 * for as long as it has existed, and nothing in the dashboard called it. The
 * backend was complete; the surface was missing. This is that surface, and it
 * adds no new server capability.
 *
 * Lives as a tab inside the monitoring workbench rather than as a new sidebar
 * entry. Logs are read during an incident, next to the metrics that started it,
 * and the information architecture is deliberately two levels deep.
 *
 * Every state the route can produce is rendered: loading, empty because nothing
 * has been logged, empty because the filters exclude everything (a different
 * situation needing a different action), and failed. The last one matters most
 * — a log viewer that silently shows nothing when the query errored tells an
 * operator the system is quiet during exactly the incident it is not.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, RefreshCw, Search, X } from 'lucide-react'
import { EmptyState, IconButton, INPUT_BASE, KitButton, StatusDot } from '@/components/inspector/kit'
import { FileText } from 'lucide-react'

type Severity = 'error' | 'warning' | 'info' | 'debug'

export interface LogRow {
  id: string
  type: string
  severity: string
  message: string
  service?: string | null
  endpoint?: string | null
  method?: string | null
  statusCode?: number | null
  duration?: number | null
  timestamp: string
}

interface LogsResponse {
  logs: LogRow[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
  stats: { total: number } & Record<Severity, number>
}

const TYPES = ['all', 'api', 'auth', 'database', 'function', 'system'] as const
const SEVERITIES = ['all', 'error', 'warning', 'info', 'debug'] as const

const SEVERITY_TONE: Record<string, string> = {
  error: 'text-rose-300',
  warning: 'text-amber-200',
  info: 'text-zinc-300',
  debug: 'text-zinc-500',
}

const SEVERITY_DOT: Record<string, 'failed' | 'attention' | 'neutral'> = {
  error: 'failed',
  warning: 'attention',
}

const SELECT = '[color-scheme:dark] h-[30px] rounded-[7px] border border-white/[0.08] bg-[#08090a] pl-2.5 pr-7 text-[16px] text-zinc-200 transition-colors hover:border-white/[0.12] focus:border-violet-300/50 focus:outline-none focus:ring-[3px] focus:ring-violet-400/15 sm:text-[13px]'

const PAGE_SIZE = 50

export function LogsExplorer({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<LogRow[]>([])
  const [stats, setStats] = useState<LogsResponse['stats'] | null>(null)
  const [pagination, setPagination] = useState<LogsResponse['pagination'] | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [type, setType] = useState<(typeof TYPES)[number]>('all')
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('all')
  const [search, setSearch] = useState('')
  // Separate from `search` so typing does not fire a request per keystroke.
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState(1)

  const filtersActive = type !== 'all' || severity !== 'all' || appliedSearch !== ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        projectId,
        page: String(page),
        limit: String(PAGE_SIZE),
      })
      if (type !== 'all') params.set('type', type)
      if (severity !== 'all') params.set('severity', severity)
      if (appliedSearch) params.set('search', appliedSearch)

      const res = await fetch(`/api/logs?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // The status is included because 403 (tenant isolation) and 500 mean
        // very different things to whoever is reading this during an incident.
        throw new Error(body.error || `Request failed with ${res.status}`)
      }
      const data: LogsResponse = await res.json()
      setRows(data.logs ?? [])
      setStats(data.stats ?? null)
      setPagination(data.pagination ?? null)
    } catch (err: any) {
      // Rows are cleared deliberately. Leaving the previous page on screen under
      // an error banner reads as "these are the current logs", which is the one
      // impression a failed log query must not give.
      setRows([])
      setStats(null)
      setPagination(null)
      setError(err?.message || 'Could not load logs')
    } finally {
      setLoading(false)
    }
  }, [projectId, page, type, severity, appliedSearch])

  useEffect(() => { void load() }, [load])

  const applySearch = () => {
    setPage(1)
    setAppliedSearch(search.trim())
  }

  const clearFilters = () => {
    setType('all')
    setSeverity('all')
    setSearch('')
    setAppliedSearch('')
    setPage(1)
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* ── Filter bar ─────────────────────────────────────── */}
      <div className="flex min-h-[44px] flex-shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 sm:px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applySearch() }}
            onBlur={applySearch}
            placeholder="Search logs…"
            aria-label="Search logs"
            type="search"
            className={`${INPUT_BASE} h-[30px] w-56 pl-8 pr-2.5 sm:w-72`}
          />
        </div>

        <select
          value={type}
          onChange={(e) => { setPage(1); setType(e.target.value as typeof type) }}
          aria-label="Filter by type"
          className={SELECT}
        >
          {TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>)}
        </select>

        <select
          value={severity}
          onChange={(e) => { setPage(1); setSeverity(e.target.value as typeof severity) }}
          aria-label="Filter by severity"
          className={SELECT}
        >
          {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All severities' : s}</option>)}
        </select>

        {filtersActive && (
          <KitButton size="sm" variant="ghost" icon={X} onClick={clearFilters}>
            Clear
          </KitButton>
        )}

        <div className="ml-auto flex items-center gap-3">
          {stats && (
            <div className="hidden items-center gap-3 text-[12px] tabular-nums text-zinc-500 md:flex">
              {/* Tinted only when there is something to look at. */}
              {(['error', 'warning'] as const).map((sev) => (
                <StatusDot
                  key={sev}
                  tone={stats[sev] > 0 ? (sev === 'error' ? 'failed' : 'attention') : 'neutral'}
                  label={`${stats[sev].toLocaleString()} ${sev === 'error' ? (stats[sev] === 1 ? 'error' : 'errors') : stats[sev] === 1 ? 'warning' : 'warnings'}`}
                />
              ))}
              <span>{stats.info.toLocaleString()} info</span>
              <span>{stats.debug.toLocaleString()} debug</span>
            </div>
          )}
          <IconButton
            icon={RefreshCw}
            label="Refresh logs"
            onClick={() => void load()}
            className={loading ? '[&_svg]:animate-spin' : ''}
          />
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex h-full items-center justify-center px-8">
            <div className="max-w-md rounded-[10px] border border-rose-400/20 bg-rose-500/[0.05] px-4 py-3.5">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
                <div>
                  <p className="text-[13px] font-medium text-rose-200">Could not load logs</p>
                  <p className="mt-1 font-mono text-[12px] text-rose-200/70">{error}</p>
                  <p className="mt-2 text-[12px] text-zinc-400">
                    Nothing is shown because this query failed, not because the
                    system was quiet.
                  </p>
                  <KitButton variant="secondary" onClick={() => void load()} className="mt-2.5">
                    Try again
                  </KitButton>
                </div>
              </div>
            </div>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Loading logs
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-8">
            {/* Two different nothings. "No logs at all" is a new deployment;
                "nothing matches" is a filter the operator can undo, and
                offering "clear filters" for the first would be nonsense. */}
            {filtersActive ? (
              <EmptyState
                icon={Search}
                title="No logs match these filters"
                description="Nothing was recorded for this combination. Widen the search or clear the filters."
                action={<KitButton variant="secondary" onClick={clearFilters}>Clear filters</KitButton>}
              />
            ) : (
              <EmptyState
                icon={FileText}
                title="No logs yet"
                description="Requests, auth events and database activity appear here as your backend runs."
              />
            )}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-[#0e0f11]">
              <tr>
                {['Time', 'Severity', 'Type', 'Message', 'Endpoint', 'Status', 'Duration'].map((h, i) => (
                  <th
                    key={h}
                    className={`h-[36px] whitespace-nowrap border-b border-white/[0.06] px-3 text-[12px] font-medium text-zinc-500 ${i >= 5 ? 'text-right' : 'text-left'}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-[#121316]">
                  <td className="whitespace-nowrap border-b border-white/[0.04] px-3 py-[9px] text-[12px] tabular-nums text-zinc-500">
                    {new Date(r.timestamp).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap border-b border-white/[0.04] px-3 py-[9px]">
                    <StatusDot tone={SEVERITY_DOT[r.severity] ?? 'neutral'} label={<span className={SEVERITY_TONE[r.severity] ?? 'text-zinc-400'}>{r.severity}</span>} />
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[12px] text-zinc-500">{r.type}</td>
                  <td className="border-b border-white/[0.04] px-3 py-[9px] text-[12.5px] text-zinc-200">{r.message}</td>
                  <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[12px] text-zinc-500">
                    {r.method ? `${r.method} ` : ''}{r.endpoint ?? ''}
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-[9px] text-right text-[12px] tabular-nums text-zinc-500">
                    {r.statusCode ?? ''}
                  </td>
                  <td className="border-b border-white/[0.04] px-3 py-[9px] text-right text-[12px] tabular-nums text-zinc-500">
                    {r.duration != null ? `${r.duration} ms` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Paging ─────────────────────────────────────────── */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex h-[40px] flex-shrink-0 items-center justify-between border-t border-white/[0.06] px-4">
          <span className="text-[12px] tabular-nums text-zinc-500">
            {pagination.total} entries · page {pagination.page} of {pagination.totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pagination.page <= 1 || loading}
              className="h-[26px] rounded-[6px] px-2.5 text-[12.5px] font-medium text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={pagination.page >= pagination.totalPages || loading}
              className="h-[26px] rounded-[6px] px-2.5 text-[12.5px] font-medium text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
