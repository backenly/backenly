'use client'

import { useState, useEffect, useCallback } from 'react'
import { AlertCircle, RotateCw } from 'lucide-react'
import { EmptyState, KitButton, Skeleton } from '@/components/inspector/kit'

import { WorkspaceHome } from './WorkspaceHome'
import { WorkspaceSetup } from './WorkspaceSetup'

interface MainWorkspaceProps {
  projectId: string
  projectName?: string | null
}

// ── State load failure ────────────────────────────────────────────────────────
// Rendered when /state can't be fetched. Never show WorkspaceSetup on a failed
// fetch — a 500 would read as "your backend is gone" when the data is intact.

function StateErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center">
      <EmptyState
        icon={AlertCircle}
        title="Couldn’t load your backend"
        description="Your tables and data are safe. The dashboard couldn’t reach them just now, which is usually temporary."
        action={
          <KitButton variant="primary" icon={RotateCw} onClick={onRetry}>
            Try again
          </KitButton>
        }
      />
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MainWorkspace({ projectId, projectName }: MainWorkspaceProps) {
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
  // never fall through to WorkspaceSetup — that renders a healthy-looking
  // "start building" page over a backend that failed to load (schema-drift
  // incident 2026-07-06: /state 500s made populated projects look wiped).
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

  // Re-read /state when the user returns to the tab. The agent builds from a
  // TERMINAL: the user connects Claude Code, asks for a backend, and tabs
  // back — and this page kept showing the empty state until a hard reload,
  // because the focus refresh lived only in WorkspaceHome, which is not even
  // mounted while WorkspaceSetup shows. No polling while hidden.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) { fetchBackendState(); fetchBuildStatus() } }
    const onFocus = () => { fetchBackendState(); fetchBuildStatus() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchBackendState, fetchBuildStatus])

  const retryBackendState = useCallback(() => {
    setStateStatus('loading')
    fetchBackendState()
    fetchBuildStatus()
  }, [fetchBackendState, fetchBuildStatus])

  const hasContent = backendState?.hasContent

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-7 sm:px-6 sm:pt-9 lg:px-8">

        {/* ── Initial load ────────────────────────────────── */}
        {/* Don't flash WorkspaceSetup while the first /state fetch is in
            flight — projects with content would briefly render as brand-new. */}
        {!hasContent && stateStatus === 'loading' && <OverviewSkeleton />}

        {/* ── State load failure ──────────────────────────── */}
        {!hasContent && stateStatus === 'error' && (
          <StateErrorPanel onRetry={retryBackendState} />
        )}

        {/* ── Setup (confirmed empty, not failed) ─────────── */}
        {!hasContent && stateStatus === 'ready' && (
          <WorkspaceSetup projectId={projectId} projectName={projectName ?? null} />
        )}

        {/* ── Backend overview ────────────────────────────── */}
        {hasContent && (
          <div>
            {/* WorkspaceHome — full project home: the agent panel while
                something waits, the self-healing loop, 24h observability,
                and the four resource cards. */}
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
          </div>
        )}
    </div>
  )
}

/**
 * The Overview's shape while /state loads: name, then the loop. No agent-panel
 * block: the panel renders only while something waits on the user or the page
 * cannot vouch for the backend, so on a quiet project a placeholder for it
 * vanished on load and the loop jumped up by its height.
 */
function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading overview" className="space-y-3">
      <Skeleton className="mb-6 h-[28px] w-56" />
      <Skeleton className="h-[300px] w-full rounded-[10px]" />
    </div>
  )
}
