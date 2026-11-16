'use client'

/**
 * Overview: the project's name with one fact, Deploy's own ("● v5 published
 * Nov 14", "○ Not published"), then either the live summary (WorkspaceHome)
 * or, with nothing built yet, the agent setup (WorkspaceSetup).
 *
 * Which one is decided by GET /state's `hasContent`, and a failed /state never
 * falls through to the setup: a 500 would read as "your backend is gone" when
 * the data is intact (schema-drift incident 2026-07-06). It says so in an
 * error row instead, with Try again.
 *
 * The page re-reads /state when the person comes back to the tab (the agent
 * builds from a terminal, so they come back to see it), and every 10 s while
 * a connected agent has built nothing yet and the tab is in view, so the page
 * switches to the live summary as the first table lands.
 *
 * Loading draws the final shapes once: the header, then the sections. The
 * live summary waits for the waiting-on-you count (one shared /health read),
 * so "Waiting on you" never pops in above the rest a moment later.
 */

import { useCallback, useEffect, useState } from 'react'
import { PageHeader, Skeleton, StatusGlyph, type GlyphState } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { Panel, RowSkeleton } from '@/components/autonomy/rows'
import { ErrorRow } from '@/components/console/states'
import { formatTime } from '@/components/console/format'
import { sharedRead } from '@/lib/client/shared-read'
import { getProject, type Project } from '@/lib/api/projects'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useWaitingCount } from '@/lib/hooks/useWaitingCount'
import { WorkspaceHome, type BlockedItem } from './WorkspaceHome'
import { WorkspaceSetup } from './WorkspaceSetup'

interface MainWorkspaceProps {
  projectId: string
  /** The name, when the caller already has it. Read from the project otherwise. */
  projectName?: string | null
}

/** The newest published version, as Deploy lists it (GET /rollback). */
interface Published {
  version: number | null
  publishedAt: string
}

/** How long a connected agent with nothing built is watched for its first table. */
const FIRST_BUILD_POLL_MS = 10_000

/** Deploy's state in its own words: what is published, or that nothing is. */
export function publishFact(project: Pick<Project, 'projectStatus'> | null, latest: Published | null): { state: GlyphState; words: string } {
  const status = project?.projectStatus
  if (status === 'DEPLOYING') return { state: 'busy', words: 'Publishing' }
  if (status === 'FAILED') return { state: 'failed', words: 'Publish failed' }
  if (latest && latest.version !== null) {
    return { state: 'live', words: `v${latest.version} published ${formatTime(latest.publishedAt, 'date')}` }
  }
  return { state: 'idle', words: 'Not published' }
}

export function MainWorkspace({ projectId, projectName = null }: MainWorkspaceProps) {
  const agent = useAgentConnection(projectId)
  const waiting = useWaitingCount(projectId)
  const [project, setProject] = useState<Project | null>(null)
  const [latest, setLatest] = useState<Published | null | undefined>(undefined)
  const [hasContent, setHasContent] = useState<boolean | null>(null)
  // Tracks the /state fetch itself, separately from its payload. 'error' must
  // never fall through to WorkspaceSetup (see the note at the top).
  const [stateStatus, setStateStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [blocked, setBlocked] = useState<BlockedItem[]>([])

  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => {
        if (!cancelled) setProject(p)
      })
      .catch(() => {
        /* the header keeps the name it was given; the page still works */
      })
    fetch(`/api/projects/${projectId}/rollback`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        const versions: Published[] = Array.isArray(body?.versions) ? body.versions : []
        setLatest(versions[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) setLatest(null)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Missing provider keys the build waits on: a deep scan, so it never holds the page.
  const fetchBuildStatus = useCallback(async (fresh = false) => {
    try {
      const res = await sharedRead<{ blocked?: BlockedItem[] }>(`/api/projects/${projectId}/build-status`, { fresh })
      if (res.ok && Array.isArray(res.data?.blocked)) setBlocked(res.data.blocked)
    } catch {
      /* "Needs a look" only says what it knows */
    }
  }, [projectId])

  const fetchBackendState = useCallback(async (fresh = false) => {
    try {
      const response = await sharedRead<{ hasContent?: boolean }>(`/api/projects/${projectId}/state`, { fresh })
      if (response.ok && response.data) {
        setHasContent(!!response.data.hasContent)
        setStateStatus('ready')
      } else {
        // A failed refresh keeps the last good answer; only a first failure says so.
        setStateStatus((prev) => (prev === 'ready' ? 'ready' : 'error'))
      }
    } catch {
      setStateStatus((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchBackendState()
    void fetchBuildStatus()
  }, [fetchBackendState, fetchBuildStatus])

  // A provider key saved elsewhere unblocks the build: read again.
  useEffect(() => {
    const refresh = () => {
      void fetchBackendState(true)
      void fetchBuildStatus(true)
    }
    window.addEventListener('backenly:oauth-connected', refresh)
    return () => window.removeEventListener('backenly:oauth-connected', refresh)
  }, [fetchBackendState, fetchBuildStatus])

  // Re-read /state when the person returns to the tab: the agent builds from a
  // terminal, and this page kept showing the setup until a hard reload. No
  // polling while hidden.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        void fetchBackendState()
        void fetchBuildStatus()
      }
    }
    const onFocus = () => {
      void fetchBackendState()
      void fetchBuildStatus()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchBackendState, fetchBuildStatus])

  // A connected agent with nothing built yet is about to build: watch for it.
  useEffect(() => {
    if (hasContent !== false || !agent.connected) return
    const timer = setInterval(() => {
      if (!document.hidden) void fetchBackendState(true)
    }, FIRST_BUILD_POLL_MS)
    return () => clearInterval(timer)
  }, [hasContent, agent.connected, fetchBackendState])

  const name = project?.name ?? projectName
  const fact = latest === undefined && !project ? null : publishFact(project, latest ?? null)
  const liveReady = stateStatus === 'ready' && hasContent === true && !waiting.loading

  return (
    <div className="pb-16">
      <PageHeader
        title={name ?? <Skeleton className="h-[30px] w-[220px]" />}
        meta={
          fact ? (
            <span className="inline-flex items-center gap-[7px] text-[13px] leading-[20px] text-faint">
              <StatusGlyph state={fact.state} label={fact.words} />
              <span aria-hidden>{fact.words}</span>
            </span>
          ) : undefined
        }
      />
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER}`}>
        {stateStatus === 'error' ? (
          <Panel>
            <ErrorRow
              things="this project"
              stillWorks="Its data is safe."
              onRetry={() => {
                setRetrying(true)
                setStateStatus('loading')
                void fetchBackendState(true)
                void fetchBuildStatus(true)
              }}
              retrying={retrying}
            />
          </Panel>
        ) : stateStatus === 'ready' && hasContent === false ? (
          <WorkspaceSetup projectId={projectId} />
        ) : liveReady ? (
          <WorkspaceHome projectId={projectId} blocked={blocked} />
        ) : (
          <OverviewSkeleton />
        )}
      </div>
    </div>
  )
}

/** The page's shape while it loads: section headings over row-shaped panels. */
function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading overview" className="space-y-[36px]">
      {[1, 1, 3].map((rows, i) => (
        <div key={i}>
          <Skeleton className="mb-[12px] h-[16px] w-[120px]" />
          <Panel>
            <RowSkeleton rows={rows} lead="none" />
          </Panel>
        </div>
      ))}
    </div>
  )
}
