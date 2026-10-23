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
import Link from 'next/link'
import {
  Play, Trash2, Power, Clock, Check, AlertCircle, Database,
  UserPlus, RefreshCw, MousePointerClick, Globe, Zap, ChevronRight,
  AlertTriangle, Info, Search, Link2, KeyRound, ChevronLeft, Plus, X,
} from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import {
  AgentPrompt, BarDivider, CommandBar, CopyField, EmptyState, IconButton, INPUT_BASE, KIT, KitButton,
  KitConfirmDialog, KitModal, KitTab, KitTabs, NoticeStrip, Spinner, StatusDot,
} from '@/components/inspector/kit'
import { formatStamp } from '@/components/console/format'
import { AgentEmptyState, ConnectAgentLink } from '@/components/inspector/AgentEmptyState'
import { FOCUS_INSET } from '@/components/console/tokens'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'

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
  /** The deployed source, exactly as stored — what actually runs. */
  generatedCode?: string | null
  /** 'generated' (Backenly's model) | 'agent' (deploy_code, stored verbatim). */
  codeOrigin?: string
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

// The trigger is the one thing that tells two functions apart at a glance, so
// only its icon carries a tint; the label stays neutral and readable.
function getTriggerStyle(kind: string): string {
  switch (kind) {
    case 'http': return 'text-sky-300/80'
    case 'on_signup': return 'text-violet-300/80'
    case 'on_db_insert': return 'text-emerald-300/80'
    case 'on_db_update': return 'text-violet-300/80'
    case 'on_db_delete': return 'text-rose-300/80'
    default: return 'text-zinc-500'
  }
}

const STATUS_TONE = { active: 'operational', inactive: 'paused', error: 'failed' } as const
const STATUS_LABEL = { active: 'Active', inactive: 'Disabled', error: 'Errored' } as const

