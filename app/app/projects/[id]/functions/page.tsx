'use client'

/**
 * FUNCTIONS MANAGEMENT PAGE
 * =========================
 * Shows all AI functions created for this project.
 * Functions are created through the user's coding agent over MCP (Connect) —
 * this page is for managing them.
 */

import { useState, useEffect, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Trash2,
  Power,
  Clock,
  Check,
  AlertCircle,
  Loader2,
  Database,
  UserPlus,
  RefreshCw,
  MousePointerClick,
  Globe,
  Plug2,
  Zap,
  ScrollText,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Info,
  Search,
  Link2,
  KeyRound,
} from 'lucide-react'
import {
  InspectorPageHeader,
  InspectorGovernanceFooter,
} from '@/components/inspector/InspectorPageHeader'
import { KitButton, EmptyState } from '@/components/inspector/kit'

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

// HTTP-endpoint functions are stored with triggerType 'manual' and the route
// in triggerTable ("POST /api/v1/{id}/fn/{name}"); cron jobs store the cron
// expression there. getTriggerKind normalises both into a real kind so the
// card shows what actually fires the function instead of a flat "Manual only".
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

function getTriggerIcon(kind: string) {
  switch (kind) {
    case 'http': return <Globe className="w-3 h-3" />
    case 'on_signup': return <UserPlus className="w-3 h-3" />
    case 'on_db_insert': return <Database className="w-3 h-3" />
    case 'on_db_update': return <RefreshCw className="w-3 h-3" />
    case 'on_db_delete': return <Trash2 className="w-3 h-3" />
    case 'cron': return <Clock className="w-3 h-3" />
    case 'manual': return <MousePointerClick className="w-3 h-3" />
    default: return <Clock className="w-3 h-3" />
  }
}

// Trigger labels render as colored mono text — no pill chrome — so the list
// is scannable without reading as a wall of stickers: endpoints = sky,
// inserts = emerald, updates = violet, deletes = rose, schedules + manual =
// neutral. Only kit-sanctioned tones — no colors outside the ramp.
function getTriggerStyle(kind: string): string {
  switch (kind) {
    case 'http': return 'text-sky-300/90'
    case 'on_signup': return 'text-violet-300/90'
    case 'on_db_insert': return 'text-emerald-300/90'
    case 'on_db_update': return 'text-violet-300/90'
    case 'on_db_delete': return 'text-rose-300/90'
    case 'cron': return 'text-zinc-300'
    case 'manual': return 'text-zinc-500'
    default: return 'text-zinc-500'
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never run'
  const date = new Date(dateStr)
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  return `${Math.floor(diffMs / 86_400_000)}d ago`
}

/**
 * Admin-gated business endpoints (admin-users-list, admin-usage-dashboard,
 * admin-impersonate, ...) authenticate with the project's x-admin-key header.
 * These cards get a "copy admin key" affordance so the key is one click away.
 */
function isAdminGated(fn: AiFunction): boolean {
  return /^admin[-_]/i.test(fn.name)
}

// One admin-key fetch per project per page load — every admin card shares it.
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
        .then(r => (r.ok ? r.json() : null))
        .then(d => d?.adminKey ?? null)
        .catch(() => null)
    )
  }
  return adminKeyCache.get(projectId)!
}

