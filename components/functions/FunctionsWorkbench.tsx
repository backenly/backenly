'use client'

/**
 * Functions workbench — the function list as an instrument surface.
 *
 * The old page stacked every function as a full-width card with its own action
 * row, its own error strip, and its own expandable run-result drawer, then put
 * a collapsed "Execution logs" accordion under the pile. Reading one function
 * meant scrolling past all the others, and a test run pushed everything below
 * it down the page.
 *
 * Rebuilt on the Tables/Storage pattern: a rail lists the functions, and the
 * selected one owns the rest of the viewport as a detail pane with tabs.
 * Overview carries the contract and the test runner; Invocations is that
 * function's own execution history rather than a global accordion.
 *
 * The workbench's inner layer is absolutely positioned so a wide log line
 * cannot push the app shell's flex chain sideways.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Play, Trash2, Power, Clock, Check, AlertCircle, Loader2, Database,
  UserPlus, RefreshCw, MousePointerClick, Globe, Plug2, Zap, ChevronRight,
  AlertTriangle, Info, Search, Link2, KeyRound, Copy,
} from 'lucide-react'
import { KitButton, KitConfirmDialog, EmptyState, KIT } from '@/components/inspector/kit'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AiFunctionLog {
  id: string
  functionId: string
  success: boolean
  logs: string[]
  error: string | null
  durationMs: number
  triggerType: string
  createdAt: string
  function?: { name: string; triggerType: string }
}

interface AiFunction {
  id: string
  name: string
  description: string
  triggerType: string
  triggerTable: string | null
  status: 'active' | 'inactive' | 'error'
  lastRun: string | null
  lastError: string | null
  runCount: number
  createdAt: string
}

interface TestRunResult {
  success: boolean
  logs: string[]
  error?: string
  errorCode?: string
  requiredPlan?: string
  durationMs: number
  /** Route-endpoint functions return the handler's HTTP response here. */
  returnValue?: { status?: number; body?: any } | any
}

// ─── Trigger normalisation ───────────────────────────────────────────────────
// HTTP-endpoint functions are stored with triggerType 'manual' and the route in
// triggerTable ("POST /api/v1/{id}/fn/{name}"); cron jobs store the cron
// expression there. Normalise both so the UI shows what actually fires.

const HTTP_ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+\S/i

function getTriggerKind(fn: AiFunction): string {
  if (fn.triggerType === 'manual' && fn.triggerTable && HTTP_ENDPOINT_RE.test(fn.triggerTable)) {
    return 'http'
  }
  return fn.triggerType
}

function getTriggerLabel(fn: AiFunction): string {
  switch (getTriggerKind(fn)) {
    case 'http': return `HTTP ${(fn.triggerTable || '').split(/\s+/)[0].toUpperCase()}`
    case 'on_signup': return 'On user signup'
    case 'on_db_insert': return `On insert → ${fn.triggerTable}`
    case 'on_db_update': return `On update → ${fn.triggerTable}`
    case 'on_db_delete': return `On delete → ${fn.triggerTable}`
    case 'cron': return `Scheduled · ${fn.triggerTable || 'cron'}`
    case 'manual': return 'Manual only'
    default: return fn.triggerType
  }
}

function TriggerIcon({ kind, className = 'h-3 w-3' }: { kind: string; className?: string }) {
  switch (kind) {
    case 'http': return <Globe className={className} />
    case 'on_signup': return <UserPlus className={className} />
    case 'on_db_insert': return <Database className={className} />
    case 'on_db_update': return <RefreshCw className={className} />
    case 'on_db_delete': return <Trash2 className={className} />
    case 'cron': return <Clock className={className} />
    case 'manual': return <MousePointerClick className={className} />
    default: return <Clock className={className} />
  }
}

