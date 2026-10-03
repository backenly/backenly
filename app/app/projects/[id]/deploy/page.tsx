'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertCircle, Cable, Check, CheckCircle2, Code2, Database, ExternalLink, Globe, HardDrive, Info, Layers, Loader2,
  Lock, Rocket, RotateCcw, Shield, ShieldCheck,
} from 'lucide-react'
import { EnvVarsPanel } from '@/components/inspector/EnvVarsPanel'
import { FrontendConnectionPill } from '@/components/inspector/FrontendConnectionPill'
import {
  AgentPrompt,
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CopyField,
  EmptyState,
  KIT,
  KitButton,
  KitCard,
  KitCardHeader,
  KitColumns,
  KitNote,
  PageHeader,
  SettingsCard,
  Skeleton,
  Spinner,
  Stat,
  StatStrip,
  StatusDot,
  type StatusTone,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, RULE } from '@/components/console/tokens'

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
          throw new Error('Rollback is included in Pro and higher. Compare plans on the Billing page.')
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

  if (loading) {
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader className="!px-0" title="Deploy" description="Production changes only when you publish." />
        <div className="space-y-4" aria-hidden>
          <Skeleton className="h-[76px] w-full rounded-[10px]" />
          <Skeleton className="h-[200px] w-full rounded-[10px]" />
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader className="!px-0" title="Deploy" />
        <KitCard>
          <EmptyState icon={AlertCircle} title="Project not found" description="This project does not exist, or you no longer have access to it." />
        </KitCard>
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
   * never be the item that falls off the end. This list used to render the
   * server's own order sliced to eight while the "N to clear" counter counted
   * every check, so a blocker at index 8 was cropped and the panel showed
   * eight green ticks under "1 to clear" with nothing naming the blocker.
   */
  const VISIBLE_CHECK_LIMIT = 8
  const orderedChecks = [
    ...blockingChecks,
    ...warningChecks,
    ...readinessChecks.filter(c => c.status === 'pass'),
  ]
  const visibleChecks = orderedChecks.slice(0, VISIBLE_CHECK_LIMIT)
  const hiddenCheckCount = Math.max(0, orderedChecks.length - visibleChecks.length)

  const runtimeStatus: { label: string; tone: StatusTone; pulse?: boolean } = (() => {
    if (status === 'LIVE' && hasRealBackend) return { label: 'Live', tone: 'operational' }
    if (status === 'DEPLOYING') return { label: 'Publishing', tone: 'attention', pulse: true }
    if (status === 'FAILED') return { label: 'Publish failed', tone: 'failed' }
    if (hasRealBackend) return { label: 'Ready to publish', tone: 'managed' }
    return { label: 'Nothing to publish', tone: 'paused' }
  })()

  const runtimeTagline = (() => {
    if (status === 'LIVE' && hasRealBackend) return 'Your production endpoint is serving. Every change is governed, snapshotted and reversible.'
    if (status === 'DEPLOYING') return 'Creating a stable production snapshot. The runtime stays locked until activation completes.'
    if (status === 'FAILED') return 'The last publish failed. Production is unchanged, and the previous version is still serving.'
    if (hasRealBackend) return 'Your backend is built. Publish it to get a stable, versioned endpoint your app can rely on.'
    return 'Production changes only when you publish. Connect your coding agent to start building.'
  })()

  const publishButton = (label: string) => (
    <KitButton variant="primary" icon={Rocket} onClick={handlePublish} loading={publishing}>
      {publishing ? 'Publishing…' : label}
    </KitButton>
  )

  const readinessPanel = (title: string) =>
    readinessChecks.length > 0 ? (
      <KitCard className="overflow-hidden">
        <KitCardHeader
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-zinc-500" strokeWidth={1.75} />
              {title}
            </span>
          }
          actions={
            blockingChecks.length === 0 ? (
              <StatusDot tone="operational" label={`${passingChecks} of ${readinessChecks.length} passing`} />
            ) : (
              <StatusDot tone="attention" label={`${blockingChecks.length} to clear`} />
            )
          }
        />
        <ul className="space-y-2.5 px-4 py-3.5">
          {visibleChecks.map(check => (
            <li key={check.id} className="flex items-start gap-2.5">
              {check.status === 'pass' ? (
                <Check className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-emerald-400/80" strokeWidth={2} />
              ) : (
                <AlertCircle
                  className={`mt-[3px] h-3.5 w-3.5 flex-shrink-0 ${check.severity === 'blocking' ? 'text-rose-300' : 'text-amber-300'}`}
                  strokeWidth={2}
                />
              )}
              <div className="min-w-0">
                <p className={`text-[13px] leading-[19px] ${check.status === 'pass' ? 'text-zinc-400' : 'text-zinc-100'}`}>{check.name}</p>
                {/* A failing check states WHY inline, not in a title attribute nobody hovers. */}
                {check.status !== 'pass' && check.message && (
                  <p className="mt-0.5 text-[12.5px] leading-[18px] text-zinc-500">{check.message}</p>
                )}
              </div>
            </li>
          ))}
          {hiddenCheckCount > 0 && (
            <li className="pl-6 text-[12.5px] text-zinc-500">
              +{hiddenCheckCount} more passing {hiddenCheckCount === 1 ? 'check' : 'checks'}
            </li>
          )}
        </ul>
        {blockingChecks.length > 0 && (
          <div className={`border-t ${RULE} px-4 py-2.5`}>
            <Link
              href={`/app/projects/${projectId}`}
              className="text-[12.5px] font-medium text-zinc-300 hover:text-zinc-50 hover:underline"
            >
              See what needs attention on Overview
            </Link>
          </div>
        )}
      </KitCard>
    ) : null

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader
        className="!px-0"
        title="Deploy"
        meta={<StatusDot tone={runtimeStatus.tone} label={runtimeStatus.label} pulse={runtimeStatus.pulse} />}
        description={runtimeTagline}
        actions={
          hasRealBackend && status !== 'DEPLOYING' ? publishButton(isLive ? 'Publish update' : 'Publish now') : undefined
        }
      />

      <div className="space-y-4">
        <AnimatePresence>
          {error && (
            <motion.div key="err" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <KitNote tone="warn" icon={AlertCircle} title="The publish did not complete">
                <span className="whitespace-pre-line">{error}</span>
              </KitNote>
            </motion.div>
          )}
          {successMsg && (
            <motion.div key="ok" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <KitNote tone="success" icon={CheckCircle2}>
                {successMsg}
              </KitNote>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── LIVE ─────────────────────────────────────────────── */}
        {isLive && hasRealBackend && (
          <>
            <StatStrip>
              <Stat label="Tables live" value={tableCount.toLocaleString()} />
              <Stat label="HTTP endpoints" value={endpointCount.toLocaleString()} />
              <Stat label="API resources" value={apiResourceCount.toLocaleString()} />
              <Stat
                label="Published versions"
                value={publishedVersions.length.toLocaleString()}
                hint={
                  latestPublishedVersion && project.deployedAt
                    ? `v${latestPublishedVersion.version} · ${formatTimeAgo(project.deployedAt)}`
                    : undefined
                }
              />
            </StatStrip>

            <KitColumns
              main={
                <>
                  {project.publicUrl && (
                    <KitCard className="overflow-hidden">
                      <KitCardHeader
                        title={
                          <span className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-zinc-500" strokeWidth={1.75} />
                            Production endpoint
                          </span>
                        }
                        actions={<StatusDot tone="operational" label="Serving" />}
                      />
                      <div className="flex items-center gap-2 px-4 py-3.5">
                        <CopyField value={project.publicUrl} className="flex-1" />
                        <a
                          href={project.publicUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Open the endpoint in a new tab"
                          className={`inline-flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[7px] border ${EDGE} text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100 ${FOCUS}`}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </KitCard>
                  )}

                  {publishedVersions.length > 0 && (
                    <KitCard className="overflow-hidden">
                      <KitCardHeader
                        title="Versions"
                        actions={<span className="text-[12px] tabular-nums text-zinc-500">{publishedVersions.length}</span>}
                      />
                      {/* A version is "active" only while its snapshot still equals
                          the live graph (see app/api/projects/[id]/rollback). Every
                          agent edit and every autonomous fix moves the live graph,
                          so a published project drifts off its last version. Say
                          that, rather than a table where nothing is live under a
                          header that says something is. */}
                      {!publishedVersions.some(v => v.isActive) && (
                        <div className="px-4 pt-3">
                          <KitNote tone="info" icon={Info}>
                            The live backend has changed since v{publishedVersions[0]?.version} was published. Publish an
                            update to save the current state as a version you can roll back to.
                          </KitNote>
                        </div>
                      )}
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] border-separate border-spacing-0">
                          <thead>
                            <tr className={KIT.gridHead}>
                              <th scope="col" className={`w-16 border-b ${RULE} px-4 py-2 text-left text-[12px] font-normal text-zinc-500`}>Version</th>
                              <th scope="col" className={`border-b ${RULE} px-3 py-2 text-left text-[12px] font-normal text-zinc-500`}>Change</th>
                              <th scope="col" className={`w-44 whitespace-nowrap border-b ${RULE} px-3 py-2 text-left text-[12px] font-normal text-zinc-500`}>Published</th>
                              <th scope="col" className={`w-36 whitespace-nowrap border-b ${RULE} px-4 py-2 text-right text-[12px] font-normal text-zinc-500`}>
                                <span className="sr-only">State</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {publishedVersions.map(version => {
                              const isRollingBack = rollingBackId === version.id
                              return (
                                <tr key={version.id} className={`transition-colors ${KIT.rowHoverOn}`}>
                                  <td className="border-b border-white/[0.04] px-4 py-2.5">
                                    <span className={`text-[13px] font-medium tabular-nums ${version.isActive ? 'text-zinc-50' : 'text-zinc-400'}`}>
                                      v{version.version}
                                    </span>
                                  </td>
                                  <td className="border-b border-white/[0.04] px-3 py-2.5 text-[13px] text-zinc-300">{version.changeSummary}</td>
                                  <td className="whitespace-nowrap border-b border-white/[0.04] px-3 py-2.5 text-[12.5px] tabular-nums text-zinc-500">
                                    {formatDate(version.publishedAt)}
                                    <span className="text-zinc-600"> · {formatTimeAgo(version.publishedAt)}</span>
                                  </td>
                                  <td className="whitespace-nowrap border-b border-white/[0.04] px-4 py-2 text-right">
                                    {version.isActive ? (
                                      <StatusDot tone="operational" label="Live" />
                                    ) : version.canRollback ? (
                                      <KitButton
                                        variant="ghost"
                                        size="sm"
                                        icon={RotateCcw}
                                        loading={isRollingBack}
                                        onClick={() => handleRollback(version.id, version.version)}
                                        disabled={!!rollingBackId && !isRollingBack}
                                      >
                                        {isRollingBack ? 'Rolling back…' : 'Roll back'}
                                      </KitButton>
                                    ) : (
                                      <span className="text-[12px] text-zinc-600">Archived</span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </KitCard>
                  )}

                  <EnvVarsPanel projectId={projectId} />
                </>
              }
              side={
                <>
                  <KitCard className="overflow-hidden">
                    <KitCardHeader title="In production" />
                    <ul className="divide-y divide-white/[0.06]">
                      {[
                        { icon: Database, label: 'Database', active: tableCount > 0, sub: `${tableCount} ${tableCount === 1 ? 'table' : 'tables'}` },
                        { icon: Code2, label: 'REST API', active: endpointCount > 0, sub: `${endpointCount} endpoints` },
                        { icon: Shield, label: 'Authentication', active: hasAuth, sub: hasAuth ? 'JWT sessions' : 'Not configured' },
                        { icon: HardDrive, label: 'File storage', active: hasStorage, sub: hasStorage ? 'Buckets provisioned' : 'Not configured' },
                      ].map(({ icon: Icon, label, active, sub }) => (
                        <li key={label} className="flex items-center gap-3 px-4 py-2.5">
                          <Icon className={`h-4 w-4 flex-shrink-0 ${active ? 'text-zinc-400' : 'text-zinc-700'}`} strokeWidth={1.75} />
                          <div className="min-w-0 flex-1">
                            <p className={`text-[13px] ${active ? 'text-zinc-100' : 'text-zinc-500'}`}>{label}</p>
                            <p className="text-[12px] tabular-nums text-zinc-500">{sub}</p>
                          </div>
                          {active && <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400/80" strokeWidth={2} />}
                        </li>
                      ))}
                    </ul>
                  </KitCard>
                  {readinessPanel('Runtime readiness')}
                  <div className="hidden md:block">
                    <FrontendConnectionPill projectId={projectId} variant="badge" />
                  </div>
                </>
              }
            />
          </>
        )}

        {/* ── PRIVATE, nothing built ───────────────────────────── */}
        {status === 'PRIVATE' && !hasRealBackend && (
          <KitCard>
            <EmptyState
              icon={Layers}
              title="Nothing to publish yet"
              description="Describe your app to your coding agent. Once it has built tables, auth or storage, publishing gives the backend a stable, versioned endpoint."
              action={
                <div className="flex w-full flex-col items-center gap-3">
                  <AgentPrompt prompt="Build the backend for a task tracker: projects, tasks with a status and a due date, and email sign-in. Only a task's owner can edit it." />
                  <Link href={`/app/projects/${projectId}/connect`} className={`${BUTTON_BASE} ${BUTTON_SIZES.md} ${BUTTON_VARIANTS.primary}`}>
                    <Cable className="h-[15px] w-[15px]" strokeWidth={2} />
                    Connect your agent
                  </Link>
                </div>
              }
            />
          </KitCard>
        )}

        {/* ── PRIVATE, ready to publish ────────────────────────── */}
        {status === 'PRIVATE' && hasRealBackend && (
          <KitColumns
            main={
              <SettingsCard
                title="Ready to go live"
                description="Publishing snapshots the backend as version one and gives your app a stable endpoint. Later changes stay in development until you publish again."
                footer={
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
                    {tableCount > 0 && <span>{tableCount} {tableCount === 1 ? 'table' : 'tables'}</span>}
                    {endpointCount > 0 && <span>{endpointCount} endpoints</span>}
                    {hasAuth && <span>Auth</span>}
                    {hasStorage && <span>Storage</span>}
                  </span>
                }
                actions={publishButton('Publish backend')}
              />
            }
            side={readinessPanel('Before you publish')}
          />
        )}

        {/* ── DEPLOYING ─────────────────────────────────────────── */}
        {status === 'DEPLOYING' && (
          <KitCard className="px-5 py-5 sm:px-6">
            <h2 className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.012em] text-zinc-50">
              <Spinner className="h-4 w-4 text-zinc-300" />
              Publishing
            </h2>
            <p className="mt-1 text-[13px] text-zinc-400">Creating a stable production snapshot.</p>
            <ol className="mt-4 space-y-2.5">
              {['Snapshotting the backend', 'Provisioning the endpoint', 'Activating production'].map((step, i) => (
                <motion.li
                  key={step}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.3 }}
                  className="flex items-center gap-2.5"
                >
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-zinc-500" />
                  <span className="text-[13px] text-zinc-300">{step}</span>
                </motion.li>
              ))}
            </ol>
          </KitCard>
        )}

        {/* ── FAILED ────────────────────────────────────────────── */}
        {status === 'FAILED' && (
          <KitCard>
            <EmptyState
              icon={AlertCircle}
              title="The publish did not complete"
              description={project.deploymentError || 'Production is unchanged and the previous version is still serving. Try again, or ask your agent to look at the error.'}
              action={publishButton('Try again')}
            />
          </KitCard>
        )}

        {/* Edge case: marked live but nothing to serve */}
        {isLive && !hasRealBackend && (
          <KitCard>
            <EmptyState
              icon={AlertCircle}
              title="Live, but empty"
              description="This project is published, but there is nothing to serve yet. Connect your coding agent and build the backend first."
              action={
                <Link href={`/app/projects/${projectId}/connect`} className={`${BUTTON_BASE} ${BUTTON_SIZES.md} ${BUTTON_VARIANTS.secondary}`}>
                  <Cable className="h-[15px] w-[15px]" strokeWidth={2} />
                  Connect your agent
                </Link>
              }
            />
          </KitCard>
        )}

        <p className="flex items-center gap-2 pt-2 text-[12.5px] text-zinc-500">
          <Lock className="h-3.5 w-3.5 text-zinc-600" />
          Every change is planned, snapshotted and written to the audit log before it reaches production.
        </p>
      </div>
    </div>
  )
}
