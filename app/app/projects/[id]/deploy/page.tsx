'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CheckCircle2, Loader2, Rocket, Copy, Check, AlertCircle, RotateCcw,
  Layers, ExternalLink, Database, Shield, HardDrive, Code2, ArrowRight,
  Globe, ShieldCheck,
} from 'lucide-react'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import { InspectorPageHeader, InspectorGovernanceFooter } from '@/components/inspector/InspectorPageHeader'
import { EnvVarsPanel } from '@/components/inspector/EnvVarsPanel'
import { FrontendConnectionPill } from '@/components/inspector/FrontendConnectionPill'
import {
  KIT,
  KitCard, KitCardHeader,
  KitButton, KitBadge, KitNote,
  EmptyState,
  SectionLabel,
} from '@/components/inspector/kit'

type ProjectStatus = 'PRIVATE' | 'DEPLOYING' | 'LIVE' | 'FAILED'

interface ProjectData {
  id: string
  name: string
  projectStatus: ProjectStatus
  publicUrl?: string | null
  deployedAt?: string | null
  deploymentError?: string | null
}

interface PublishedVersion {
  id: string
  version: number
  graphSnapshotId: string | null
  changeSummary: string
  publishedAt: string
  isActive: boolean
  isCurrent: boolean
  canRollback: boolean
}

interface BackendState {
  entities: Array<{ name: string; fieldCount: number }>
  apis: Array<{ method: string; path: string }>
  endpointCount?: number
  capabilities: Array<{ name: string; enabled: boolean; icon: string }>
  hasContent: boolean
  isLive: boolean
}

interface ReadinessCheck {
  id: string
  name: string
  description: string
  severity: 'blocking' | 'warning' | 'auto-fixable'
  status: 'pass' | 'fail' | 'skip'
  message: string
  details: string[]
  fixApplied: boolean
}