/** Requests for the empty state and New function: what people actually ask for first. */
const EXAMPLE_PROMPTS = [
  'When a user signs up, send them a welcome email.',
  'Add POST /checkout that validates the cart, creates an order and returns its id.',
  'Every night at 02:00, delete sessions older than 30 days.',
]

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
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
//
// codeOrigin is the gate that keeps "Remove all" honest: the name pattern
// alone matched any agent-deployed function named like `*-schema` with no run
// yet, and the bulk cleanup deleted it as an "auto-generated endpoint". Only
// Backenly-generated rows ('generated' — also the backfill for rows that
// predate the column) qualify; anything deployed verbatim through
// deploy_code ('agent') is someone's code, never cleanup fodder.
const SCHEMA_FN_RE = /(-schema|-full|_schema|_full)$|(^workspaces?-|^workspace_)/i
function isSchemaQueryFunction(fn: AiFunction): boolean {
  return (
    fn.codeOrigin !== 'agent' &&
    SCHEMA_FN_RE.test(fn.name) &&
    fn.triggerType === 'manual' &&
    fn.runCount === 0
  )
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

/**
 * Read-only view of the stored source — what the runtime actually executes.
 * deploy_code hands the human a codeSha256 receipt; the hash here is computed
 * from the SAME stored bytes, so the owner can compare the two without
 * trusting either side's summary. Before this tab existed the agent docs
 * claimed the dashboard showed stored code, and it showed none.
 */
function CodeTab({ code }: { code: string | null }) {
  const [sha, setSha] = useState<string | null>(null)
  useEffect(() => {
    setSha(null)
    if (!code || typeof crypto === 'undefined' || !crypto.subtle) return
    let cancelled = false
    crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(code))
      .then((buf) => {
        if (cancelled) return
        setSha(Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [code])

  if (!code) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-10">
        <EmptyState
          icon={Info}
          title="No stored source"
          description="This function has no code stored yet. Functions deployed with deploy_code or generated by Backenly keep their exact source here."
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 px-4 py-5 sm:px-5">
      {sha && (
        <p className="font-mono text-[12px] text-zinc-500">
          sha256 <span className="select-all text-zinc-300">{sha}</span>
          <span className="ml-2 text-zinc-600">matches the deploy_code receipt when the stored code is what was deployed</span>
        </p>
      )}
      <pre className="overflow-x-auto rounded-[10px] border border-white/[0.07] bg-[#08090a] px-4 py-3 font-mono text-[12px] leading-[19px] text-zinc-300">
        {code}
      </pre>
    </div>
  )
}

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
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Spinner className="h-4 w-4" />
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No invocations yet"
        description="Runs appear here the moment this function fires, with its logs, duration and any error."
      />
    )
  }

  return (
    <div>
      <div className="grid h-[36px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-white/[0.06] bg-[#0e0f11] px-5 text-[12px] font-medium text-zinc-500">
        <span>Result</span>
        <span className="w-16 text-right">Duration</span>
        <span className="w-44 text-right">When</span>
      </div>
      <ol className="divide-y divide-white/[0.05]">
        {logs.map((log) => (
          <li key={log.id} className="px-5 py-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4">
              <div className="flex min-w-0 items-center gap-3">
                {/* The log records whether the handler returned, not its HTTP status. */}
                <StatusDot tone={log.success ? 'operational' : 'failed'} label={log.success ? 'Completed' : 'Failed'} />
                <span className="truncate font-mono text-[12px] text-zinc-500">{log.triggerType}</span>
              </div>
              <span className="w-16 whitespace-nowrap text-right text-[12.5px] tabular-nums text-zinc-300">{log.durationMs} ms</span>
              <time
                dateTime={new Date(log.createdAt).toISOString()}
                title={new Date(log.createdAt).toLocaleString()}
                className="w-44 whitespace-nowrap text-right text-[12.5px] tabular-nums text-zinc-500"
              >
                {new Date(log.createdAt).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
                })}
              </time>
            </div>

            {(log.logs.length > 0 || log.error) && (
              <div className="mt-2.5 rounded-[7px] border border-white/[0.06] bg-[#08090a] px-3 py-2">
                {log.logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-zinc-400">
                    {line}
                  </div>
                ))}
                {log.error && (
                  <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-rose-300">{log.error}</div>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      {logs.length >= limit && (
        <div className="border-t border-white/[0.05] px-5 py-3">
          <KitButton size="sm" variant="ghost" onClick={() => setLimit((l) => l + 50)} loading={loading}>
            Load 50 more
          </KitButton>
        </div>
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
  // A 5xx is the handler failing, whatever the runner reported.
  const server5xx = httpStatus != null && httpStatus >= 500

  // A plan-limit block is not a code failure — the function is fine, the quota
  // is the constraint.
  if (result.errorCode === 'PLAN_LIMIT_EXCEEDED') {
    return (
      <ResultFrame
        tone="attention"
        heading="Plan limit reached"
        onClose={onClose}
      >
        <p className="text-[13px] leading-[20px] text-zinc-300">
          {result.error} Your function code is fine. It wasn&apos;t run because this month&apos;s invocation quota is
          used up, and it resets on the 1st.
        </p>
        {CLOUD_CONTROL_PLANE && (
          <Link href="/app/billing" className="mt-3 inline-flex text-[13px] font-medium text-zinc-100 underline decoration-white/25 underline-offset-4 hover:decoration-white/60">
            See plans with a higher quota
          </Link>
        )}
      </ResultFrame>
    )
  }

  // A 4xx from a handler means the endpoint WORKED and answered. Thrown errors
  // and 5xx responses are real failures.
  const tone = !result.success || server5xx ? 'failed' : client4xx ? 'attention' : 'operational'
  const heading = !result.success
    ? 'Run failed'
    : httpStatus != null
    ? `Returned HTTP ${httpStatus}`
    : 'Run completed'

  let bodyStr = ''
  if (httpBody != null) {
    try {
      bodyStr = typeof httpBody === 'string' ? httpBody : JSON.stringify(httpBody, null, 2)
    } catch {
      bodyStr = String(httpBody)
    }
  }

  return (
    <ResultFrame tone={tone} heading={heading} meta={`${result.durationMs} ms`} onClose={onClose}>
      {client4xx && (
        <p className="mb-3 text-[13px] leading-[20px] text-zinc-400">
          {httpStatus === 400
            ? 'The endpoint answered 400 to the empty test event. If its code validates input, it will answer normally when your app sends a real payload. The response body below shows what it said.'
            : httpStatus === 401 || httpStatus === 403
            ? 'Test runs call the endpoint with your project’s admin credentials. This response means the endpoint also checks ownership of specific records, or a credential this run didn’t carry. The auth gate itself is working.'
            : httpStatus === 404
            ? 'The endpoint ran correctly. The test run’s synthetic user has no matching records yet, so it answered 404 as designed.'
            : `The endpoint ran and answered HTTP ${httpStatus}, a response from its own validation logic rather than a code failure.`}
        </p>
      )}

      {(result.logs.length > 0 || bodyStr || result.error) && (
        <div className="rounded-[7px] border border-white/[0.06] bg-[#08090a] px-3 py-2.5">
          {result.logs.map((log, i) => (
            <div key={i} className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-zinc-400">
              {log}
            </div>
          ))}
          {bodyStr && (
            <pre className={`max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-zinc-300 ${result.logs.length ? 'mt-2 border-t border-white/[0.06] pt-2' : ''}`}>
              {bodyStr.slice(0, 2000)}
              {bodyStr.length > 2000 ? '\n…(truncated)' : ''}
            </pre>
          )}
          {result.error && (
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-rose-300">{result.error}</div>
          )}
        </div>
      )}
    </ResultFrame>
  )
}

function ResultFrame({
  tone,
  heading,
  meta,
  onClose,
  children,
}: {
  tone: 'operational' | 'attention' | 'failed'
  heading: string
  meta?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <section
      aria-live="polite"
      className="rounded-[10px] border border-white/[0.08] bg-[#111214] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="flex h-[40px] items-center justify-between gap-3 border-b border-white/[0.06] pl-4 pr-1.5">
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={tone} label={<span className="text-[13px] font-medium">{heading}</span>} />
          {meta && <span className="text-[12px] tabular-nums text-zinc-500">{meta}</span>}
        </div>
        <IconButton icon={X} label="Dismiss result" onClick={onClose} />
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

// ─── Workbench ───────────────────────────────────────────────────────────────

export function FunctionsWorkbench({ projectId }: { projectId: string }) {
  const [functions, setFunctions] = useState<AiFunction[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'code' | 'invocations'>('overview')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list')
  const [showNew, setShowNew] = useState(false)
  // Functions come from the agent, so the empty state and New function point
  // at it: Connect until it is connected, then just the asks to send it.
  const agent = useAgentConnection(projectId)

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

  /** Loaded, and the project has no function yet: the first-run state. */
  const noFunctions = !loading && functions.length === 0
  const activeFns = functions.filter((f) => f.status === 'active')
  const errorFns = functions.filter((f) => f.status === 'error')
  const totalRuns = functions.reduce((sum, f) => sum + f.runCount, 0)
  const schemaFns = functions.filter(isSchemaQueryFunction)
  const untestedActiveFns = functions.filter(
    (f) => f.runCount === 0 && f.status === 'active' && !isSchemaQueryFunction(f)
  )
  const runnableUntestedFns = untestedActiveFns.filter((fn) => {
    const kind = getTriggerKind(fn)
    return kind === 'manual' || kind === 'http'
  })

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
      // The run is recorded server-side; refresh so Runs and Last run move.
      fetchFunctions()
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
    // Only endpoint-style functions get the bulk treatment. An event-triggered
    // handler (on insert/update/signup/cron) run with an EMPTY event executes
    // its real body — database writes, emails, quota — against a payload shape
    // it will never see in production. Those are tested one at a time, from
    // their own pane, where the owner can see what each run did.
    const runnable = runnableUntestedFns
    if (!runnable.length) return
    setRunningAll(true)
    try {
      await Promise.allSettled(
        runnable.map((fn) =>
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
  const endpointMethod = selected ? (selected.triggerTable || '').split(/\s+/)[0].toUpperCase() : ''

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>

      {/* ── Command bar ───────────────────────────────────── */}
      <CommandBar
        title="Functions"
        context={
          functions.length > 0 ? (
            <>
              <StatusDot
                tone={activeFns.length > 0 ? 'operational' : 'paused'}
                label={<span className="tabular-nums">{activeFns.length} of {functions.length} active</span>}
              />
              {errorFns.length > 0 && <StatusDot tone="failed" label={`${errorFns.length} errored`} />}
              <span className="hidden tabular-nums sm:inline">
                {totalRuns.toLocaleString()} {totalRuns === 1 ? 'run' : 'runs'}
              </span>
            </>
          ) : undefined
        }
      >
        <KitButton size="sm" icon={Plus} onClick={() => setShowNew(true)}>
          New function
        </KitButton>
      </CommandBar>

      {/* Advisories — flush strips under the bar, never floating cards. */}
      {untestedActiveFns.length > 0 && (
        <NoticeStrip
          icon={AlertCircle}
          tone="attention"
          action={
            runnableUntestedFns.length > 0 ? (
              <KitButton size="sm" icon={Play} loading={runningAll} onClick={handleRunAllUntested}>
                {runningAll ? 'Running…' : `Run ${runnableUntestedFns.length === untestedActiveFns.length ? 'all' : `${runnableUntestedFns.length} endpoint${runnableUntestedFns.length === 1 ? '' : 's'}`} once`}
              </KitButton>
            ) : undefined
          }
        >
          <strong>
            {untestedActiveFns.length} active {untestedActiveFns.length === 1 ? 'function has' : 'functions have'} never run.
          </strong>{' '}
          Run each once before your app depends on it. Test runs execute for real: database writes, emails
          and quota all count. Event-triggered functions are skipped here; test each from its own pane.
        </NoticeStrip>
      )}
      {schemaFns.length > 0 && (
        <NoticeStrip
          icon={Info}
          action={
            <KitButton size="sm" variant="ghost" icon={Trash2} loading={cleaningUp} onClick={() => setConfirmCleanup(true)}>
              {cleaningUp ? 'Removing…' : 'Remove all'}
            </KitButton>
          }
        >
          <strong>
            {schemaFns.length} auto-generated validation-schema {schemaFns.length === 1 ? 'endpoint' : 'endpoints'}.
          </strong>{' '}
          <span className="text-zinc-500">Safe to keep: they serve live form-validation schemas to your frontend.</span>
        </NoticeStrip>
      )}

      {/* ── Workbench ─────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">

          {/* ── Rail ─────────────────────────────────────
              A project with no functions has no rail at any width: the pane
              carries the empty state with its request and Connect, and the
              rail only repeated "No functions yet" (on a phone, instead of
              them). */}
          <div
            className={`w-full flex-shrink-0 flex-col border-r border-white/[0.06] md:w-[288px] ${KIT.rail} ${
              noFunctions ? 'hidden' : mobilePane !== 'list' ? 'hidden md:flex' : 'flex'
            }`}
          >
            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-4 pr-2">
              <span className="text-[13px] font-medium text-zinc-200">All functions</span>
              <IconButton
                icon={RefreshCw}
                label="Refresh"
                onClick={() => { setLoading(true); fetchFunctions() }}
                className={loading ? '[&_svg]:animate-spin' : ''}
              />
            </div>

            {functions.length > 0 && (
              <div className="flex-shrink-0 space-y-2 border-b border-white/[0.06] p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="search"
                    aria-label="Search functions"
                    placeholder="Search functions…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className={`${INPUT_BASE} h-[30px] pl-8 pr-2.5`}
                  />
                </div>
                <div role="radiogroup" aria-label="Filter by trigger" className="flex flex-wrap items-center gap-1">
                  {TRIGGER_FILTERS.map((f) => {
                    const count = filterCounts[f.key] ?? 0
                    if (f.key !== 'all' && count === 0) return null
                    const on = filter === f.key
                    return (
                      <button
                        key={f.key}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setFilter(f.key)}
                        className={`inline-flex h-[24px] items-center gap-1.5 rounded-[6px] px-2 text-[12px] font-medium transition-colors ${FOCUS_INSET} ${
                          on ? 'bg-white/[0.09] text-zinc-50' : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200'
                        }`}
                      >
                        {f.label}
                        <span className={`tabular-nums ${on ? 'text-zinc-400' : 'text-zinc-600'}`}>{count}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
              {loading && functions.length === 0 ? (
                <div className="space-y-1 px-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3 rounded-[7px] px-2.5 py-2.5">
                      <span className="h-[6px] w-[6px] rounded-full bg-white/[0.08]" />
                      <div className="flex-1 space-y-1.5">
                        <span className="block h-2.5 w-2/3 animate-pulse rounded bg-white/[0.06]" />
                        <span className="block h-2 w-1/3 animate-pulse rounded bg-white/[0.04]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : functions.length === 0 ? null : visibleFunctions.length === 0 ? (
                <p className="px-4 py-5 text-[12.5px] leading-[19px] text-zinc-500">
                  No function matches{query.trim() ? ` “${query.trim()}”` : ' this filter'}.
                </p>
              ) : (
                <ul className="space-y-px px-2">
                  {visibleFunctions.map((fn) => {
                    const active = selectedId === fn.id
                    const kind = getTriggerKind(fn)
                    return (
                      <li key={fn.id}>
                        <button
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => { setSelectedId(fn.id); setMobilePane('detail') }}
                          className={`group flex w-full items-center gap-3 rounded-[7px] px-2.5 py-2 text-left transition-colors ${FOCUS_INSET} ${
                            active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                          }`}
                        >
                          <StatusDot tone={STATUS_TONE[fn.status] ?? 'neutral'} className="flex-shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate font-mono text-[12.5px] leading-[18px] ${
                                active ? 'text-zinc-50' : fn.status === 'inactive' ? 'text-zinc-500' : 'text-zinc-200'
                              }`}
                            >
                              {fn.name}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] leading-[16px] text-zinc-500">
                              <TriggerIcon kind={kind} className={`h-3 w-3 flex-shrink-0 ${getTriggerStyle(kind)}`} />
                              <span className="truncate">{getTriggerLabel(fn)}</span>
                            </span>
                          </span>
                          <ChevronRight
                            className={`h-3.5 w-3.5 flex-shrink-0 md:hidden ${active ? 'text-zinc-500' : 'text-zinc-700'}`}
                          />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {functions.length > 0 && (
              <div className="flex h-[36px] flex-shrink-0 items-center border-t border-white/[0.06] px-4 text-[12px] tabular-nums text-zinc-500">
                {query.trim() || filter !== 'all'
                  ? `${visibleFunctions.length} of ${functions.length}`
                  : `${functions.length} ${functions.length === 1 ? 'function' : 'functions'}`}
              </div>
            )}
          </div>

          {/* ── Detail ─────────────────────────────────── */}
          <div className={`min-w-0 flex-1 flex-col ${noFunctions || mobilePane === 'detail' ? 'flex' : 'hidden md:flex'}`}>
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-6">
                {functions.length === 0 ? (
                  <AgentEmptyState
                    projectId={projectId}
                    icon={Zap}
                    title="No functions yet"
                    description="Server-side logic for your app: endpoints, scheduled jobs and code that runs when data changes. Your agent writes them, and they go live without a deploy."
                    prompt={EXAMPLE_PROMPTS[0]}
                    docs="functions"
                    preview="code"
                  />
                ) : (
                  <EmptyState
                    icon={Zap}
                    title="Select a function"
                    description="Choose a function to see its trigger, endpoint and invocation history."
                  />
                )}
              </div>
            ) : (
              <>
                {/* Toolbar */}
                <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 sm:px-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setMobilePane('list')}
                      className="-ml-1 flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded-[7px] bg-white/[0.04] text-zinc-200 transition-colors hover:bg-white/[0.07] md:hidden"
                      aria-label="Back to functions"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <h2 className="truncate font-mono text-[13px] font-medium text-zinc-50">{selected.name}</h2>
                    <StatusDot
                      tone={STATUS_TONE[selected.status] ?? 'neutral'}
                      label={STATUS_LABEL[selected.status] ?? selected.status}
                      className="hidden sm:inline-flex"
                    />
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {isAdminGated(selected) && (
                      <IconButton
                        icon={copied === 'adminkey' ? Check : KeyRound}
                        label={copied === 'adminkey' ? 'Admin key copied' : 'Copy admin key (sent as x-admin-key)'}
                        onClick={copyAdminKey}
                        className={copied === 'adminkey' ? '!text-emerald-300' : ''}
                      />
                    )}
                    {endpointUrl && (
                      <IconButton
                        icon={copied === 'url' ? Check : Link2}
                        label={copied === 'url' ? 'Endpoint URL copied' : 'Copy endpoint URL'}
                        onClick={() => copy(endpointUrl, 'url')}
                        className={copied === 'url' ? '!text-emerald-300' : ''}
                      />
                    )}
                    <IconButton
                      icon={Power}
                      label={selected.status === 'inactive' ? 'Enable function' : 'Disable function'}
                      onClick={() => handleToggle(selected)}
                      active={selected.status !== 'inactive'}
                    />
                    <IconButton icon={Trash2} label="Delete function" onClick={() => setConfirmDelete(selected)} className="hover:!text-rose-300" />
                    <BarDivider />
                    <KitButton
                      size="sm"
                      variant="primary"
                      icon={Play}
                      loading={running}
                      onClick={() => handleRun(selected)}
                      disabled={selected.status === 'inactive'}
                      title={selected.status === 'inactive' ? 'Enable the function to run it' : 'Runs for real with an empty event: writes, emails and quota count'}
                    >
                      {running ? 'Running…' : 'Test run'}
                    </KitButton>
                  </div>
                </div>

                {/* Tabs */}
                <KitTabs className="flex-shrink-0 px-3 sm:px-4">
                  <KitTab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</KitTab>
                  <KitTab active={tab === 'code'} onClick={() => setTab('code')}>Code</KitTab>
                  <KitTab active={tab === 'invocations'} onClick={() => setTab('invocations')} count={selected.runCount}>
                    Invocations
                  </KitTab>
                </KitTabs>

                {/* Tab body */}
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={`${selected.name}, ${tab}`}
                  className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_INSET}`}
                >
                  {tab === 'overview' ? (
                    <div className="max-w-[880px] space-y-6 px-4 py-5 sm:px-5">
                      {selected.description && (
                        <p className="max-w-[72ch] text-[13px] leading-[20px] text-zinc-300 [text-wrap:pretty]">{selected.description}</p>
                      )}

                      {selected.status === 'error' && selected.lastError && (
                        <div className="rounded-[10px] border border-rose-400/20 bg-rose-500/[0.05] px-4 py-3">
                          <p className="text-[12px] font-medium text-rose-200">Last error</p>
                          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-rose-300/90">
                            {selected.lastError}
                          </p>
                        </div>
                      )}

                      {runResult && <RunResult result={runResult} onClose={() => setRunResult(null)} />}

                      {/* Contract */}
                      <dl className="overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#111214]">
                        {([
                          ['Trigger', (
                            <span key="t" className="inline-flex items-center gap-1.5">
                              <TriggerIcon kind={getTriggerKind(selected)} className={`h-3.5 w-3.5 ${getTriggerStyle(getTriggerKind(selected))}`} />
                              {getTriggerLabel(selected)}
                            </span>
                          )],
                          ['Status', (
                            <StatusDot key="s" tone={STATUS_TONE[selected.status] ?? 'neutral'} label={STATUS_LABEL[selected.status] ?? selected.status} />
                          )],
                          ['Runs', selected.runCount.toLocaleString()],
                          ['Last run', formatRelativeTime(selected.lastRun)],
                          ['Created', formatStamp(selected.createdAt)],
                        ] as Array<[string, React.ReactNode]>).map(([label, value], i) => (
                          <div
                            key={label}
                            className={`grid grid-cols-[120px_minmax(0,1fr)] items-center gap-4 px-4 py-2.5 ${i > 0 ? 'border-t border-white/[0.05]' : ''}`}
                          >
                            <dt className="text-[13px] text-zinc-500">{label}</dt>
                            <dd className="min-w-0 truncate text-[13px] tabular-nums text-zinc-200">{value}</dd>
                          </div>
                        ))}
                      </dl>

                      {/* Endpoint */}
                      {endpointUrl && (
                        <section>
                          <h3 className="mb-2 text-[13px] font-medium text-zinc-200">Endpoint</h3>
                          <CopyField
                            value={endpointUrl}
                            display={
                              <>
                                <span className="mr-2 text-sky-300/90">{endpointMethod}</span>
                                {endpointUrl}
                              </>
                            }
                          />
                          {isAdminGated(selected) && (
                            <p className="mt-2 text-[12.5px] leading-[19px] text-zinc-500">
                              Admin-gated: send the project admin key as the{' '}
                              <code className="font-mono text-zinc-300">x-admin-key</code> header.
                            </p>
                          )}
                        </section>
                      )}
                    </div>
                  ) : tab === 'code' ? (
                    <CodeTab code={selected.generatedCode ?? null} />
                  ) : (
                    <InvocationsTab projectId={projectId} functionId={selected.id} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* New function: created by the agent, so this is the sentence to send it. */}
      <KitModal
        open={showNew}
        onClose={() => setShowNew(false)}
        title="New function"
        description="Functions are written by your agent and go live without a deploy. Send it one of these requests, or describe what should happen in your own words."
        width="max-w-lg"
        footer={
          <>
            <KitButton variant={agent.needsConnect ? 'ghost' : 'secondary'} onClick={() => setShowNew(false)}>Close</KitButton>
            {agent.needsConnect && <ConnectAgentLink projectId={projectId} />}
          </>
        }
      >
        <AgentPrompt prompt={EXAMPLE_PROMPTS} />
      </KitModal>

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
        title={`Remove ${schemaFns.length} schema endpoint${schemaFns.length !== 1 ? 's' : ''}?`}
        description="These auto-generated validation-schema endpoints will be removed permanently. Your frontend will no longer be able to fetch live form-validation schemas from them."
        confirmLabel="Remove all"
        danger
        busy={cleaningUp}
      />
    </div>
  )
}
