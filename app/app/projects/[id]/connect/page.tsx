'use client'

/**
 * Connect: everything that reaches this project from outside, and the
 * credentials it uses, each where it is set up (project console decision 4,
 * 2026-11-16).
 *
 *   Connect  ● Last call 12 min ago
 *   Agents   API   Postgres
 *
 *   Agents    the agents (keys and browser sign-ins) and their tool calls; with
 *             no agent yet, the setup itself (components/connect/AgentSetup)
 *   API       the API URL with types and the OpenAPI spec, API keys (moved
 *             here from Settings), allowed origins and browser requests
 *   Postgres  logins, backups, and on Cloud the shared-database note
 *
 * The fact beside the title is the agent's: live (●) only while it is at work
 * (a call within the hour), hollow when quiet, "No agent connected" otherwise.
 * No header sentence and no header button: each section creates its own.
 *
 * Deep links: `?tab=api`, `?tab=postgres`; the old `?tab=direct` opens API.
 * Read from window.location on mount (useSearchParams would need a Suspense
 * boundary at export time) and written back with replaceState.
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CopyField,
  KitTab,
  KitTabs,
  PageHeader,
  Skeleton,
  StatusGlyph,
} from '@/components/inspector/kit'
import { Panel, Section } from '@/components/autonomy/rows'
import { ErrorRow } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { AgentKeysPanel } from '@/components/connect/AgentKeysPanel'
import { FrontendRuntimeCards } from '@/components/connect/FrontendRuntimePanel'
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'

type Tab = 'agents' | 'api' | 'postgres'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'api', label: 'API' },
  { id: 'postgres', label: 'Postgres' },
]

/** `?tab=` as the page knows it; the old Direct tab's link opens API. */
function tabFrom(search: string): Tab {
  const t = new URLSearchParams(search).get('tab')
  if (t === 'api' || t === 'direct') return 'api'
  if (t === 'postgres') return 'postgres'
  return 'agents'
}

type ProjectLoad = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; project: Project }

export default function ProjectConnectPage() {
  const params = useParams()
  const projectId = params.id as string
  const [tab, setTab] = useState<Tab>('agents')
  const agent = useAgentConnection(projectId)
  const [load, setLoad] = useState<ProjectLoad>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  useEffect(() => {
    setTab(tabFrom(window.location.search))
  }, [])

  // The project carries the API URL and the region the Postgres note names.
  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => {
        if (!cancelled) setLoad({ state: 'ready', project: p })
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, attempt])

  const selectTab = (next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'agents') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(null, '', url.toString())
  }

  const fact =
    agent.status === 'loading' ? null : agent.connected ? (
      <span className="inline-flex items-center gap-[7px] text-[13px] leading-[20px] text-faint">
        {/* Live (●) only while it is at work; a quiet agent is hollow (lib/mcp/agent-connection.ts). */}
        <StatusGlyph state={agent.active ? 'live' : 'idle'} label={agent.active ? 'Agent at work' : 'Agent connected, quiet'} />
        {agent.lastSeenAt ? <Time iso={agent.lastSeenAt} prefix="Last call" /> : 'Connected'}
      </span>
    ) : (
      <span className="inline-flex items-center gap-[7px] text-[13px] leading-[20px] text-faint">
        <StatusGlyph state="idle" label="Not connected" />
        No agent connected
      </span>
    )

  return (
    <div className="pb-16">
      <PageHeader
        title="Connect"
        meta={fact}
        tabs={
          <KitTabs>
            {TABS.map((t) => (
              <KitTab key={t.id} active={tab === t.id} onClick={() => selectTab(t.id)}>
                {t.label}
              </KitTab>
            ))}
          </KitTabs>
        }
      />

      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-[28px]`}>
        {tab === 'agents' && <AgentKeysPanel projectId={projectId} />}
        {tab === 'api' && (
          <div className="space-y-[36px]">
            <ApiUrlSection projectId={projectId} load={load} onRetry={() => {
              setLoad({ state: 'loading' })
              setAttempt((n) => n + 1)
            }} />
            <ClientKeysPanel projectId={projectId} />
            <FrontendRuntimeCards projectId={projectId} />
          </div>
        )}
        {tab === 'postgres' && (
          <DirectDatabasePanel projectId={projectId} region={load.state === 'ready' ? load.project.region ?? null : null} />
        )}
      </div>
    </div>
  )
}

/**
 * The address every table is served at, and the contracts generated from the
 * live schema. A project still loading, or one that could not be loaded, is
 * not a project without an address: "—" only when the server says so.
 */
function ApiUrlSection({ projectId, load, onRetry }: { projectId: string; load: ProjectLoad; onRetry: () => void }) {
  const project = load.state === 'ready' ? load.project : null
  // {origin}/api/v1/{projectId} in the project's region, worked out by the server
  // (apiBaseUrl). An operator-supplied override still wins when one is filled.
  const apiBaseUrl = project?.apiUrlProd || project?.apiUrlStaging || project?.apiUrlDev || project?.apiBaseUrl || null
  const download = (href: string, file: string, label: string) => (
    <a href={href} download={file} className={`${BUTTON_BASE} ${BUTTON_SIZES.sm} ${BUTTON_VARIANTS.ghost}`}>
      {label}
    </a>
  )
  return (
    <Section id="api-url" title="API URL">
      <Panel>
        {load.state === 'failed' ? (
          <ErrorRow things="the API URL" onRetry={onRetry} />
        ) : (
          <div className="px-[20px] py-[14px]">
            <dl>
              <dt className="sr-only">API base URL</dt>
              <dd>
                {load.state === 'loading' ? (
                  <span aria-busy="true" className="block">
                    <Skeleton className="h-[34px] w-full" />
                    <span className="sr-only">Loading</span>
                  </span>
                ) : apiBaseUrl ? (
                  <CopyField value={apiBaseUrl} label="Copy API URL" />
                ) : (
                  <span className="text-[13px] text-faint">—</span>
                )}
              </dd>
            </dl>
            <div className="-ml-[10px] mt-[10px] flex flex-wrap items-center gap-[4px]">
              {download(`/api/projects/${projectId}/types?file=types`, 'backenly.types.d.ts', 'TypeScript types')}
              {download(`/api/projects/${projectId}/openapi`, `openapi-${projectId}.json`, 'OpenAPI spec')}
              <span className="ml-[6px] text-[12.5px] leading-[18px] text-faint">Generated from the live schema.</span>
            </div>
          </div>
        )}
      </Panel>
    </Section>
  )
}