export default function PublishPage() {
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject] = useState<ProjectData | null>(null)
  const [publishedVersions, setPublishedVersions] = useState<PublishedVersion[]>([])
  const [backendState, setBackendState] = useState<BackendState | null>(null)
  const [readinessChecks, setReadinessChecks] = useState<ReadinessCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [rollingBackId, setRollingBackId] = useState<string | null>(null)

  const fetchAll = async () => {
    try {
      const [projectRes, stateRes, rollbackRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/state`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/rollback`, { credentials: 'include' }),
      ])

      if (projectRes.ok) {
        const result = await projectRes.json()
        if (result.success && result.data) setProject(result.data)
      }

      let state: BackendState | null = null
      if (stateRes.ok) {
        const result = await stateRes.json()
        state = result
        setBackendState(result)
      }

      if (rollbackRes.ok) {
        const result = await rollbackRes.json()
        if (result.success) setPublishedVersions(result.versions || [])
      }

      const hasAuth = state?.capabilities.some(c => c.name === 'Authentication') ?? false
      const hasRealContent = (state?.hasContent ?? false) || hasAuth
      if (hasRealContent) {
        try {
          // POST → run auto-fixes (RLS, JWT secret, etc.) BEFORE rendering the
          // score, so the page shows the post-repair state rather than a stale
          // snapshot. Same logic the autonomy runtime applies in the background.
          const readinessRes = await fetch(`/api/projects/${projectId}/readiness`, {
            method: 'POST',
            credentials: 'include',
          })
          if (readinessRes.ok) {
            const r = await readinessRes.json()
            setReadinessChecks(r.report?.checks ?? [])
          }
        } catch { /* best-effort */ }
      } else {
        setReadinessChecks([])
      }
    } catch (err) {
      console.error('Failed to fetch project:', err)
      setError('Failed to load project data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAll() }, [projectId])

  useEffect(() => {
    if (project?.projectStatus === 'DEPLOYING') {
      // Poll the project row only — fetchAll re-runs the readiness engine
      // (behavioral verification + security audit), which is far too heavy
      // to fire every 2 seconds. Full refresh once the status settles.
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects/${projectId}`, { credentials: 'include' })
          if (!res.ok) return
          const result = await res.json()
          if (result.success && result.data) {
            setProject(result.data)
            if (result.data.projectStatus !== 'DEPLOYING') await fetchAll()
          }
        } catch { /* transient — next tick retries */ }
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [project?.projectStatus])

  const handlePublish = async () => {
    if (!projectId || publishing) return
    setPublishing(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/go-live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        // Readiness-blocked publishes return the fresh report — surface it in
        // the readiness panel immediately instead of leaving stale checks up.
        if (data.readiness?.checks) setReadinessChecks(data.readiness.checks)
        throw new Error(data.error || 'Publish failed')
      }
      setSuccessMsg(data.message || (data.version ? `Published v${data.version} successfully` : 'Published successfully'))
      setTimeout(() => setSuccessMsg(null), 4000)
      await fetchAll()
    } catch (err: any) {
      setError(err.message || 'Publish failed')
      await fetchAll()
    } finally {
      setPublishing(false)
    }
  }

  const handleRollback = async (deploymentId: string, version: number) => {
    if (rollingBackId) return
    setRollingBackId(deploymentId)
    setError(null)
    setSuccessMsg(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deploymentId }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        if (data.code === 'PLAN_LIMIT_EXCEEDED') {
          throw new Error('Rollback is available on the Pro plan and higher. Upgrade in Settings → Billing to unlock it.')
        }
        throw new Error(data.error || 'Rollback failed')
      }
      setSuccessMsg(`Rolled back to Published v${version}`)
      setTimeout(() => setSuccessMsg(null), 4000)
      await fetchAll()
    } catch (err: any) {
      setError(err.message || 'Rollback failed')
    } finally {
      setRollingBackId(null)
    }
  }

  const handleCopyURL = () => {
    if (project?.publicUrl) {
      navigator.clipboard.writeText(project.publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  if (loading) return <GlobalLoading message="Loading..." />

  if (!project) {
    return (
      <div className="min-h-screen bg-[#101116] flex items-center justify-center">
        <p className="text-zinc-500 text-[13px]">Project not found</p>
      </div>
    )
  }

  const status = project.projectStatus
  const isLive = status === 'LIVE'
  const hasAuth = backendState?.capabilities.some(c => c.name === 'Authentication') ?? false
  const hasStorage = backendState?.capabilities.some(c => c.name === 'File Storage') ?? false
  const hasRealBackend = (backendState?.hasContent ?? false) || hasAuth
  const latestPublishedVersion = publishedVersions[0]
  const endpointCount = backendState?.endpointCount ?? (backendState?.apis.length ?? 0) * 5
  const tableCount = backendState?.entities.length ?? 0
  const apiResourceCount = backendState?.apis.length ?? 0

  const passingChecks = readinessChecks.filter(c => c.status === 'pass').length
  const blockingChecks = readinessChecks.filter(c => c.status === 'fail' && c.severity === 'blocking')
  const warningChecks = readinessChecks.filter(c => c.status === 'fail' && c.severity !== 'blocking')

  /**
   * What the readiness card actually draws: anything that FAILED, then the
   * passes, capped. Sorting before the cap is what guarantees a blocker can
   * never be the item that falls off the end — see the note at the render site.
   */
  const VISIBLE_CHECK_LIMIT = 8
  const orderedChecks = [
    ...blockingChecks,
    ...warningChecks,
    ...readinessChecks.filter(c => c.status === 'pass'),
  ]
  const visibleChecks = orderedChecks.slice(0, VISIBLE_CHECK_LIMIT)
  const hiddenCheckCount = Math.max(0, orderedChecks.length - visibleChecks.length)

  const runtimeStatus: { label: string; tone: 'operational' | 'attention' | 'paused' | 'managed' | 'beta' } = (() => {
    if (status === 'LIVE' && hasRealBackend) return { label: 'Live', tone: 'operational' }
    if (status === 'DEPLOYING')               return { label: 'Deploying', tone: 'attention' }
    if (status === 'FAILED')                  return { label: 'Failed', tone: 'attention' }
    if (hasRealBackend)                       return { label: 'Ready', tone: 'managed' }
    return { label: 'Idle', tone: 'paused' }
  })()

  const runtimeTagline = (() => {
    if (status === 'LIVE' && hasRealBackend) return 'Production endpoint is serving traffic: every mutation governed, snapshotted, and reversible.'
    if (status === 'DEPLOYING')               return 'Creating a stable production snapshot. Runtime stays locked until activation completes.'
    if (status === 'FAILED')                  return 'Publish failed. Production endpoint is unchanged; your previous version is still serving.'
    if (hasRealBackend)                       return 'Backend built. Publish to create a stable, versioned endpoint your app can rely on.'
    return 'No backend artifacts yet. Wire your coding agent on the Connect page to start building.'
  })()

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Rocket}
        title="Publish"
        description="Production updates only when you publish · runtime stays locked until then"
        badge={
          status === 'LIVE' && hasRealBackend
            ? { label: 'Live', variant: 'live' }
            : status === 'DEPLOYING'
            ? { label: 'Deploying', variant: 'beta' }
            : undefined
        }
        actions={
          hasRealBackend && !isLive ? (
            <KitButton
              variant="primary"
              icon={publishing ? Loader2 : Rocket}
              onClick={handlePublish}
              disabled={publishing}
              className={publishing ? '[&_svg]:animate-spin' : ''}
            >
              {publishing ? 'Publishing…' : 'Publish now'}
            </KitButton>
          ) : undefined
        }
      />

      <div className="flex-1 px-8 py-6">
        {/* Compact status + version row — replaces "Production Runtime"
            duplicate hero. Pill + tagline + version + deployed-ago all on one
            line; FrontendConnectionPill stays on the right where it's useful. */}
        <div className="mb-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            <KitBadge tone={runtimeStatus.tone ?? 'operational'}>{runtimeStatus.label}</KitBadge>
            <span className="text-[12.5px] text-zinc-400 leading-snug truncate max-w-md">{runtimeTagline}</span>
            {isLive && latestPublishedVersion && (
              <>
                <span className="w-px h-3 bg-white/[0.08]" />
                <span className="font-mono text-[12px] font-semibold text-zinc-300 tabular-nums">v{latestPublishedVersion.version}</span>
                {project.deployedAt && (
                  <span className="text-[12px] text-zinc-500">deployed {formatTimeAgo(project.deployedAt)}</span>
                )}
              </>
            )}
          </div>
          {isLive && (
            <div className="hidden md:flex items-center gap-3 flex-shrink-0">
              <FrontendConnectionPill projectId={projectId} variant="badge" />
            </div>
          )}
        </div>

        {/* Banners */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4">
              <KitNote tone="warn" icon={AlertCircle} title="Publish error">
                <span className="whitespace-pre-line">{error}</span>
              </KitNote>
            </motion.div>
          )}
          {successMsg && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4">
              <KitNote tone="success" icon={CheckCircle2}>{successMsg}</KitNote>
            </motion.div>
          )}
        </AnimatePresence>

        {/* LIVE state */}
        {isLive && hasRealBackend && (
          <>
            {/* Inline production counts — one dense mono rail. */}
            <div className="mb-4 rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/[0.06]">
                {[
                  { value: tableCount, label: 'tables live' },
                  { value: endpointCount, label: 'HTTP endpoints' },
                  { value: apiResourceCount, label: 'API resources' },
                  { value: publishedVersions.length, label: 'versions' },
                ].map(({ value, label }) => (
                  <div key={label} className="flex items-baseline gap-2 px-4 py-3">
                    <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">{value}</span>
                    <span className="text-[11px] text-zinc-500 leading-none">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-4 items-start">
              <div className="flex-1 min-w-0 flex flex-col gap-4">
                {/* Public URL */}
                {project.publicUrl && (
                  <KitCard>
                    <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2.5">
                      <Globe className="w-3 h-3 text-zinc-500" />
                      <SectionLabel>Production endpoint</SectionLabel>
                      <KitBadge tone="operational" className="ml-auto">active</KitBadge>
                    </div>
                    <div className="px-4 py-3.5 flex items-center gap-3">
                      <code className="flex-1 text-[12.5px] text-zinc-100 font-mono truncate min-w-0">
                        {project.publicUrl}
                      </code>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={handleCopyURL} className="p-2 rounded-md hover:bg-white/[0.06] transition-colors" title="Copy URL">
                          {copied
                            ? <Check className="w-3.5 h-3.5 text-violet-400" />
                            : <Copy className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-100 transition-colors" />}
                        </button>
                        <a href={project.publicUrl} target="_blank" rel="noopener noreferrer" className="p-2 rounded-md hover:bg-white/[0.06] transition-colors" title="Open in new tab">
                          <ExternalLink className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-100 transition-colors" />
                        </a>
                      </div>
                    </div>
                  </KitCard>
                )}

                {/* Action grid */}
                <div className="grid grid-cols-2 gap-4">
                  <a
                    href={`/app/projects/${projectId}/connect`}
                    className="flex items-center gap-3 px-4 py-3.5 bg-[#16171d] border border-white/[0.07] hover:border-white/[0.14] rounded-xl transition-colors group shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
                  >
                    <Code2 className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium text-zinc-100">Connect your agent</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">MCP, keys, and direct database access</p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-zinc-600 group-hover:text-zinc-300 ml-auto flex-shrink-0 transition-all group-hover:translate-x-0.5" />
                  </a>
                  <button
                    onClick={handlePublish}
                    disabled={publishing}
                    className="flex items-center gap-3 px-4 py-3.5 bg-[#16171d] border border-white/[0.07] hover:border-white/[0.14] rounded-xl transition-colors group disabled:opacity-40 disabled:cursor-not-allowed text-left shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
                  >
                    {publishing
                      ? <Loader2 className="w-3.5 h-3.5 text-violet-300 animate-spin flex-shrink-0" />
                      : <Rocket className="w-3.5 h-3.5 text-violet-300 flex-shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium text-zinc-100">{publishing ? 'Publishing…' : 'Publish update'}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Push latest changes to production</p>
                    </div>
                  </button>
                </div>

                {/* Version history */}
                {publishedVersions.length > 0 && (
                  <KitCard>
                    <KitCardHeader
                      title="Version history"
                      actions={<span className="font-mono text-[11px] text-zinc-500 tabular-nums">{publishedVersions.length}</span>}
                    />
                    {/* A deployment list, not a timeline. The dotted rail read
                        fine at one version and turns into a wall at twenty;
                        columns stay scannable however long the history gets. */}
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className={KIT.gridHead}>
                          <th className="w-16 border-b border-white/[0.06] px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                            Ver
                          </th>
                          <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                            Change
                          </th>
                          <th className="w-40 border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                            Published
                          </th>
                          <th className="w-28 border-b border-white/[0.06] px-4 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                            State
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {publishedVersions.map((version) => {
                          const isRollingBack = rollingBackId === version.id
                          return (
                            <tr key={version.id} className={`group/row transition-colors ${KIT.rowHoverOn}`}>
                              <td className="border-b border-white/[0.04] px-4 py-2.5">
                                <span
                                  className={`font-mono text-[11.5px] font-medium tabular-nums ${
                                    version.isActive ? 'text-violet-300' : 'text-zinc-500'
                                  }`}
                                >
                                  v{version.version}
                                </span>
                              </td>
                              <td className="border-b border-white/[0.04] px-3 py-2.5">
                                <span className="text-[12.5px] text-zinc-200">{version.changeSummary}</span>
                              </td>
                              <td className="border-b border-white/[0.04] px-3 py-2.5 font-mono text-[10.5px] tabular-nums text-zinc-600">
                                {formatDate(version.publishedAt)}
                                <span className="text-zinc-700"> · {formatTimeAgo(version.publishedAt)}</span>
                              </td>
                              <td className="border-b border-white/[0.04] px-4 py-2.5 text-right">
                                {version.isActive ? (
                                  <KitBadge tone="operational">active</KitBadge>
                                ) : version.canRollback ? (
                                  <KitButton
                                    variant="ghost"
                                    size="sm"
                                    icon={isRollingBack ? Loader2 : RotateCcw}
                                    onClick={() => handleRollback(version.id, version.version)}
                                    disabled={!!rollingBackId}
                                    className={isRollingBack ? '[&_svg]:animate-spin' : ''}
                                  >
                                    {isRollingBack ? 'Rolling back…' : 'Roll back'}
                                  </KitButton>
                                ) : (
                                  <span className="font-mono text-[10.5px] text-zinc-700">archived</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </KitCard>
                )}

                <EnvVarsPanel projectId={projectId} />
              </div>

              {/* Sidebar */}
              <div className="w-80 flex-shrink-0 flex flex-col gap-4">
                <KitCard className="p-4">
                  <div className="mb-3.5">
                    <SectionLabel>Capabilities in production</SectionLabel>
                  </div>
                  <div className="space-y-2.5">
                    {[
                      { icon: Database, label: 'Database',      active: tableCount > 0,   sub: `${tableCount} tables` },
                      { icon: Code2,    label: 'REST APIs',     active: endpointCount > 0, sub: `${endpointCount} endpoints` },
                      { icon: Shield,   label: 'Authentication',active: hasAuth,           sub: hasAuth ? 'JWT sessions' : 'not configured' },
                      { icon: HardDrive,label: 'File storage',  active: hasStorage,        sub: hasStorage ? 'buckets provisioned' : 'not configured' },
                    ].map(({ icon: Icon, label, active, sub }) => (
                      <div key={label} className="flex items-center gap-2.5">
                        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${active ? 'text-zinc-400' : 'text-zinc-700'}`} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-[12px] font-medium ${active ? 'text-zinc-200' : 'text-zinc-500'}`}>{label}</p>
                          <p className="font-mono text-[10.5px] text-zinc-600 tabular-nums">{sub}</p>
                        </div>
                        {active && <Check className="w-3 h-3 text-emerald-400/70 flex-shrink-0" />}
                      </div>
                    ))}
                  </div>
                </KitCard>

                {readinessChecks.length > 0 && (
                  <KitCard className="p-4">
                    <div className="flex items-center justify-between mb-3.5">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-3 h-3 text-zinc-500" />
                        <SectionLabel>Runtime readiness</SectionLabel>
                      </div>
                      {blockingChecks.length === 0 ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-emerald-300/90">
                          <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
                          ready
                        </span>
                      ) : (
                        <a
                          href="/app"
                          className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-amber-500 hover:text-amber-400"
                          title="A few things to clear. Open the dashboard"
                        >
                          <span className="h-[5px] w-[5px] rounded-full bg-amber-400" />
                          {blockingChecks.length} to clear
                        </a>
                      )}
                    </div>
                    <p className="text-[12px] text-zinc-500 leading-5">
                      {blockingChecks.length === 0
                        ? `${passingChecks} of ${readinessChecks.length} checks passing. Autonomy is watching error rate, latency, and anomalies in the background.`
                        : 'Open the dashboard to see what needs attention. Autonomy is handling routine issues automatically.'}
                    </p>
                  </KitCard>
                )}
              </div>
            </div>
          </>
        )}

        {/* PRIVATE — no backend */}
        {status === 'PRIVATE' && !hasRealBackend && (
          <KitCard>
            <EmptyState
              icon={Layers}
              title="Empty backend"
              description="Describe your app to your coding agent and Backenly lays the foundation: tables, APIs, auth, all of it."
              action={
                <KitButton variant="primary" icon={Database} onClick={() => location.assign(`/app/projects/${projectId}/database`)}>
                  Build your backend
                </KitButton>
              }
            />
          </KitCard>
        )}

        {/* PRIVATE — ready to publish */}
        {status === 'PRIVATE' && hasRealBackend && (
          <div className="flex gap-4 items-start">
            <KitCard className="flex-1 min-w-0">
              <div className="px-5 py-6">
                <div className="flex items-center gap-2 mb-1.5">
                  <Rocket className="w-4 h-4 text-violet-300" />
                  <h2 className="text-[15px] font-semibold text-zinc-50 tracking-[-0.01em]">Ready to go live</h2>
                </div>
                <p className="text-[12.5px] text-zinc-500 mb-4 max-w-[420px] leading-5">
                  Publish to create a stable, versioned endpoint your app can rely on.
                </p>
                <KitButton
                  variant="primary"
                  icon={publishing ? Loader2 : Rocket}
                  onClick={handlePublish}
                  disabled={publishing}
                  className={publishing ? '[&_svg]:animate-spin' : ''}
                >
                  {publishing ? 'Publishing…' : 'Publish backend'}
                </KitButton>
              </div>
              <div className="border-t border-white/[0.06] px-5 py-2.5 flex items-center gap-5 flex-wrap">
                {tableCount > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Database className="w-3 h-3 text-zinc-600" />
                    <span className="font-mono text-[11px] text-zinc-400 tabular-nums">{tableCount} tables</span>
                  </div>
                )}
                {endpointCount > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Code2 className="w-3 h-3 text-zinc-600" />
                    <span className="font-mono text-[11px] text-zinc-400 tabular-nums">{endpointCount} endpoints</span>
                  </div>
                )}
                {hasAuth && (
                  <div className="flex items-center gap-1.5">
                    <Shield className="w-3 h-3 text-zinc-600" />
                    <span className="font-mono text-[11px] text-zinc-400">auth</span>
                  </div>
                )}
                {hasStorage && (
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="w-3 h-3 text-zinc-600" />
                    <span className="font-mono text-[11px] text-zinc-400">storage</span>
                  </div>
                )}
              </div>
            </KitCard>

            {readinessChecks.length > 0 && (
              <KitCard className="w-80 flex-shrink-0 p-4">
                <div className="flex items-center justify-between mb-3.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-3 h-3 text-zinc-500" />
                    <SectionLabel>Pre-publish readiness</SectionLabel>
                  </div>
                  {blockingChecks.length === 0 ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-emerald-300/90">
                      <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
                      cleared
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-amber-500">
                      <span className="h-[5px] w-[5px] rounded-full bg-amber-400" />
                      {blockingChecks.length} to clear
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {/*
                    Failures first, blocking before warning, and only THEN the
                    passes.

                    This list used to render `readinessChecks.slice(0, 8)` in
                    the server's own order while the "N to clear" counter above
                    it was computed across every check. So when the one blocking
                    failure sat at index 8 or beyond it was silently cropped,
                    and the panel showed eight green ticks under a header
                    reading "1 to clear" — with nothing anywhere naming the
                    blocker. Publishing then refused with "1 readiness issue
                    must be cleared first. Details are in the readiness panel",
                    pointing at a panel that did not contain them.

                    Ordering by severity makes the crop harmless: whatever is
                    blocking publish is now always in the visible set, because
                    it sorts above everything that passed.
                  */}
                  {visibleChecks.map(check => (
                    <div key={check.id} title={check.message} className="flex items-start gap-2">
                      {check.status === 'pass' ? (
                        <Check className="w-3 h-3 text-emerald-400/70 flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className={`w-3 h-3 flex-shrink-0 mt-0.5 ${
                          check.severity === 'blocking' ? 'text-rose-300' : 'text-amber-500/80'
                        }`} />
                      )}
                      <div className="min-w-0">
                        <p className={`text-[12px] leading-snug ${
                          check.status === 'pass' ? 'text-zinc-500' : 'text-zinc-300'
                        }`}>{check.name}</p>
                        {/*
                          A failing check states WHY inline. "Details are in the
                          readiness panel" was only true if the panel showed the
                          reason, and it showed the name alone — the message was
                          buried in a title attribute nobody hovers.
                        */}
                        {check.status !== 'pass' && check.message && (
                          <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">{check.message}</p>
                        )}
                      </div>
                    </div>
                  ))}
                  {hiddenCheckCount > 0 && (
                    <p className="pt-0.5 text-[11.5px] text-zinc-600">
                      +{hiddenCheckCount} more passing {hiddenCheckCount === 1 ? 'check' : 'checks'}
                    </p>
                  )}
                </div>
              </KitCard>
            )}
          </div>
        )}

        {/* DEPLOYING */}
        {status === 'DEPLOYING' && (
          <KitCard className="px-5 py-6">
            <div className="flex items-center gap-2.5 mb-1.5">
              <div className="w-4 h-4 rounded-full border-2 border-violet-500/15 border-t-violet-300 animate-spin" />
              <h2 className="text-[15px] font-semibold text-zinc-50 tracking-[-0.01em]">Publishing…</h2>
            </div>
            <p className="text-[12.5px] text-zinc-500 mb-4">Creating a stable production snapshot.</p>
            <div className="space-y-2.5">
              {['Snapshotting backend', 'Provisioning endpoint', 'Activating production'].map((step, i) => (
                <motion.div key={step} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.3 }}
                  className="flex items-center gap-2.5">
                  <Loader2 className="w-3 h-3 text-violet-300 animate-spin flex-shrink-0" />
                  <span className="text-[12.5px] text-zinc-300">{step}</span>
                </motion.div>
              ))}
            </div>
          </KitCard>
        )}

        {/* FAILED */}
        {status === 'FAILED' && (
          <KitCard>
            <EmptyState
              icon={AlertCircle}
              title="Couldn't publish"
              description={project.deploymentError || "Something went wrong on the way out. Try again, or ask me to look at it."}
              action={
                <KitButton variant="primary" icon={publishing ? Loader2 : Rocket} onClick={handlePublish} disabled={publishing} className={publishing ? '[&_svg]:animate-spin' : ''}>
                  {publishing ? 'Retrying…' : 'Try again'}
                </KitButton>
              }
            />
          </KitCard>
        )}

        {/* Edge case: marked live but no backend */}
        {isLive && !hasRealBackend && (
          <KitCard>
            <EmptyState
              icon={AlertCircle}
              title="Live, but empty"
              description="Your project is published but there's nothing to serve yet. Build the backend first."
              action={
                <KitButton variant="secondary" icon={Database} onClick={() => location.assign(`/app/projects/${projectId}/database`)}>
                  Build your backend
                </KitButton>
              }
            />
          </KitCard>
        )}

        <InspectorGovernanceFooter />
      </div>
    </div>
  )
}