// Muted mono tints, no pill chrome: endpoints = sky, inserts = emerald,
// updates/signup = violet, deletes = rose, schedules + manual = neutral.
function getTriggerStyle(kind: string): string {
  switch (kind) {
    case 'http': return 'text-sky-300/90'
    case 'on_signup': return 'text-violet-300/90'
    case 'on_db_insert': return 'text-emerald-300/90'
    case 'on_db_update': return 'text-violet-300/90'
    case 'on_db_delete': return 'text-rose-300/90'
    case 'cron': return 'text-zinc-300'
    default: return 'text-zinc-500'
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never run'
  const diffMs = Date.now() - new Date(dateStr).getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  return `${Math.floor(diffMs / 86_400_000)}d ago`
}

/** Admin-gated business endpoints authenticate with the project's x-admin-key. */
function isAdminGated(fn: AiFunction): boolean {
  return /^admin[-_]/i.test(fn.name)
}

const adminKeyCache = new Map<string, Promise<string | null>>()
function fetchAdminKey(projectId: string): Promise<string | null> {
  if (!adminKeyCache.has(projectId)) {
    const token = localStorage.getItem('auth-token')
    adminKeyCache.set(
      projectId,
      fetch(`/api/projects/${projectId}/ai-functions/admin-key`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.adminKey ?? null)
        .catch(() => null)
    )
  }
  return adminKeyCache.get(projectId)!
}

function getEndpointUrl(fn: AiFunction): string | null {
  if (getTriggerKind(fn) !== 'http' || !fn.triggerTable) return null
  const path = fn.triggerTable.split(/\s+/)[1]
  if (!path) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${path}`
}

// Auto-generated schema-query helpers: no business logic, always manual, never
// run. They are real endpoints, just noise in the list.
const SCHEMA_FN_RE = /(-schema|-full|_schema|_full)$|(^workspaces?-|^workspace_)/i
function isSchemaQueryFunction(fn: AiFunction): boolean {
  return SCHEMA_FN_RE.test(fn.name) && fn.triggerType === 'manual' && fn.runCount === 0
}

const TRIGGER_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'http', label: 'Endpoints' },
  { key: 'on_signup', label: 'Signup' },
  { key: 'on_db_insert', label: 'Insert' },
  { key: 'on_db_update', label: 'Update' },
  { key: 'on_db_delete', label: 'Delete' },
  { key: 'cron', label: 'Scheduled' },
  { key: 'manual', label: 'Manual' },
]

const authHeaders = (json = false): Record<string, string> => {
  const token = localStorage.getItem('auth-token')
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// ─── Invocations tab ─────────────────────────────────────────────────────────

function InvocationsTab({ projectId, functionId }: { projectId: string; functionId: string }) {
  const [logs, setLogs] = useState<AiFunctionLog[]>([])
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(50)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/projects/${projectId}/ai-functions/logs?limit=${limit}&functionId=${functionId}`,
          { headers: authHeaders(), credentials: 'include' }
        )
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) setLogs(data.data || [])
        }
      } catch { /* leave the list as-is */ }
      if (!cancelled) setLoading(false)
    }
    run()
    return () => { cancelled = true }
  }, [projectId, functionId, limit])

  if (loading && logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-4 w-4 animate-spin text-white/30" />
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No invocations yet"
        description="Runs appear here the moment this function fires, with its logs, duration, and any error."
      />
    )
  }

  return (
    <div className={`divide-y ${KIT.divide}`}>
      {logs.map((log) => (
        <div key={log.id} className="px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {log.success ? (
                <Check className="h-3 w-3 flex-shrink-0 text-emerald-400/80" />
              ) : (
                <AlertCircle className="h-3 w-3 flex-shrink-0 text-rose-300" />
              )}
              <span className={`font-mono text-[11px] font-medium ${log.success ? 'text-zinc-300' : 'text-rose-300'}`}>
                {log.success ? 'success' : 'failed'}
              </span>
              <span className="font-mono text-[10px] text-zinc-600">{log.triggerType}</span>
            </div>
            <div className="flex flex-shrink-0 items-center gap-3 font-mono text-[10.5px] tabular-nums text-zinc-600">
              <span>{log.durationMs}ms</span>
              <span>{new Date(log.createdAt).toLocaleString()}</span>
            </div>
          </div>

          {log.logs.length > 0 && (
            <div className="space-y-0.5">
              {log.logs.map((line, i) => (
                <div key={i} className="font-mono text-[11px] leading-5 text-zinc-500">
                  <span className="mr-2 text-zinc-700">›</span>
                  {line}
                </div>
              ))}
            </div>
          )}

          {log.error && <div className="mt-1 font-mono text-[11px] text-rose-300">{log.error}</div>}
        </div>
      ))}

      {logs.length >= limit && (
        <button
          onClick={() => setLimit((l) => l + 50)}
          className="w-full py-2.5 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Load more
        </button>
      )}
    </div>
  )
}

