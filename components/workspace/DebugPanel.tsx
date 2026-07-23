'use client'

/**
 * PHASE 10 — ADMIN DEBUG PANEL
 * ==============================
 * Collapsible panel that surfaces per-message observability data for
 * diagnosing AI failures.
 *
 * Shows:
 *   - Last build intent (from sticky store)
 *   - Last execution summary (mode, subBehavior, actions/artifacts counts)
 *   - Per-message debug log (last 10 messages)
 *   - Current project state snapshot (table count, API count)
 *
 * Intended use: dev mode or admin role only.
 * Rendered by the parent page conditionally; not shown in production to
 * end-users unless NODE_ENV=development or an admin flag is set.
 */

import React, { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, Bug, RefreshCw, CheckCircle2, XCircle, AlertCircle, Zap } from 'lucide-react'

// ── Types (mirrors message-debug-logger.ts) ───────────────────────────────────

interface MessageDebugRecord {
  id: string
  mode: 'plan' | 'build' | 'special'
  subBehavior?: string
  executionTriggered: boolean
  actionsCount: number
  artifactsCount: number
  continuationSource: 'sticky_store' | 'history' | 'none'
  fallbackUsed: boolean
  responseType?: string
  durationMs: number
  createdAt: string
}

interface DebugSnapshot {
  projectId: string
  messageLogs: MessageDebugRecord[]
  executionLogs: Array<{
    id: string
    intent: string
    strategy: string
    action: string
    durationMs: number
    success: boolean
    errorMsg: string | null
    createdAt: string
  }>
  stats: {
    totalExecutions: number
    successRate: number
    avgDurationMs: number
    failedIntents: string[]
  }
  lastBuildIntent: {
    intent: string
    intentType: string
    executed: boolean
    savedAt: string
  } | null
  lastExecution: MessageDebugRecord | null
  stateSnapshot: {
    graphId: string
    version: number
    entityCount: number
    tableNames: string[]
    apiCount: number
    functionCount: number
    updatedAt: string
  } | null
}

// ── Small helpers ──────────────────────────────────────────────────────────────

const modeBadge: Record<string, string> = {
  plan:    'bg-purple-500/15 text-purple-300 border-purple-500/25',
  build:   'bg-blue-500/15 text-blue-300 border-blue-500/25',
  special: 'bg-amber-500/15 text-amber-500 border-amber-500/25',
}

