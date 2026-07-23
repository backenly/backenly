'use client'

/**
 * Connect — the agent-native hub (IA restructure §6.14 / §9).
 * Supersedes the old `?hub=connect-frontend` / `?hub=mcp` overlays and the
 * standalone /mcp + inspector/connected-apps pages (redirects in next.config).
 * THE build door — backend change flows through the user's coding agent over
 * MCP (the in-app chat door was removed 2026-07-17).
 *
 * Two tabs, each a self-contained surface:
 *   • Agents — the ONE agent-wiring surface, full-width split: the setup
 *              funnel (scoped key mint → one-paste prompt → per-agent command,
 *              §9.1) on the left; capabilities card + key management + live MCP
 *              usage (AgentKeysPanel) on the right.
 *   • Direct — everything that calls the data plane without MCP: REST
 *              coordinates + TypeScript types / OpenAPI spec, frontend runtime
 *              telemetry + the origin allowlist (FrontendRuntimeCards), and
 *              real Postgres credentials + pg_dump exports
 *              (DirectDatabasePanel). Key MANAGEMENT lives only in Settings →
 *              API Keys; this tab links there instead of embedding a second
 *              copy of the manager.
 *
 * The "Frontend SDK" tab was removed 2026-07-19: its copy-paste snippet
 * surfaced the same projectId + anon key the Agents funnel and llms.txt
 * already hand the agent — a duplicate credentials surface for an audience
 * whose agent does the wiring (the install flow draws the line at CLI +
 * agents + direct connect, with no human SDK page). Its non-redundant cards
 * (connection health + registered frontends) live on in the Direct tab.
 *
 * Deep links: `?tab=direct` opens the Direct tab (FrontendConnectionPill's
 * click target). Read from window.location on mount — NOT useSearchParams,
 * which would demand a Suspense boundary at export time.
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Cable, Bot, KeyRound, Copy, Check, TerminalSquare, FileCode2, FileJson, ArrowUpRight } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { KitTabs, KitTab, KitCard, KitCardHeader, KitCardBody, KitButton } from '@/components/inspector/kit'
import { AgentInstallGuide, AgentCapabilitiesCard } from '@/components/connect/AgentInstallGuide'
import { AgentKeysPanel } from '@/components/connect/AgentKeysPanel'
import { FrontendRuntimeCards } from '@/components/connect/FrontendRuntimePanel'
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'

type Tab = 'agents' | 'direct'

export default function ProjectConnectPage() {
  const params = useParams()
  const projectId = params.id as string
  const [tab, setTab] = useState<Tab>('agents')
  // Bumped when AgentInstallGuide mints a key so the keys list below refreshes.
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

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col text-white">
      {/* Tab strip sits directly under the global TopBar; each tab body owns its
          own header (Agents header below; Direct brings its own). */}
      <div className="px-8 pt-4">
        <KitTabs>
          <KitTab active={tab === 'agents'} onClick={() => setTab('agents')}>
            <Bot className="w-3.5 h-3.5" />
            Agents
          </KitTab>
          <KitTab active={tab === 'direct'} onClick={() => setTab('direct')}>
            <KeyRound className="w-3.5 h-3.5" />
            Direct
          </KitTab>
        </KitTabs>
      </div>

      <div className="flex-1">
        {tab === 'agents' && (
          <>
            <InspectorPageHeader
              icon={Cable}
              title="Connect your coding agent"
              description="One scoped key, one pasted prompt."
              badge={{ label: 'MCP', variant: 'beta' }}
            />
            {/* Full-width split like the Direct tab: setup funnel on the left,
                capabilities + key management/live activity on the right. */}
            <div className="px-8 py-6 pb-24">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
                <AgentInstallGuide
                  projectId={projectId}
                  onKeyMinted={() => setKeysVersion((v) => v + 1)}
                />
                <div className="min-w-0 space-y-6">
                  <AgentCapabilitiesCard />
                  <AgentKeysPanel projectId={projectId} refreshSignal={keysVersion} />
                </div>
              </div>
            </div>
          </>
        )}
        {tab === 'direct' && <DirectTab projectId={projectId} />}
      </div>
    </div>
  )
}

// ── Direct ────────────────────────────────────────────────────────────────────
// The non-MCP door: REST coordinates + typed contracts up top, frontend runtime
// telemetry + origin allowlist in the middle (FrontendRuntimeCards), real
// Postgres credentials + pg_dump below (DirectDatabasePanel, the open-loop
// surface §direct-access). Keys are managed in ONE place — Settings → API Keys —
// so this tab links there rather than embedding a duplicate manager.

function DirectTab({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => { if (!cancelled) setProject(p) })
      .catch(() => { /* rows fall back to em-dash */ })
    return () => { cancelled = true }
  }, [projectId])

  const apiBaseUrl = project?.apiUrlProd || project?.apiUrlStaging || project?.apiUrlDev || '—'

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
    } catch { /* clipboard blocked — non-fatal */ }
  }

  return (
    <>
      <InspectorPageHeader
        icon={TerminalSquare}
        title="Direct access"
        description="REST and Postgres coordinates for anything that doesn't speak MCP."
        badge={{ label: 'Managed', variant: 'managed' }}
      />
      <div className="px-8 py-6 pb-24">
        <KitCard>
          <KitCardHeader
            title="REST API"
            description="Governed REST endpoints for every table. Authenticate with an API key."
            actions={
              <KitButton
                variant="secondary"
                icon={KeyRound}
                onClick={() => router.push(`/app/projects/${projectId}/settings?tab=keys`)}
              >
                Manage API keys
              </KitButton>
            }
          />
          <KitCardBody className="space-y-3">
            <DirectRow label="API base URL" value={apiBaseUrl} copied={copied === 'url'} onCopy={apiBaseUrl !== '—' ? () => copy('url', apiBaseUrl) : undefined} />
            <DirectRow label="Project ID" value={projectId} copied={copied === 'id'} onCopy={() => copy('id', projectId)} />
            {/* Typed contracts for whatever consumes the REST surface. */}
            <div className="flex items-center gap-3 pt-1 border-t border-white/[0.06]">
              <a
                href={`/api/projects/${projectId}/types?file=types`}
                download="backenly.types.d.ts"
                className="group inline-flex items-center gap-1.5 text-[11.5px] text-zinc-400 hover:text-zinc-100 transition-colors pt-2"
              >
                <FileCode2 className="w-3 h-3" />
                TypeScript types
                <ArrowUpRight className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </a>
              <span className="h-3 w-px bg-white/[0.08] mt-2" aria-hidden />
              <a
                href={`/api/projects/${projectId}/openapi`}
                download={`openapi-${projectId}.json`}
                className="group inline-flex items-center gap-1.5 text-[11.5px] text-zinc-400 hover:text-zinc-100 transition-colors pt-2"
              >
                <FileJson className="w-3 h-3" />
                OpenAPI spec
                <ArrowUpRight className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </a>
            </div>
          </KitCardBody>
        </KitCard>

        <FrontendRuntimeCards projectId={projectId} />

        <DirectDatabasePanel projectId={projectId} />
      </div>
    </>
  )
}

function DirectRow({ label, value, onCopy, copied }: { label: string; value: string; onCopy?: () => void; copied?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-zinc-500 flex-shrink-0">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-mono text-zinc-200 truncate">{value}</span>
        {onCopy && (
          <button
            onClick={onCopy}
            className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-200 transition-colors"
            aria-label={`Copy ${label}`}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  )
}
