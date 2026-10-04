'use client'

/**
 * Connect — the agent-native hub (IA restructure §6.14 / §9).
 * THE build door: backend change flows through the user's coding agent over
 * MCP (the in-app chat door was removed 2026-07-17).
 *
 * Two tabs, each a self-contained surface:
 *   • Agents — the ONE agent-wiring surface: the setup sequence (scoped key →
 *              one install command per agent, §9.1) and what the agent gets,
 *              beside key management and live MCP usage.
 *   • Direct — everything that calls the data plane without MCP: REST
 *              coordinates + TypeScript types / OpenAPI spec, frontend runtime
 *              telemetry + the origin allowlist (FrontendRuntimeCards), and
 *              real Postgres credentials + pg_dump exports
 *              (DirectDatabasePanel). Key MANAGEMENT lives only in Settings →
 *              API keys; this tab links there instead of embedding a second
 *              copy of the manager.
 *
 * The "Frontend SDK" tab was removed 2026-07-19 (a duplicate credentials
 * surface for an audience whose agent does the wiring).
 *
 * Deep links: `?tab=direct` opens the Direct tab (FrontendConnectionPill's
 * click target). Read from window.location on mount — NOT useSearchParams,
 * which would demand a Suspense boundary at export time — and written back
 * with replaceState when the tab changes.
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Bot, KeyRound, TerminalSquare, FileCode2, FileJson } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import {
  BUTTON_BASE,
  BUTTON_VARIANTS,
  CopyField,
  DetailList,
  DetailRow,
  KitButton,
  KitTab,
  KitTabs,
  PageHeader,
  SettingsCard,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { AgentInstallGuide, AgentCapabilitiesCard } from '@/components/connect/AgentInstallGuide'
import { AgentKeysPanel } from '@/components/connect/AgentKeysPanel'
import { FrontendRuntimeCards } from '@/components/connect/FrontendRuntimePanel'
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'

type Tab = 'agents' | 'direct'

const HEADERS: Record<Tab, { title: string; description: string }> = {
  agents: {
    title: 'Connect your coding agent',
    description: 'One scoped key, one command. Your agent reads the real schema and builds through governed, reversible changes.',
  },
  direct: {
    title: 'Direct access',
    description: 'REST and Postgres coordinates for anything that doesn’t speak MCP: your frontend, scripts, BI tools, backups.',
  },
}

export default function ProjectConnectPage() {
  const params = useParams()
  const projectId = params.id as string
  const [tab, setTab] = useState<Tab>('agents')
  // Bumped when AgentInstallGuide mints a key so the keys list refreshes.
  const [keysVersion, setKeysVersion] = useState(0)

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  // Honor ?tab=direct deep links (sidebar/deploy connection pill).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'direct') setTab('direct')
  }, [])

  const selectTab = (next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'agents') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(null, '', url.toString())
  }

  return (
    <div className="pb-16">
      <PageHeader
        title={HEADERS[tab].title}
        description={HEADERS[tab].description}
        tabs={
          <KitTabs>
            <KitTab active={tab === 'agents'} onClick={() => selectTab('agents')}>
              <Bot />
              Agents
            </KitTab>
            <KitTab active={tab === 'direct'} onClick={() => selectTab('direct')}>
              <TerminalSquare />
              Direct
            </KitTab>
          </KitTabs>
        }
      />

      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-7`}>
        {tab === 'agents' && (
          // Setup on the left, live state on the right. "What your agent gets"
          // sits under the setup sequence: it answers the question the pasted
          // prompt just raised.
          <div className="grid grid-cols-1 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-12">
            <div className="min-w-0 space-y-10">
              <AgentInstallGuide projectId={projectId} onKeyMinted={() => setKeysVersion((v) => v + 1)} />
              <AgentCapabilitiesCard />
            </div>
            <AgentKeysPanel projectId={projectId} refreshSignal={keysVersion} />
          </div>
        )}
        {tab === 'direct' && <DirectTab projectId={projectId} />}
      </div>
    </div>
  )
}

// ── Direct ────────────────────────────────────────────────────────────────────
// REST coordinates + typed contracts, frontend runtime telemetry + origin
// allowlist, then real Postgres credentials + pg_dump. Keys are managed in ONE
// place (Settings → API keys), so this tab links there.

function DirectTab({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)

  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => { if (!cancelled) setProject(p) })
      .catch(() => { /* rows fall back to their unset state */ })
    return () => { cancelled = true }
  }, [projectId])

  const apiBaseUrl = project?.apiUrlProd || project?.apiUrlStaging || project?.apiUrlDev || null

  return (
    <div className="max-w-[960px] space-y-6">
      <SettingsCard
        title="REST API"
        description="Every table is served as governed REST endpoints. Authenticate with an API key."
        footer="Generated from the live schema, so they always match what the runtime serves."
        actions={
          <>
            <a
              href={`/api/projects/${projectId}/types?file=types`}
              download="backenly.types.d.ts"
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.ghost} h-[28px] px-2.5 text-[12px]`}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              TypeScript types
            </a>
            <a
              href={`/api/projects/${projectId}/openapi`}
              download={`openapi-${projectId}.json`}
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.ghost} h-[28px] px-2.5 text-[12px]`}
            >
              <FileJson className="h-3.5 w-3.5" />
              OpenAPI spec
            </a>
            <KitButton size="sm" variant="secondary" icon={KeyRound} onClick={() => router.push(`/app/projects/${projectId}/settings?tab=keys`)}>
              Manage API keys
            </KitButton>
          </>
        }
      >
        <DetailList>
          <DetailRow label="API base URL">
            {apiBaseUrl ? <CopyField value={apiBaseUrl} /> : <span className="text-zinc-500">Set when the project is first published</span>}
          </DetailRow>
          <DetailRow label="Project ID">
            <CopyField value={projectId} />
          </DetailRow>
        </DetailList>
      </SettingsCard>

      <FrontendRuntimeCards projectId={projectId} />

      <DirectDatabasePanel projectId={projectId} />
    </div>
  )
}