const behaviorBadge: Record<string, string> = {
  EXECUTION:    'bg-emerald-500/15 text-emerald-300',
  INSPECTION:   'bg-sky-500/15 text-sky-300',
  MODIFICATION: 'bg-orange-500/15 text-orange-300',
  CONTINUATION: 'bg-violet-500/15 text-violet-300',
  VERIFICATION: 'bg-teal-500/15 text-teal-300',
}

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border border-transparent ${className ?? 'bg-gray-700 text-gray-300'}`}>
      {label}
    </span>
  )
}

function FallbackPill({ used }: { used: boolean }) {
  if (!used) return <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />ok</span>
  return <span className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" />fallback</span>
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-white/5 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-white/3 hover:bg-white/5 text-xs font-semibold text-gray-300 uppercase tracking-wider transition-colors"
      >
        {title}
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface DebugPanelProps {
  projectId: string
}

export function DebugPanel({ projectId }: DebugPanelProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<DebugSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/debug/${projectId}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load debug data')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    if (next && !data) load()
  }

  return (
    <div className="mt-4 font-mono text-xs">
      {/* Toggle button */}
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 text-[11px] transition-colors border border-white/5"
      >
        <Bug className="w-3 h-3" />
        Debug panel
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>

      {open && (
        <div className="mt-2 space-y-2 bg-gray-900/80 border border-white/8 rounded-xl p-3">
          {/* Header */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-gray-500 text-[10px]">Phase 10 observability — {projectId.slice(0, 8)}…</span>
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              <span className="text-[10px]">refresh</span>
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-red-400 text-[11px]">
              <AlertCircle className="w-3.5 h-3.5" />
              {error}
            </div>
          )}

          {data && (
            <>
              {/* ── State snapshot ── */}
              <Section title="Project state" defaultOpen>
                {data.stateSnapshot ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
                    <span className="text-gray-500">version</span><span>v{data.stateSnapshot.version}</span>
                    <span className="text-gray-500">tables</span>
                    <span>{data.stateSnapshot.entityCount} — {data.stateSnapshot.tableNames.slice(0, 5).join(', ')}{data.stateSnapshot.tableNames.length > 5 ? ` +${data.stateSnapshot.tableNames.length - 5}` : ''}</span>
                    <span className="text-gray-500">APIs</span><span>{data.stateSnapshot.apiCount}</span>
                    <span className="text-gray-500">functions</span><span>{data.stateSnapshot.functionCount}</span>
                  </div>
                ) : (
                  <span className="text-gray-600">No graph built yet</span>
                )}
              </Section>

              {/* ── Last build intent ── */}
              <Section title="Last build intent">
                {data.lastBuildIntent ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge label={data.lastBuildIntent.intentType} className="bg-indigo-500/15 text-indigo-300" />
                      {data.lastBuildIntent.executed && <Badge label="executed" className="bg-emerald-500/15 text-emerald-300" />}
                    </div>
                    <p className="text-gray-300 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                      {data.lastBuildIntent.intent}
                    </p>
                    <span className="text-gray-600">{new Date(data.lastBuildIntent.savedAt).toLocaleString()}</span>
                  </div>
                ) : (
                  <span className="text-gray-600">No sticky intent saved</span>
                )}
              </Section>

              {/* ── Last execution ── */}
              <Section title="Last execution" defaultOpen>
                {data.lastExecution ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
                    <span className="text-gray-500">mode</span>
                    <span><Badge label={data.lastExecution.mode} className={modeBadge[data.lastExecution.mode]} /></span>
                    <span className="text-gray-500">sub-behavior</span>
                    <span>{data.lastExecution.subBehavior
                      ? <Badge label={data.lastExecution.subBehavior} className={behaviorBadge[data.lastExecution.subBehavior]} />
                      : '—'}</span>
                    <span className="text-gray-500">exec triggered</span>
                    <span>{data.lastExecution.executionTriggered ? <span className="text-emerald-400">yes</span> : <span className="text-gray-500">no</span>}</span>
                    <span className="text-gray-500">actions</span><span>{data.lastExecution.actionsCount}</span>
                    <span className="text-gray-500">artifacts</span><span>{data.lastExecution.artifactsCount}</span>
                    <span className="text-gray-500">cont. source</span><span className="text-gray-300">{data.lastExecution.continuationSource}</span>
                    <span className="text-gray-500">fallback</span><FallbackPill used={data.lastExecution.fallbackUsed} />
                    <span className="text-gray-500">duration</span><span>{data.lastExecution.durationMs}ms</span>
                    <span className="text-gray-500">response type</span><span className="text-gray-400">{data.lastExecution.responseType ?? '—'}</span>
                  </div>
                ) : (
                  <span className="text-gray-600">No execution logs yet</span>
                )}
              </Section>

              {/* ── Message log ── */}
              <Section title={`Message log (${data.messageLogs.length})`}>
                {data.messageLogs.length === 0 ? (
                  <span className="text-gray-600">No messages logged yet</span>
                ) : (
                  <div className="space-y-2">
                    {data.messageLogs.map(log => (
                      <div key={log.id} className="flex flex-wrap items-center gap-1.5 border-b border-white/5 pb-2 last:border-0 last:pb-0">
                        <Badge label={log.mode} className={modeBadge[log.mode]} />
                        {log.subBehavior && <Badge label={log.subBehavior} className={behaviorBadge[log.subBehavior] ?? ''} />}
                        {log.executionTriggered && (
                          <span className="flex items-center gap-0.5 text-emerald-400">
                            <Zap className="w-2.5 h-2.5" /><span className="text-[10px]">{log.actionsCount}a/{log.artifactsCount}r</span>
                          </span>
                        )}
                        {log.continuationSource !== 'none' && (
                          <span className="text-[10px] text-violet-400">cont:{log.continuationSource.replace('_store', '')}</span>
                        )}
                        <FallbackPill used={log.fallbackUsed} />
                        <span className="ml-auto text-gray-600 text-[10px]">{log.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* ── Stats ── */}
              <Section title="7-day stats">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
                  <span className="text-gray-500">total execs</span><span>{data.stats.totalExecutions}</span>
                  <span className="text-gray-500">success rate</span>
                  <span className={(data.stats.successRate ?? 1) >= 0.9 ? 'text-emerald-400' : 'text-red-400'}>
                    {((data.stats.successRate ?? 1) * 100).toFixed(1)}%
                  </span>
                  <span className="text-gray-500">avg duration</span><span>{data.stats.avgDurationMs}ms</span>
                  {data.stats.failedIntents.length > 0 && (
                    <>
                      <span className="text-gray-500">failed intents</span>
                      <span className="text-red-400">{data.stats.failedIntents.join(', ')}</span>
                    </>
                  )}
                </div>
              </Section>
            </>
          )}

          {loading && !data && (
            <div className="flex items-center gap-2 text-gray-500 py-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Loading debug data…
            </div>
          )}
        </div>
      )}
    </div>
  )
}