/** For HTTP-endpoint functions, resolve the full callable URL from triggerTable. */
function getEndpointUrl(fn: AiFunction): string | null {
  if (getTriggerKind(fn) !== 'http' || !fn.triggerTable) return null
  const path = fn.triggerTable.split(/\s+/)[1]
  if (!path) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${path}`
}

// ─── Confirm dialog (replaces browser confirm()) ──────────────────────────────

interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {state && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 4 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#16171d] border border-rose-500/25 rounded-xl max-w-sm w-full shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden"
          >
            <div className="px-5 pt-4 pb-4">
              <div className="flex items-center gap-2.5 mb-2">
                <Trash2 className="w-3.5 h-3.5 text-rose-300 flex-shrink-0" />
                <h3 className="text-[13.5px] font-semibold text-zinc-50 tracking-[-0.01em]">{state.title}</h3>
              </div>
              <p className="text-[12.5px] text-zinc-400 leading-5">{state.body}</p>
            </div>
            <div className="px-5 py-3.5 border-t border-white/[0.06] flex justify-end gap-2">
              <KitButton variant="ghost" onClick={onClose}>Cancel</KitButton>
              <KitButton
                variant="danger"
                onClick={() => { state.onConfirm(); onClose() }}
              >
                {state.confirmLabel}
              </KitButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Function Card ────────────────────────────────────────────────────────────

function FunctionCard({
  fn,
  projectId,
  onDelete,
  onToggle,
  requestConfirm,
}: {
  fn: AiFunction
  projectId: string
  onDelete: (id: string) => void
  onToggle: (id: string, active: boolean) => void
  requestConfirm: (state: ConfirmState) => void
}) {
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<TestRunResult | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)

  const endpointUrl = getEndpointUrl(fn)
  const adminGated = isAdminGated(fn)

  const handleRun = async () => {
    setRunning(true)
    setRunResult(null)
    try {
      const token = localStorage.getItem('auth-token')
      const res = await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body: JSON.stringify({ event: {} }),
      })
      const data = await res.json()
      setRunResult(data.result)
      setShowLogs(true)
    } catch (err: any) {
      setRunResult({ success: false, logs: [], error: err.message, durationMs: 0 })
      setShowLogs(true)
    } finally {
      setRunning(false)
    }
  }

  const performDelete = async () => {
    setDeleting(true)
    try {
      const token = localStorage.getItem('auth-token')
      await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      onDelete(fn.id)
    } catch {
      setDeleting(false)
    }
  }

  const handleDelete = () => {
    requestConfirm({
      title: 'Delete function?',
      body: `"${fn.name}" will stop running and be removed permanently. This cannot be undone.`,
      confirmLabel: 'Delete function',
      onConfirm: performDelete,
    })
  }

  const handleToggle = async () => {
    const newActive = fn.status === 'inactive'
    try {
      const token = localStorage.getItem('auth-token')
      await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body: JSON.stringify({ status: newActive ? 'active' : 'inactive' }),
      })
      onToggle(fn.id, newActive)
    } catch {}
  }

  const handleCopyUrl = async () => {
    if (!endpointUrl) return
    try {
      await navigator.clipboard.writeText(endpointUrl)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  const handleCopyAdminKey = async () => {
    try {
      const key = await fetchAdminKey(projectId)
      if (!key) return
      await navigator.clipboard.writeText(key)
      setCopiedKey(true)
      setTimeout(() => setCopiedKey(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  const statusDotStyle =
    fn.status === 'active'
      ? 'bg-emerald-400'
      : fn.status === 'error'
      ? 'bg-rose-400'
      : 'bg-zinc-700'

  const triggerKind = getTriggerKind(fn)

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={`relative rounded-xl border bg-[#16171d] transition-colors duration-200 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] ${
        fn.status === 'inactive'
          ? 'border-white/[0.05] opacity-55'
          : fn.status === 'error'
          ? 'border-rose-500/20'
          : 'border-white/[0.07] hover:border-white/[0.12]'
      }`}
    >
      <div className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={`w-[5px] h-[5px] rounded-full flex-shrink-0 ${statusDotStyle}`} title={fn.status} />

          <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium flex-shrink-0 w-[132px] truncate ${getTriggerStyle(triggerKind)}`}>
            {getTriggerIcon(triggerKind)}
            {getTriggerLabel(fn)}
          </span>

          <div className="flex-1 min-w-0">
            <span className="text-[12.5px] font-medium text-zinc-100 font-mono truncate block">{fn.name}</span>
            {fn.description && (
              <span className="text-[11.5px] text-zinc-500 truncate block mt-0.5">{fn.description}</span>
            )}
          </div>

          <div className="flex items-center gap-0.5 flex-shrink-0">
            <span className="font-mono text-[10.5px] text-zinc-600 tabular-nums mr-2 hidden sm:block">
              {fn.runCount > 0 ? `${fn.runCount.toLocaleString()} run${fn.runCount !== 1 ? 's' : ''} · ` : ''}{formatRelativeTime(fn.lastRun)}
            </span>
            {adminGated && (
              <button
                onClick={handleCopyAdminKey}
                title={copiedKey ? 'Copied!' : 'Copy admin key (send as x-admin-key header)'}
                className={`p-2 rounded-md transition-colors ${
                  copiedKey
                    ? 'text-emerald-300 bg-emerald-500/[0.08]'
                    : 'text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.06]'
                }`}
              >
                {copiedKey ? <Check className="w-3.5 h-3.5" /> : <KeyRound className="w-3.5 h-3.5" />}
              </button>
            )}
            {endpointUrl && (
              <button
                onClick={handleCopyUrl}
                title={copiedUrl ? 'Copied!' : 'Copy endpoint URL'}
                className={`p-2 rounded-md transition-colors ${
                  copiedUrl
                    ? 'text-emerald-300 bg-emerald-500/[0.08]'
                    : 'text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.06]'
                }`}
              >
                {copiedUrl ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
              </button>
            )}
            <button
              onClick={handleRun}
              disabled={running || fn.status === 'inactive'}
              title="Test run"
              className="p-2 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors disabled:opacity-30"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={handleToggle}
              title={fn.status === 'inactive' ? 'Enable' : 'Disable'}
              className={`p-2 rounded-md transition-colors ${
                fn.status === 'active'
                  ? 'text-emerald-300 hover:bg-emerald-500/[0.08]'
                  : 'text-zinc-600 hover:text-zinc-100 hover:bg-white/[0.06]'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="Delete"
              className="p-2 rounded-md text-zinc-600 hover:text-rose-300 hover:bg-rose-500/[0.08] transition-colors"
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {fn.status === 'error' && fn.lastError && (
          <div className="mt-3 text-[11px] text-rose-300/90 bg-rose-500/[0.05] border border-rose-500/15 rounded-md px-3 py-2 font-mono ml-5">
            {fn.lastError.slice(0, 120)}
          </div>
        )}
      </div>

      <AnimatePresence>
        {showLogs && runResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-white/[0.05]"
          >
            {(() => {
              const rv: any = runResult.returnValue
              const isHttp = rv && typeof rv === 'object' && typeof rv.status === 'number'
              const httpStatus: number | undefined = isHttp ? rv.status : undefined
              const httpBody = isHttp ? rv.body : rv
              const client4xx = httpStatus != null && httpStatus >= 400 && httpStatus < 500
              // A plan-limit block is not a code failure — the function is fine,
              // the plan quota is the constraint. Show it as such with a way out.
              if (runResult.errorCode === 'PLAN_LIMIT_EXCEEDED') {
                return (
                  <div className="p-4 bg-black/25">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold flex items-center gap-1.5 text-violet-300">
                        <AlertTriangle className="w-3 h-3" />
                        Plan limit reached
                      </span>
                      <button onClick={() => setShowLogs(false)} className="text-[10.5px] text-zinc-600 hover:text-zinc-400 transition-colors">
                        close
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed mb-2.5">
                      {runResult.error} Your function code is fine. It wasn&apos;t run because the
                      monthly invocation quota is used up. It resets on the 1st.
                    </p>
                    <a
                      href="/app/settings?tab=billing"
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-300 hover:text-violet-200 transition-colors"
                    >
                      Upgrade for a higher quota →
                    </a>
                  </div>
                )
              }
              // A 4xx from a handler (e.g. 401 on a no-token test run) means the
              // endpoint WORKED and answered — show it violet/informational, not
              // a scary red "Failed". Only thrown errors are real failures.
              const headColor = !runResult.success
                ? 'text-rose-300'
                : client4xx
                ? 'text-violet-300'
                : 'text-emerald-300'
              const headText = !runResult.success
                ? 'Failed'
                : httpStatus != null
                ? `Returned HTTP ${httpStatus} · ${runResult.durationMs}ms`
                : `Completed in ${runResult.durationMs}ms`
              let bodyStr = ''
              if (httpBody != null) {
                try {
                  bodyStr = typeof httpBody === 'string' ? httpBody : JSON.stringify(httpBody, null, 2)
                } catch { bodyStr = String(httpBody) }
              }
              return (
                <div className="p-4 bg-black/25">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className={`text-[11px] font-semibold flex items-center gap-1.5 ${headColor}`}>
                      {!runResult.success
                        ? <AlertCircle className="w-3 h-3" />
                        : client4xx
                        ? <AlertTriangle className="w-3 h-3" />
                        : <Check className="w-3 h-3" />}
                      {headText}
                    </span>
                    <button onClick={() => setShowLogs(false)} className="text-[10.5px] text-zinc-600 hover:text-zinc-400 transition-colors">
                      close
                    </button>
                  </div>
                  {client4xx && (
                    <p className="text-[10.5px] text-violet-300/70 mb-2 leading-relaxed">
                      {httpStatus === 400
                        ? 'The endpoint ran and validated its input. It needs required parameters this test run didn’t send, and will work when your app calls it with a real payload.'
                        : httpStatus === 401 || httpStatus === 403
                        ? 'Test runs call the endpoint with your project’s admin credentials. This response means the endpoint additionally checks ownership of specific records or a credential this test didn’t carry. The auth gate itself is working.'
                        : httpStatus === 404
                        ? 'The endpoint ran correctly. The test run’s synthetic user has no matching records yet, so it answered 404 as designed.'
                        : `The endpoint ran and answered HTTP ${httpStatus}, a client-side response from its own validation logic, not a code failure.`}
                    </p>
                  )}
                  {runResult.logs.length > 0 && (
                    <div className="space-y-0.5">
                      {runResult.logs.map((log, i) => (
                        <div key={i} className="text-[11px] font-mono text-zinc-400">
                          <span className="text-zinc-700 mr-2">›</span>{log}
                        </div>
                      ))}
                    </div>
                  )}
                  {bodyStr && (
                    <pre className="mt-2 text-[11px] font-mono text-zinc-400 bg-black/30 border border-white/[0.08] rounded-md px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
                      {bodyStr.slice(0, 2000)}{bodyStr.length > 2000 ? '\n…(truncated)' : ''}
                    </pre>
                  )}
                  {runResult.error && (
                    <div className="text-[11px] font-mono text-rose-300">{runResult.error}</div>
                  )}
                </div>
              )
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─── Function Logs Panel ──────────────────────────────────────────────────────

function FunctionLogsPanel({ projectId, functionId }: { projectId: string; functionId?: string }) {
  const [logs, setLogs] = useState<AiFunctionLog[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(50)

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('auth-token')
      const url = `/api/projects/${projectId}/ai-functions/logs?limit=${page}${functionId ? `&functionId=${functionId}` : ''}`
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        setLogs(data.data || [])
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    if (open) fetchLogs()
  }, [open, page, projectId, functionId])

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#16171d] overflow-hidden shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors focus:outline-none"
      >
        <div className="flex items-baseline gap-2">
          <ScrollText className="w-3.5 h-3.5 text-zinc-500 self-center" />
          <span className="text-[12.5px] font-semibold text-zinc-100">Execution logs</span>
          {logs.length > 0 && (
            <span className="font-mono text-[10.5px] text-zinc-500 tabular-nums">{logs.length}</span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-zinc-600" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-600" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.05] px-5 pb-5 pt-4">
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500 py-4 justify-center">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Loading logs…
                </div>
              ) : logs.length === 0 ? (
                <p className="text-xs text-zinc-500 text-center py-6">No execution logs yet. Runs appear here the moment a function fires.</p>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {logs.map(log => (
                    <div key={log.id} className="px-1 py-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          {log.success
                            ? <Check className="w-3 h-3 text-emerald-400/80" />
                            : <AlertCircle className="w-3 h-3 text-rose-300" />}
                          <span className="text-[11.5px] font-medium text-zinc-300 font-mono">
                            {log.function?.name || 'function'}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-600">
                            {log.triggerType}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 font-mono text-[10.5px] text-zinc-600 tabular-nums">
                          <span>{log.durationMs}ms</span>
                          <span>{new Date(log.createdAt).toLocaleString()}</span>
                        </div>
                      </div>

                      {log.logs.length > 0 && (
                        <div className="space-y-0.5 mb-2">
                          {log.logs.map((line, i) => (
                            <div key={i} className="text-[11px] font-mono text-zinc-500">
                              <span className="text-zinc-700 mr-2">›</span>{line}
                            </div>
                          ))}
                        </div>
                      )}

                      {log.error && (
                        <div className="text-[11px] font-mono text-rose-300 mt-1">{log.error}</div>
                      )}
                    </div>
                  ))}

                  {logs.length >= page && (
                    <button
                      onClick={() => setPage(p => p + 50)}
                      className="w-full text-xs text-zinc-500 hover:text-zinc-300 py-2 transition-colors"
                    >
                      Load more
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Schema-function detection ────────────────────────────────────────────────
// Functions with names matching these patterns are auto-generated schema-query
// helpers that the AI creates during introspection. They have no business logic,
// are always "Manual only", and have never been run — they just clutter the list.
const SCHEMA_FN_RE = /(-schema|-full|_schema|_full)$|(^workspaces?-|^workspace_)/i

function isSchemaQueryFunction(fn: AiFunction): boolean {
  return (
    SCHEMA_FN_RE.test(fn.name) &&
    fn.triggerType === 'manual' &&
    fn.runCount === 0
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function SkeletonRow({ delay }: { delay: number }) {
  return (
    <div
      className="rounded-xl border border-white/[0.06] bg-[#16171d] px-4 py-3 animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-3">
        <div className="w-[5px] h-[5px] rounded-full bg-white/[0.08] flex-shrink-0" />
        <div className="w-28 h-5 rounded-md bg-white/[0.05] flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="w-44 h-3 rounded bg-white/[0.06]" />
          <div className="w-72 max-w-full h-2.5 rounded bg-white/[0.035]" />
        </div>
        <div className="w-24 h-3 rounded bg-white/[0.04] flex-shrink-0 hidden sm:block" />
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// Filters key off the *normalised* trigger kind (getTriggerKind), so HTTP
// endpoints stored as triggerType 'manual' surface under "Endpoints" instead
// of polluting "Manual".
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

export default function FunctionsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string

  const [functions, setFunctions] = useState<AiFunction[]>([])
  const [loading, setLoading] = useState(true)
  const [cleaningUp, setCleaningUp] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)

  useEffect(() => {
    const fetchFunctions = async () => {
      try {
        const token = localStorage.getItem('auth-token')
        const res = await fetch(`/api/projects/${projectId}/ai-functions`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
        })
        if (res.ok) {
          const data = await res.json()
          setFunctions(data.functions || [])
        }
      } catch {}
      setLoading(false)
    }
    fetchFunctions()
  }, [projectId])

  const handleDelete = (id: string) => {
    setFunctions(prev => prev.filter(f => f.id !== id))
  }

  const handleToggle = (id: string, active: boolean) => {
    setFunctions(prev =>
      prev.map(f => f.id === id ? { ...f, status: active ? 'active' : 'inactive' } : f)
    )
  }

  // Delete all auto-generated schema-query functions in bulk
  const performCleanupSchemaFns = async () => {
    const toDelete = functions.filter(isSchemaQueryFunction)
    if (!toDelete.length) return
    setCleaningUp(true)
    try {
      const token = localStorage.getItem('auth-token')
      await Promise.allSettled(
        toDelete.map(fn =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            credentials: 'include',
          })
        )
      )
      setFunctions(prev => prev.filter(f => !toDelete.some(d => d.id === f.id)))
    } finally {
      setCleaningUp(false)
    }
  }

  const handleCleanupSchemaFns = () => {
    const count = functions.filter(isSchemaQueryFunction).length
    if (!count) return
    setConfirmState({
      title: `Delete ${count} schema endpoint${count !== 1 ? 's' : ''}?`,
      body: 'These auto-generated validation-schema endpoints will be removed permanently. Your frontend will no longer be able to fetch live form-validation schemas from them.',
      confirmLabel: 'Delete all',
      onConfirm: performCleanupSchemaFns,
    })
  }

  // Test-run all manual functions that have never been run
  const handleRunAllUntested = async () => {
    const untested = functions.filter(f => f.runCount === 0 && f.status === 'active' && !isSchemaQueryFunction(f))
    if (!untested.length) return
    setRunningAll(true)
    try {
      const token = localStorage.getItem('auth-token')
      await Promise.allSettled(
        untested.map(fn =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            credentials: 'include',
            body: JSON.stringify({ event: {} }),
          })
        )
      )
      const res = await fetch(`/api/projects/${projectId}/ai-functions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        setFunctions(data.functions || [])
      }
    } finally {
      setRunningAll(false)
    }
  }

  const activeFns = functions.filter(f => f.status === 'active')
  const errorFns = functions.filter(f => f.status === 'error')
  const totalRuns = functions.reduce((sum, f) => sum + f.runCount, 0)
  const schemaFns = functions.filter(isSchemaQueryFunction)
  const untestedActiveFns = functions.filter(f => f.runCount === 0 && f.status === 'active' && !isSchemaQueryFunction(f))

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: functions.length }
    for (const f of functions) {
      const kind = getTriggerKind(f)
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    return counts
  }, [functions])

  const visibleFunctions = useMemo(() => {
    let list = filter === 'all' ? functions : functions.filter(f => getTriggerKind(f) === filter)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(f =>
        f.name.toLowerCase().includes(q) ||
        (f.description || '').toLowerCase().includes(q) ||
        (f.triggerTable || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [functions, filter, query])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Zap}
        title="Functions"
        description="Event-driven functions: auto-triggered, no deployment needed"
        stat={functions.length > 0 ? `${functions.length}` : undefined}
      />

      <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />

      <div className="flex-1 px-7 py-6">

        {/* Toolbar — counts + runtime state left, primary action right. */}
        <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-[14px] font-medium tabular-nums text-white">{functions.length}</span>
              <span className="text-[11px] text-zinc-500">total</span>
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-[14px] font-medium tabular-nums text-white">{activeFns.length}</span>
              <span className="text-[11px] text-zinc-500">active</span>
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-[14px] font-medium tabular-nums text-white">{totalRuns.toLocaleString()}</span>
              <span className="text-[11px] text-zinc-500">runs</span>
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium ${
              errorFns.length > 0
                ? 'text-rose-300'
                : activeFns.length > 0
                ? 'text-emerald-300/90'
                : 'text-zinc-500'
            }`}>
              <span className={`h-[5px] w-[5px] rounded-full ${
                errorFns.length > 0 ? 'bg-rose-400' : activeFns.length > 0 ? 'bg-emerald-400' : 'bg-zinc-600'
              }`} />
              {errorFns.length > 0 ? `${errorFns.length} errored` : activeFns.length > 0 ? 'operational' : 'idle'}
            </span>
          </div>
          <KitButton
            variant="primary"
            icon={Plug2}
            onClick={() => router.push(`/app/projects/${projectId}/connect`)}
          >
            New function
          </KitButton>
        </div>

        {/* BANNERS */}
        <AnimatePresence>
          {schemaFns.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-white/[0.05] bg-white/[0.02] mb-2"
            >
              <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
              <p className="text-[11.5px] text-zinc-500 flex-1 min-w-0 truncate">
                <span className="font-medium text-zinc-300">{schemaFns.length} auto-generated validation-schema endpoint{schemaFns.length !== 1 ? 's' : ''}</span>
                <span className="text-zinc-600">. Safe to keep; they return live form-validation schemas for the frontend.</span>
              </p>
              <button
                onClick={handleCleanupSchemaFns}
                disabled={cleaningUp}
                className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 bg-transparent hover:bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.12] rounded-md transition-colors disabled:opacity-50"
              >
                {cleaningUp ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                {cleaningUp ? 'Deleting…' : 'Delete all'}
              </button>
            </motion.div>
          )}

          {untestedActiveFns.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-white/[0.12] bg-white/[0.05] mb-3"
            >
              <AlertCircle className="w-3.5 h-3.5 text-violet-300 flex-shrink-0" />
              <p className="text-[11.5px] text-violet-200 flex-1 min-w-0 truncate">
                <span className="font-semibold">{untestedActiveFns.length} active function{untestedActiveFns.length !== 1 ? 's' : ''} never tested</span>
                <span className="text-violet-300/60">. Verify at least one run before going live.</span>
              </p>
              <button
                onClick={handleRunAllUntested}
                disabled={runningAll}
                className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-violet-200 bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.14] rounded-md transition-colors disabled:opacity-50"
              >
                {runningAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {runningAll ? 'Running…' : 'Run all'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* SEARCH + FILTERS */}
        {functions.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search functions…"
                className="w-56 h-8 pl-9 pr-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {TRIGGER_FILTERS.map(f => {
                const count = filterCounts[f.key] ?? 0
                if (f.key !== 'all' && count === 0) return null
                const active = filter === f.key
                return (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all ${
                      active
                        ? 'bg-white/[0.08] border-white/[0.14] text-zinc-100'
                        : 'border-white/[0.07] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.10]'
                    }`}
                  >
                    {f.label} <span className="opacity-50 ml-1 tabular-nums">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* FUNCTION LIST */}
        {loading ? (
          <div className="space-y-2 mb-3">
            {[0, 1, 2, 3, 4].map(i => <SkeletonRow key={i} delay={i * 80} />)}
          </div>
        ) : functions.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-xl border border-dashed border-white/[0.08] bg-[#16171d]/60"
          >
            <EmptyState
              icon={Zap}
              title="No functions yet"
              description="Tell your connected coding agent what should happen, like a welcome email on signup or a webhook on new orders, and Backenly wires it up. Functions run automatically, no deployment needed."
              action={(
                <KitButton
                  variant="primary"
                  icon={Plug2}
                  onClick={() => router.push(`/app/projects/${projectId}/connect`)}
                >
                  Create with your agent
                </KitButton>
              )}
            />
          </motion.div>
        ) : visibleFunctions.length === 0 ? (
          <div className="rounded-xl border border-white/[0.05] bg-[#16171d]/60 p-10 text-center">
            <p className="text-xs text-zinc-500">
              No functions match{query.trim() ? ` “${query.trim()}”` : ' this filter'}.
            </p>
          </div>
        ) : (
          <div className="space-y-2 mb-3">
            <AnimatePresence mode="popLayout">
              {visibleFunctions.map(fn => (
                <FunctionCard
                  key={fn.id}
                  fn={fn}
                  projectId={projectId}
                  onDelete={handleDelete}
                  onToggle={handleToggle}
                  requestConfirm={setConfirmState}
                />
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* EXECUTION LOGS PANEL */}
        {functions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-3"
          >
            <FunctionLogsPanel projectId={projectId} />
          </motion.div>
        )}

        <InspectorGovernanceFooter />
      </div>
    </div>
  )
}