// ─── Run result ──────────────────────────────────────────────────────────────

function RunResult({ result, onClose }: { result: TestRunResult; onClose: () => void }) {
  const rv: any = result.returnValue
  const isHttp = rv && typeof rv === 'object' && typeof rv.status === 'number'
  const httpStatus: number | undefined = isHttp ? rv.status : undefined
  const httpBody = isHttp ? rv.body : rv
  const client4xx = httpStatus != null && httpStatus >= 400 && httpStatus < 500

  // A plan-limit block is not a code failure — the function is fine, the quota
  // is the constraint.
  if (result.errorCode === 'PLAN_LIMIT_EXCEEDED') {
    return (
      <div className="rounded-lg border border-white/[0.07] bg-black/25 p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
            <AlertTriangle className="h-3 w-3" />
            Plan limit reached
          </span>
          <button onClick={onClose} className="text-[10.5px] text-zinc-600 transition-colors hover:text-zinc-400">
            close
          </button>
        </div>
        <p className="mb-2.5 text-[11.5px] leading-relaxed text-zinc-400">
          {result.error} Your function code is fine. It wasn&apos;t run because the monthly invocation
          quota is used up. It resets on the 1st.
        </p>
        <a
          href="/app/settings?tab=billing"
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-300 transition-colors hover:text-violet-200"
        >
          Upgrade for a higher quota →
        </a>
      </div>
    )
  }

  // A 4xx from a handler means the endpoint WORKED and answered. Only thrown
  // errors are real failures.
  const headColor = !result.success ? 'text-rose-300' : client4xx ? 'text-violet-300' : 'text-emerald-300'
  const headText = !result.success
    ? 'Failed'
    : httpStatus != null
    ? `Returned HTTP ${httpStatus} · ${result.durationMs}ms`
    : `Completed in ${result.durationMs}ms`

  let bodyStr = ''
  if (httpBody != null) {
    try {
      bodyStr = typeof httpBody === 'string' ? httpBody : JSON.stringify(httpBody, null, 2)
    } catch {
      bodyStr = String(httpBody)
    }
  }

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/25 p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${headColor}`}>
          {!result.success ? (
            <AlertCircle className="h-3 w-3" />
          ) : client4xx ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {headText}
        </span>
        <button onClick={onClose} className="text-[10.5px] text-zinc-600 transition-colors hover:text-zinc-400">
          close
        </button>
      </div>

      {client4xx && (
        <p className="mb-2 text-[10.5px] leading-relaxed text-violet-300/70">
          {httpStatus === 400
            ? 'The endpoint ran and validated its input. It needs required parameters this test run didn’t send, and will work when your app calls it with a real payload.'
            : httpStatus === 401 || httpStatus === 403
            ? 'Test runs call the endpoint with your project’s admin credentials. This response means the endpoint additionally checks ownership of specific records or a credential this test didn’t carry. The auth gate itself is working.'
            : httpStatus === 404
            ? 'The endpoint ran correctly. The test run’s synthetic user has no matching records yet, so it answered 404 as designed.'
            : `The endpoint ran and answered HTTP ${httpStatus}, a client-side response from its own validation logic, not a code failure.`}
        </p>
      )}

      {result.logs.length > 0 && (
        <div className="space-y-0.5">
          {result.logs.map((log, i) => (
            <div key={i} className="font-mono text-[11px] leading-5 text-zinc-400">
              <span className="mr-2 text-zinc-700">›</span>
              {log}
            </div>
          ))}
        </div>
      )}

      {bodyStr && (
        <pre className="mt-2 max-h-48 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.08] bg-black/30 px-3 py-2 font-mono text-[11px] text-zinc-400">
          {bodyStr.slice(0, 2000)}
          {bodyStr.length > 2000 ? '\n…(truncated)' : ''}
        </pre>
      )}

      {result.error && <div className="mt-1 font-mono text-[11px] text-rose-300">{result.error}</div>}
    </div>
  )
}

// ─── Workbench ───────────────────────────────────────────────────────────────

export function FunctionsWorkbench({ projectId }: { projectId: string }) {
  const router = useRouter()

  const [functions, setFunctions] = useState<AiFunction[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'invocations'>('overview')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')

  const [cleaningUp, setCleaningUp] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<TestRunResult | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AiFunction | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchFunctions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions`, {
        headers: authHeaders(),
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        setFunctions(data.functions || [])
      }
    } catch { /* leave the list as-is */ }
    setLoading(false)
  }, [projectId])

  useEffect(() => { fetchFunctions() }, [fetchFunctions])

  const flash = (key: string) => {
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: functions.length }
    for (const f of functions) {
      const kind = getTriggerKind(f)
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    return counts
  }, [functions])

  const visibleFunctions = useMemo(() => {
    let list = filter === 'all' ? functions : functions.filter((f) => getTriggerKind(f) === filter)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.description || '').toLowerCase().includes(q) ||
          (f.triggerTable || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [functions, filter, query])

  // Keep a selection alive as filters change: the reader is browsing, and an
  // empty detail pane next to a populated rail reads as broken.
  useEffect(() => {
    if (visibleFunctions.length === 0) return
    if (!selectedId || !visibleFunctions.some((f) => f.id === selectedId)) {
      setSelectedId(visibleFunctions[0].id)
    }
  }, [visibleFunctions, selectedId])

  useEffect(() => { setRunResult(null); setTab('overview') }, [selectedId])

  const selected = selectedId ? functions.find((f) => f.id === selectedId) ?? null : null

  const activeFns = functions.filter((f) => f.status === 'active')
  const errorFns = functions.filter((f) => f.status === 'error')
  const totalRuns = functions.reduce((sum, f) => sum + f.runCount, 0)
  const schemaFns = functions.filter(isSchemaQueryFunction)
  const untestedActiveFns = functions.filter(
    (f) => f.runCount === 0 && f.status === 'active' && !isSchemaQueryFunction(f)
  )

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleRun = async (fn: AiFunction) => {
    setRunning(true)
    setRunResult(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
        method: 'POST',
        headers: authHeaders(true),
        credentials: 'include',
        body: JSON.stringify({ event: {} }),
      })
      const data = await res.json()
      setRunResult(data.result)
    } catch (err: any) {
      setRunResult({ success: false, logs: [], error: err.message, durationMs: 0 })
    } finally {
      setRunning(false)
    }
  }

  const handleToggle = async (fn: AiFunction) => {
    const nextActive = fn.status === 'inactive'
    try {
      await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
        method: 'PUT',
        headers: authHeaders(true),
        credentials: 'include',
        body: JSON.stringify({ status: nextActive ? 'active' : 'inactive' }),
      })
      setFunctions((prev) =>
        prev.map((f) => (f.id === fn.id ? { ...f, status: nextActive ? 'active' : 'inactive' } : f))
      )
    } catch { /* the toggle simply does not move */ }
  }

  const performDelete = async (fn: AiFunction) => {
    setBusy(true)
    try {
      await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
        credentials: 'include',
      })
      setFunctions((prev) => prev.filter((f) => f.id !== fn.id))
      if (selectedId === fn.id) setSelectedId(null)
    } finally {
      setBusy(false)
      setConfirmDelete(null)
    }
  }

  const performCleanup = async () => {
    const toDelete = functions.filter(isSchemaQueryFunction)
    if (!toDelete.length) return
    setCleaningUp(true)
    try {
      await Promise.allSettled(
        toDelete.map((fn) =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
            method: 'DELETE',
            headers: authHeaders(),
            credentials: 'include',
          })
        )
      )
      setFunctions((prev) => prev.filter((f) => !toDelete.some((d) => d.id === f.id)))
    } finally {
      setCleaningUp(false)
      setConfirmCleanup(false)
    }
  }

  const handleRunAllUntested = async () => {
    if (!untestedActiveFns.length) return
    setRunningAll(true)
    try {
      await Promise.allSettled(
        untestedActiveFns.map((fn) =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
            method: 'POST',
            headers: authHeaders(true),
            credentials: 'include',
            body: JSON.stringify({ event: {} }),
          })
        )
      )
      await fetchFunctions()
    } finally {
      setRunningAll(false)
    }
  }

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      flash(key)
    } catch { /* clipboard unavailable */ }
  }

  const copyAdminKey = async () => {
    const key = await fetchAdminKey(projectId)
    if (key) copy(key, 'adminkey')
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const endpointUrl = selected ? getEndpointUrl(selected) : null

  return (
    <div className={`flex h-[calc(100vh-48px)] flex-col overflow-hidden ${KIT.bg}`}>

      {/* ── Command bar ───────────────────────────────────── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
            <Zap className="h-3 w-3" />
            Inspector
          </span>
          <span className="h-3 w-px bg-white/10" />
          <h1 className="text-[13px] font-semibold text-zinc-100">Functions</h1>
          <span
            className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium ${
              errorFns.length > 0 ? 'text-rose-300' : activeFns.length > 0 ? 'text-emerald-300/90' : 'text-zinc-400'
            }`}
          >
            <span
              className={`h-[5px] w-[5px] rounded-full ${
                errorFns.length > 0 ? 'bg-rose-400' : activeFns.length > 0 ? 'bg-emerald-400' : 'bg-zinc-500'
              }`}
            />
            {errorFns.length > 0 ? `${errorFns.length} errored` : activeFns.length > 0 ? 'operational' : 'idle'}
          </span>
          {functions.length > 0 && (
            <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">{functions.length}</span>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-3">
          <span className="hidden font-mono text-[10.5px] tabular-nums text-zinc-600 sm:inline">
            {activeFns.length} active<span className="text-zinc-700"> · </span>
            {totalRuns.toLocaleString()} run{totalRuns === 1 ? '' : 's'}
          </span>
          <button
            onClick={() => router.push(`/app/projects/${projectId}/connect`)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/50"
          >
            <Plug2 className="h-3 w-3" />
            New function
          </button>
        </div>
      </div>

      {/* Advisories — flush strips, not floating cards */}
      {schemaFns.length > 0 && (
        <div className="flex h-9 flex-shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">
          <Info className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
          <p className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500">
            <span className="font-medium text-zinc-300">
              {schemaFns.length} auto-generated validation-schema endpoint{schemaFns.length !== 1 ? 's' : ''}
            </span>
            <span className="text-zinc-600">. Safe to keep; they return live form-validation schemas.</span>
          </p>
          <button
            onClick={() => setConfirmCleanup(true)}
            disabled={cleaningUp}
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-white/[0.12] hover:bg-white/[0.04] hover:text-zinc-200 disabled:opacity-50"
          >
            {cleaningUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            {cleaningUp ? 'Deleting…' : 'Delete all'}
          </button>
        </div>
      )}

      {untestedActiveFns.length > 0 && (
        <div className="flex h-9 flex-shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-violet-300" />
          <p className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-400">
            <span className="font-semibold text-zinc-200">
              {untestedActiveFns.length} active function{untestedActiveFns.length !== 1 ? 's' : ''} never tested
            </span>
            <span className="text-zinc-600">. Verify at least one run before going live.</span>
          </p>
          <button
            onClick={handleRunAllUntested}
            disabled={runningAll}
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-white/[0.14] bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-zinc-100 transition-colors hover:bg-white/[0.10] disabled:opacity-50"
          >
            {runningAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {runningAll ? 'Running…' : 'Run all'}
          </button>
        </div>
      )}

      {/* ── Workbench ─────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">

          {/* ── Rail ───────────────────────────────────── */}
          <div className={`flex w-[280px] flex-shrink-0 flex-col border-r border-white/[0.06] ${KIT.rail}`}>
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Functions</span>
              <button
                onClick={() => { setLoading(true); fetchFunctions() }}
                className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
                title="Refresh"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {functions.length > 0 && (
              <div className="flex-shrink-0 space-y-2 border-b border-white/[0.06] p-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="text"
                    placeholder="Search functions…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-7 w-full rounded-lg border border-white/[0.07] bg-[#0f1015] pl-7 pr-3 text-[11.5px] text-zinc-300 transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {TRIGGER_FILTERS.map((f) => {
                    const count = filterCounts[f.key] ?? 0
                    if (f.key !== 'all' && count === 0) return null
                    const active = filter === f.key
                    return (
                      <button
                        key={f.key}
                        onClick={() => setFilter(f.key)}
                        className={`rounded-md border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                          active
                            ? 'border-white/[0.14] bg-white/[0.08] text-zinc-100'
                            : 'border-white/[0.07] text-zinc-500 hover:border-white/[0.10] hover:text-zinc-300'
                        }`}
                      >
                        {f.label} <span className="tabular-nums opacity-50">{count}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
              {loading && functions.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-white/30" />
                </div>
              ) : functions.length === 0 ? (
                <div className="space-y-3 px-4 py-6 text-center">
                  <Zap className="mx-auto h-4 w-4 text-zinc-600" />
                  <div>
                    <p className="mb-0.5 text-[12px] font-semibold text-zinc-200">No functions yet</p>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Tell your coding agent what should happen and Backenly wires it up.
                    </p>
                  </div>
                </div>
              ) : visibleFunctions.length === 0 ? (
                <p className="px-4 py-6 text-center text-[11.5px] leading-relaxed text-zinc-600">
                  No function matches{query.trim() ? ` “${query.trim()}”` : ' this filter'}.
                </p>
              ) : (
                <div className="space-y-px px-2">
                  {visibleFunctions.map((fn) => {
                    const active = selectedId === fn.id
                    const kind = getTriggerKind(fn)
                    return (
                      <div
                        key={fn.id}
                        onClick={() => setSelectedId(fn.id)}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] transition-colors ${
                          active ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                        } ${fn.status === 'inactive' ? 'opacity-55' : ''}`}
                      >
                        <div
                          className={`h-[5px] w-[5px] flex-shrink-0 rounded-full ${
                            fn.status === 'active'
                              ? 'bg-emerald-400'
                              : fn.status === 'error'
                              ? 'bg-rose-400'
                              : 'bg-zinc-700'
                          }`}
                          title={fn.status}
                        />
                        <div className="min-w-0 flex-1">
                          <div
                            className={`truncate font-mono text-[12px] ${active ? 'text-zinc-50' : 'text-zinc-300'}`}
                          >
                            {fn.name}
                          </div>
                          <div
                            className={`mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] ${getTriggerStyle(kind)}`}
                          >
                            <TriggerIcon kind={kind} className="h-2.5 w-2.5 flex-shrink-0" />
                            <span className="truncate">{getTriggerLabel(fn)}</span>
                          </div>
                        </div>
                        <ChevronRight
                          className={`h-3 w-3 flex-shrink-0 transition-colors ${
                            active ? 'text-zinc-500' : 'text-transparent group-hover:text-zinc-700'
                          }`}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {functions.length > 0 && (
              <div className="flex h-7 flex-shrink-0 items-center border-t border-white/[0.06] px-3 font-mono text-[10.5px] tabular-nums text-zinc-600">
                {query.trim() || filter !== 'all'
                  ? `${visibleFunctions.length} of ${functions.length}`
                  : `${functions.length} function${functions.length === 1 ? '' : 's'}`}
              </div>
            )}
          </div>

          {/* ── Detail ─────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center px-8">
                <EmptyState
                  icon={Zap}
                  title={functions.length === 0 ? 'No functions yet' : 'Select a function'}
                  description={
                    functions.length === 0
                      ? 'Tell your connected coding agent what should happen, like a welcome email on signup or a webhook on new orders. Functions run automatically, no deployment needed.'
                      : 'Pick a function from the list to see its trigger, endpoint, and invocation history.'
                  }
                  action={
                    functions.length === 0 ? (
                      <KitButton
                        variant="primary"
                        icon={Plug2}
                        onClick={() => router.push(`/app/projects/${projectId}/connect`)}
                      >
                        Create with your agent
                      </KitButton>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                {/* Toolbar */}
                <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">{selected.name}</h2>
                    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-500">
                      {selected.runCount.toLocaleString()} run{selected.runCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    {isAdminGated(selected) && (
                      <button
                        onClick={copyAdminKey}
                        title="Copy admin key (send as x-admin-key header)"
                        className={`rounded-md p-1.5 transition-colors ${
                          copied === 'adminkey'
                            ? 'bg-emerald-500/[0.08] text-emerald-300'
                            : 'text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-100'
                        }`}
                      >
                        {copied === 'adminkey' ? <Check className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    {endpointUrl && (
                      <button
                        onClick={() => copy(endpointUrl, 'url')}
                        title="Copy endpoint URL"
                        className={`rounded-md p-1.5 transition-colors ${
                          copied === 'url'
                            ? 'bg-emerald-500/[0.08] text-emerald-300'
                            : 'text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-100'
                        }`}
                      >
                        {copied === 'url' ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    <button
                      onClick={() => handleToggle(selected)}
                      title={selected.status === 'inactive' ? 'Enable' : 'Disable'}
                      className={`rounded-md p-1.5 transition-colors ${
                        selected.status === 'active'
                          ? 'text-emerald-300 hover:bg-emerald-500/[0.08]'
                          : 'text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-100'
                      }`}
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(selected)}
                      title="Delete"
                      className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-rose-500/[0.08] hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <span className="mx-1 h-3 w-px bg-white/10" />
                    <button
                      onClick={() => handleRun(selected)}
                      disabled={running || selected.status === 'inactive'}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      {running ? 'Running…' : 'Test run'}
                    </button>
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-3">
                  {([
                    ['overview', 'Overview'],
                    ['invocations', 'Invocations'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setTab(key)}
                      className={`-mb-px border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus:outline-none ${
                        tab === key
                          ? 'border-violet-400 text-zinc-50'
                          : 'border-transparent text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Tab body */}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {tab === 'overview' ? (
                    <div className="space-y-4 p-4">
                      {selected.description && (
                        <p className="max-w-3xl text-[12.5px] leading-5 text-zinc-400">{selected.description}</p>
                      )}

                      {selected.status === 'error' && selected.lastError && (
                        <div className="rounded-lg border border-rose-500/15 bg-rose-500/[0.05] px-3 py-2.5 font-mono text-[11px] leading-5 text-rose-300/90">
                          {selected.lastError}
                        </div>
                      )}

                      {runResult && <RunResult result={runResult} onClose={() => setRunResult(null)} />}

                      {/* Contract */}
                      <dl className={`overflow-hidden rounded-lg border ${KIT.border} divide-y ${KIT.divide}`}>
                        {[
                          ['Trigger', getTriggerLabel(selected)],
                          ['Status', selected.status],
                          ['Runs', selected.runCount.toLocaleString()],
                          ['Last run', formatRelativeTime(selected.lastRun)],
                          ['Created', new Date(selected.createdAt).toLocaleString()],
                        ].map(([label, value]) => (
                          <div key={label} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                            <dt className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                              {label}
                            </dt>
                            <dd
                              className={`min-w-0 truncate text-right font-mono text-[11.5px] tabular-nums ${
                                label === 'Status'
                                  ? selected.status === 'active'
                                    ? 'text-emerald-300/90'
                                    : selected.status === 'error'
                                    ? 'text-rose-300'
                                    : 'text-zinc-500'
                                  : 'text-zinc-300'
                              }`}
                            >
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>

                      {/* Endpoint */}
                      {endpointUrl && (
                        <div>
                          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                            Endpoint
                          </p>
                          <div className="flex items-center gap-1.5">
                            <code className="min-w-0 flex-1 truncate rounded-md border border-white/[0.06] bg-[#0f1015] px-2.5 py-2 font-mono text-[11px] text-zinc-400">
                              <span className="text-sky-300/90">
                                {(selected.triggerTable || '').split(/\s+/)[0].toUpperCase()}
                              </span>{' '}
                              {endpointUrl}
                            </code>
                            <button
                              onClick={() => copy(endpointUrl, 'url2')}
                              className="flex-shrink-0 rounded-md p-2 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                              title="Copy endpoint URL"
                            >
                              {copied === 'url2' ? (
                                <Check className="h-3.5 w-3.5 text-emerald-300" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                          {isAdminGated(selected) && (
                            <p className="mt-1.5 text-[11px] leading-snug text-zinc-600">
                              Admin-gated. Send the project admin key as an <code className="font-mono text-zinc-500">x-admin-key</code> header.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <InvocationsTab projectId={projectId} functionId={selected.id} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <KitConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) performDelete(confirmDelete) }}
        title="Delete function?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" will stop running and be removed permanently. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete function"
        danger
        busy={busy}
      />

      <KitConfirmDialog
        open={confirmCleanup}
        onCancel={() => setConfirmCleanup(false)}
        onConfirm={performCleanup}
        title={`Delete ${schemaFns.length} schema endpoint${schemaFns.length !== 1 ? 's' : ''}?`}
        description="These auto-generated validation-schema endpoints will be removed permanently. Your frontend will no longer be able to fetch live form-validation schemas from them."
        confirmLabel="Delete all"
        danger
        busy={cleaningUp}
      />
    </div>
  )
}
