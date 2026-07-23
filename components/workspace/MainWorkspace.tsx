'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'

import { WorkspaceHome } from './WorkspaceHome'

interface MainWorkspaceProps {
  projectId: string
  projectName?: string | null
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col items-center justify-center min-h-[70vh] px-6"
    >
      <div className="w-full max-w-sm">
        {/* Icon */}
        <div className="w-10 h-10 rounded-xl bg-[#16171d] border border-white/10 shadow-[0_18px_55px_-42px_rgba(0,0,0,0.9)] flex items-center justify-center mb-5 mx-auto">
          <svg className="w-4.5 h-4.5 text-zinc-500" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.4}>
            <rect x="2" y="2" width="6" height="6" rx="1" />
            <rect x="12" y="2" width="6" height="6" rx="1" />
            <rect x="2" y="12" width="6" height="6" rx="1" />
            <rect x="12" y="12" width="6" height="6" rx="1" />
          </svg>
        </div>

        {/* Headline — honest empty state. Nothing is "built" until the agent
            genuinely creates it, so we don't fabricate tables, routes, or auth
            here. The one real next step is connecting an agent. */}
        <p className="text-[14px] font-semibold text-white text-center mb-1.5 tracking-tight">
          Connect your coding agent
        </p>
        <p className="text-[12px] text-zinc-500 text-center leading-relaxed mb-5">
          This backend is empty. Point Claude Code, Codex, or any MCP client at
          it and Backenly builds your tables, APIs and auth here, then keeps
          them running.
        </p>

        <button
          onClick={onConnect}
          className="mx-auto flex h-9 items-center justify-center rounded-lg bg-white px-4 text-[12.5px] font-semibold text-black transition-colors hover:bg-zinc-200"
        >
          Connect your agent
        </button>
      </div>
    </motion.div>
  )
}

// ── State load failure ────────────────────────────────────────────────────────
// Rendered when /state can't be fetched. Never show EmptyState on a failed
// fetch — a 500 would read as "your backend is gone" when the data is intact.

function StateErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col items-center justify-center min-h-[70vh] px-6"
    >
      <div className="w-full max-w-sm rounded-xl bg-[#16171d] border border-white/10 shadow-[0_18px_55px_-42px_rgba(0,0,0,0.9)] px-6 py-7 text-center">
        <div className="w-10 h-10 rounded-xl bg-white/[0.035] border border-white/10 flex items-center justify-center mb-4 mx-auto">
          <svg className="w-4.5 h-4.5 text-zinc-500" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.4}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6v4m0 3.5h.01M10 18a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
        </div>
        <p className="text-[14px] font-semibold text-white mb-1.5 tracking-tight">
          Couldn&apos;t load your backend
        </p>
        <p className="text-[12px] text-zinc-500 leading-relaxed mb-5">
          Your tables and data are safe. The dashboard just couldn&apos;t reach them right now, and this is usually temporary.
        </p>
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-lg bg-white hover:bg-zinc-200 transition-colors text-[12px] font-semibold text-black"
        >
          Try again
        </button>
      </div>
    </motion.div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MainWorkspace({ projectId, projectName }: MainWorkspaceProps) {
  const router = useRouter()
  const [backendState, setBackendState] = useState<{
    entities: Array<{ name: string; fieldCount: number; fields?: Array<{ name: string; type: string }> }>
    apis: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string; description?: string }>
    capabilities: Array<{
      name: string
      enabled: boolean
      icon: 'auth' | 'storage' | 'realtime' | 'jobs'
      count?: number
      status?: 'none' | 'partial' | 'ready'
    }>
    hasContent: boolean
    isLive: boolean
  } | null>(null)

  // Tracks the /state fetch itself, separately from its payload. 'error' must
  // never fall through to EmptyState — that renders a healthy-looking "start
  // building" canvas over a backend that failed to load (schema-drift incident
  // 2026-07-06: /state 500s made populated projects look wiped).
  const [stateStatus, setStateStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [blockedCount, setBlockedCount] = useState(0)

  const fetchBuildStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/build-status`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setBlockedCount(data.blocked?.length ?? 0)
      }
    } catch { /* non-fatal */ }
  }, [projectId])

  const fetchBackendState = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/state`, { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        setBackendState(data)
        setStateStatus('ready')
      } else {
        console.error('Failed to fetch backend state: HTTP', response.status)
        // A failed refresh keeps showing the last good data; only surface the
        // error panel when we have nothing to show at all.
        setStateStatus(prev => (prev === 'ready' ? 'ready' : 'error'))
      }
    } catch (err) {
      console.error('Failed to fetch backend state:', err)
      setStateStatus(prev => (prev === 'ready' ? 'ready' : 'error'))
    }
  }, [projectId])

  useEffect(() => {
    fetchBackendState()
    fetchBuildStatus()
  }, [fetchBackendState, fetchBuildStatus])

  // Refresh the dashboard's backend state whenever auth changes (OAuth
  // credential save, provider add/remove). Without this, the dashboard
  // capability summary would disagree with the auth inspector until reload.
  useEffect(() => {
    const refresh = () => {
      fetchBackendState()
      fetchBuildStatus()
    }
    window.addEventListener('backenly:oauth-connected', refresh)
    return () => {
      window.removeEventListener('backenly:oauth-connected', refresh)
    }
  }, [fetchBackendState, fetchBuildStatus])

  const retryBackendState = useCallback(() => {
    setStateStatus('loading')
    fetchBackendState()
    fetchBuildStatus()
  }, [fetchBackendState, fetchBuildStatus])

  const hasContent = backendState?.hasContent

  return (
    <div className="h-full overflow-y-auto bg-[#101116]">
      <div className="pointer-events-none sticky top-0 z-0 h-px bg-gradient-to-r from-transparent via-violet-300/25 to-transparent" />
      <div className="relative z-10 max-w-[1460px] mx-auto px-5 pt-5 pb-10 sm:px-6 lg:px-8">

        {/* ── Initial load ────────────────────────────────── */}
        {/* Don't flash EmptyState while the first /state fetch is in flight —
            projects with content would briefly render as brand-new. */}
        {!hasContent && stateStatus === 'loading' && (
          <div className="flex flex-col items-center justify-center min-h-[70vh]">
            <div className="w-6 h-6 rounded-full border-2 border-white/10 border-t-violet-500 animate-spin" />
          </div>
        )}

        {/* ── State load failure ──────────────────────────── */}
        {!hasContent && stateStatus === 'error' && (
          <StateErrorPanel onRetry={retryBackendState} />
        )}

        {/* ── Empty state (confirmed empty, not failed) ───── */}
        {!hasContent && stateStatus === 'ready' && (
          <EmptyState onConnect={() => router.push(`/app/projects/${projectId}/connect`)} />
        )}

        {/* ── Backend overview ────────────────────────────── */}
        {hasContent && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="space-y-8"
          >
            {/* WorkspaceHome — full project home: agent panel + self-healing
                loop, 24h observability, and the four resource cards. */}
            <WorkspaceHome
              projectId={projectId}
              projectName={projectName ?? null}
              hasBackend={backendState!.hasContent}
              tables={backendState!.entities}
              storageBuckets={(backendState!.capabilities.find(c => c.name === 'File Storage') as any)?.count ?? 0}
              extras={backendState!.capabilities
                .filter(c => !['Authentication', 'File Storage'].includes(c.name))
                .map(c => ({ name: c.name, icon: c.icon, count: (c as any).count }))
              }
              blockedCount={blockedCount}
            />
          </motion.div>
        )}
      </div>
    </div>
  )
}
