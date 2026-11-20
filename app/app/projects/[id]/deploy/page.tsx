'use client'

/**
 * Deploy: production, its versions, and whether it is ready (rebuilt
 * 2026-11-16, project console v8).
 *
 * One column, three sections, in the order people come here for them:
 *
 *   Deploy  ● v5 published Nov 14                                 [Publish]
 *   Changes go live as they are made. Publishing records a version you can restore.
 *   Production   the endpoint (Copy, Open) and what it serves, counted for real
 *   Versions     the publish in flight or what stopped it, the drift note, each
 *                version with Restore to it (History's restore to a point)
 *   Readiness    one line when every check passes; otherwise each failing check
 *                is a row that links to the page where it is fixed
 *
 * The API serves changes as they are made; publishing only records a version
 * (app/docs/content.ts states the model, tests/unit/deploy-copy-truth.spec.ts
 * pins it). Function secrets live in Functions now (project decision 3): this
 * page links there instead of carrying the panel.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { RestoreToDialog, type RestorePoint } from '@/components/changes/RestoreToDialog'
import { useConnectionHealth } from '@/lib/hooks/useConnectionHealth'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { CopyField, KitButton, KitButtonLink, PageHeader, Skeleton, StatusGlyph } from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { Time } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { ErrorRow } from '@/components/console/states'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { publishFact } from '@/components/deploy/publish-fact'
import { checkName, fixPageFor, readinessSummary, stopsPublish } from '@/components/deploy/readiness-headline'

type ProjectStatus = 'PRIVATE' | 'DEPLOYING' | 'LIVE' | 'FAILED'

interface ProjectData {
  id: string
  name: string
  projectStatus: ProjectStatus
  publicUrl?: string | null
  /** Set only by an operator override. */
  apiUrlProd?: string | null
  /** The API address the server works out for the project's region. */
  apiBaseUrl?: string | null
  deployedAt?: string | null
  deploymentError?: string | null
}

interface PublishedVersion {
  id: string
  version: number
  graphSnapshotId: string | null
  changeSummary: string
  publishedAt: string
  /** Its snapshot is the live graph: nothing has changed since it was published. */
  isActive: boolean
  isCurrent: boolean
  canRollback: boolean
}

interface BackendState {
  entities: Array<{ name: string; fieldCount: number }>
  /** The tables a publish puts live, as the publish counts them. */
  liveTableCount?: number | null
  apis: Array<{ method: string; path: string }>
  /** Every method and path the API answers (5 per table, the auth routes, 1 per function). */
  endpointCount?: number
  capabilities: Array<{ name: string; enabled: boolean; icon: string }>
  hasContent: boolean
  isLive?: boolean
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

type Read<T> = { ok: true; body: T } | { ok: false }

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** The sentence under the title: the true model, in one line (tests/unit/deploy-copy-truth.spec.ts). */
const LEDE = 'Changes go live as they are made. Publishing records a version you can restore.'

export default function DeployPage() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const role = useProjectRole(projectId)
  const frontend = useConnectionHealth(projectId)

  const [project, setProject] = useState<ProjectData | null>(null)
  const [projectFailed, setProjectFailed] = useState(false)
  const [backend, setBackend] = useState<BackendState | null>(null)
  const [backendFailed, setBackendFailed] = useState(false)
  const [versions, setVersions] = useState<PublishedVersion[] | null>(null)
  const [versionsFailed, setVersionsFailed] = useState(false)
  const [versionsAt, setVersionsAt] = useState<number | null>(null)
  const [checks, setChecks] = useState<ReadinessCheck[] | null>(null)
  const [checksFailed, setChecksFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)

  const [publishing, setPublishing] = useState(false)
  /** What the last publish answered: a refusal in the server's words, or nothing new to record. */
  const [refusal, setRefusal] = useState<{ message: string; retry: boolean } | null>(null)
  const [unchanged, setUnchanged] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Restoring to a version is History's restore to a point (components/changes/RestoreToDialog.tsx).
  const [restoreTo, setRestoreTo] = useState<RestorePoint | null>(null)
  const [applyingFixes, setApplyingFixes] = useState(false)
  const [fixNote, setFixNote] = useState<{ text: string; failed: boolean } | null>(null)
  const [showChecks, setShowChecks] = useState(false)

  // The last good backend state, so a failed refresh still knows whether anything is built.
  const backendRef = useRef<BackendState | null>(null)

  const read = useCallback(
    async <T,>(path: string): Promise<Read<T>> => {
      try {
        const res = await fetch(`/api/projects/${projectId}${path}`, { credentials: 'include' })
        if (!res.ok) return { ok: false }
        return { ok: true, body: (await res.json()) as T }
      } catch {
        return { ok: false }
      }
    },
    [projectId],
  )

  const loadReadiness = useCallback(async () => {
    // GET: a read that changes nothing. Fixes are the explicit "Apply safe
    // fixes" click below; this once POSTed, which ran them on every page load.
    const r = await read<{ report?: { checks?: ReadinessCheck[] } }>('/readiness')
    if (r.ok && r.body.report) {
      setChecks(r.body.report.checks ?? [])
      setChecksFailed(false)
    } else {
      setChecksFailed(true)
    }
  }, [read])

  const fetchAll = useCallback(async () => {
    const [p, s, v] = await Promise.all([
      read<{ success?: boolean; data?: ProjectData }>(''),
      read<BackendState>('/state'),
      read<{ success?: boolean; versions?: PublishedVersion[] }>('/rollback'),
    ])
    if (p.ok && p.body.success && p.body.data) {
      setProject(p.body.data)
      setProjectFailed(false)
    } else {
      setProjectFailed(true)
    }
    if (s.ok && Array.isArray(s.body?.capabilities)) {
      backendRef.current = s.body
      setBackend(s.body)
      setBackendFailed(false)
    } else {
      setBackendFailed(true)
    }
    if (v.ok && v.body.success) {
      setVersions(v.body.versions ?? [])
      setVersionsFailed(false)
      setVersionsAt(Date.now())
    } else {
      setVersionsFailed(true)
    }
    setLoading(false)
    // Readiness runs the checks, so it loads on its own and fills in after the page.
    const known = backendRef.current
    if (known && (known.hasContent || known.capabilities.some((c) => c.name === 'Authentication'))) await loadReadiness()
    else if (known) {
      setChecks([])
      setChecksFailed(false)
    }
  }, [read, loadReadiness])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const status = project?.projectStatus
  useEffect(() => {
    if (status !== 'DEPLOYING') return
    // The project row only: fetchAll re-runs the readiness checks, far too
    // heavy for every 2 seconds. The whole page is read again once it settles.
    const interval = setInterval(async () => {
      const r = await read<{ success?: boolean; data?: ProjectData }>('')
      if (!r.ok || !r.body.success || !r.body.data) return
      setProject(r.body.data)
      if (r.body.data.projectStatus !== 'DEPLOYING') await fetchAll()
    }, 2000)
    return () => clearInterval(interval)
  }, [status, read, fetchAll])

  const retry = async () => {
    setRetrying(true)
    await fetchAll()
    setRetrying(false)
  }

  const publish = async () => {
    if (publishing) return
    setPublishing(true)
    setRefusal(null)
    setUnchanged(null)
    setAnnouncement('Publishing')
    try {
      const res = await fetch(`/api/projects/${projectId}/go-live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        // A refusal for readiness carries the fresh report: the rows below show
        // what stopped it at once. Trying again would only be refused again.
        if (data.readiness?.checks) setChecks(data.readiness.checks)
        const message = data.error || 'The publish did not complete. No version was recorded.'
        setRefusal({ message, retry: !data.readiness })
        setAnnouncement(message)
      } else if (data.noChanges) {
        setUnchanged(typeof data.version === 'number' ? data.version : null)
        setAnnouncement('Nothing changed, so no version was recorded.')
      } else {
        setAnnouncement(typeof data.version === 'number' ? `Published v${data.version}.` : 'Published.')
      }
    } catch {
      const message = 'Could not reach Backenly. No version was recorded.'
      setRefusal({ message, retry: true })
      setAnnouncement(message)
    } finally {
      await fetchAll()
      setPublishing(false)
    }
  }

  /**
   * Applying fixes is a deliberate act, never a side effect of looking: it can
   * turn on row-level security with an owner policy (rows other users could
   * read stop appearing to them), generate the project JWT secret, set the
   * auth flag, and switch off placeholder functions that have live triggers.
   */
  const applySafeFixes = async () => {
    setApplyingFixes(true)
    setFixNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/readiness`, { method: 'POST', credentials: 'include' })
      const r = await res.json().catch(() => ({}))
      if (res.ok && r.report) {
        setChecks(r.report.checks ?? [])
        const applied: ReadinessCheck[] = r.report.autoFixed ?? []
        setFixNote({ text: applied.length > 0 ? `Applied: ${applied.map((c) => checkName(c)).join(', ')}.` : 'Nothing needed fixing.', failed: false })
      } else {
        setFixNote({ text: r.error || 'The fixes could not be applied.', failed: true })
      }
    } catch {
      setFixNote({ text: 'Could not reach Backenly. Nothing was changed.', failed: true })
    } finally {
      setApplyingFixes(false)
    }
  }

  // ── What the page knows ──────────────────────────────────────────────────
  // The live endpoint. publicUrl comes back only from the publish call itself;
  // apiBaseUrl is the address the server works out for the project's region,
  // and an operator override still wins.
  const endpointUrl = project?.publicUrl || project?.apiUrlProd || project?.apiBaseUrl || null
  const hasAuth = backend?.capabilities.some((c) => c.name === 'Authentication') ?? false
  const hasStorage = backend?.capabilities.some((c) => c.name === 'File Storage') ?? false
  const hasRealBackend = (backend?.hasContent ?? false) || hasAuth
  const registeredTableCount = backend?.entities.length ?? 0
  const tableCount = backend?.liveTableCount ?? registeredTableCount
  const apiResourceCount = backend?.apis.length ?? 0
  // What the publish ENGINE accepts (lib/deployment/go-live.ts refuses when
  // tables, exposed APIs and auth are all absent). hasContent is wider:
  // functions, buckets or realtime alone flip it, and offering Publish on that
  // wider set led straight to a refusal.
  const publishable = registeredTableCount > 0 || apiResourceCount > 0 || hasAuth
  // Hidden, never disabled: the button appears once the role says it may.
  const canPublish = role.canWrite && publishable
  const deploying = publishing || status === 'DEPLOYING'
  const latest = versions?.[0] ?? null
  const nextVersion = (latest?.version ?? 0) + 1
  const drifted = !!versions && versions.length > 0 && !versions.some((v) => v.isActive)
  const hasPendingChanges = !versions || versions.length === 0 || drifted
  // A failed publish is a row in Versions with its own Try again, so the header button steps aside.
  const failedRow = !deploying && (refusal !== null || status === 'FAILED')
  const fact = publishFact({ projectStatus: deploying ? 'DEPLOYING' : status, latest })

  const ran = (checks ?? []).filter((c) => c.status !== 'skip')
  const summary = readinessSummary(ran)
  // Every failing check is a row, those a publish stops on first: none is ever cropped.
  const failingChecks = [...ran.filter((c) => stopsPublish(c)), ...ran.filter((c) => c.status === 'fail' && !stopsPublish(c))]
  const passingChecks = ran.filter((c) => c.status === 'pass')
  // What "Apply safe fixes" would change: failing checks the engine can fix.
  const fixableChecks = ran.filter((c) => c.status === 'fail' && c.severity === 'auto-fixable' && !c.fixApplied)

  // ── Header ───────────────────────────────────────────────────────────────
  const factTone = fact.tone === 'danger' || fact.tone === 'attention' ? 'font-medium text-zinc-50' : 'text-faint'
  const meta = project ? (
    <span className={`inline-flex items-center gap-[7px] text-[13px] leading-[20px] tabular-nums ${factTone}`}>
      <StatusGlyph state={fact.glyph} label={fact.version !== null ? '' : fact.label} />
      {fact.version !== null && fact.at ? (
        <span>
          v{fact.version} published <Time iso={fact.at} mode="date" />
        </span>
      ) : (
        <span>{fact.text}</span>
      )}
    </span>
  ) : loading ? (
    <Skeleton className="h-[12px] w-[132px]" />
  ) : null

  const actions =
    canPublish && !failedRow ? (
      <KitButton
        variant="primary"
        size="lg"
        onClick={() => void publish()}
        loading={deploying}
        disabled={!hasPendingChanges && !deploying}
        title={!hasPendingChanges ? 'All changes published. Working state matches production.' : undefined}
      >
        {deploying ? 'Publishing…' : 'Publish'}
      </KitButton>
    ) : !role.loading && !role.error && !role.canWrite && publishable ? (
      <p className="text-[12.5px] leading-[18px] text-faint sm:pt-[9px]">Only developers and admins can publish.</p>
    ) : undefined

  if (loading) {
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader flush title="Deploy" meta={meta} description={LEDE} />
        <div className="space-y-[32px]" aria-busy="true" aria-label="Loading">
          {['Production', 'Versions'].map((title) => (
            <Section key={title} id={`deploy-${title.toLowerCase()}-loading`} title={title}>
              <Panel>
                <RowSkeleton rows={title === 'Production' ? 1 : 3} lead="none" />
              </Panel>
            </Section>
          ))}
        </div>
      </div>
    )
  }

  // ── Production ───────────────────────────────────────────────────────────
  const frontendFact: ReactNode =
    frontend.status === 'connected' ? (
      `Called from ${frontend.primaryOrigin ?? 'your app'}`
    ) : frontend.status === 'degraded' ? (
      <span className="font-medium text-zinc-50">Called from {frontend.primaryOrigin ?? 'your app'}, with errors</span>
    ) : frontend.status === 'failing' ? (
      <span className="font-medium text-zinc-50">Calls from your app are failing</span>
    ) : frontend.status === 'idle' ? (
      'No frontend calls yet'
    ) : null

  const production = (
    <Section id="deploy-production" title="Production">
      <Panel>
        {projectFailed && !project ? (
          <ErrorRow things="this project" onRetry={() => void retry()} retrying={retrying} />
        ) : (
          <div className="px-[16px] py-[14px] sm:px-[20px]">
            {endpointUrl && (
              <div className="flex items-center gap-[8px]">
                <CopyField value={endpointUrl} label="Copy the endpoint URL" className="min-w-0 flex-1" />
                {hasRealBackend && (
                  <KitButtonLink href={endpointUrl} external className="!h-[34px]">
                    Open
                  </KitButtonLink>
                )}
              </div>
            )}
            {backendFailed && !backend ? (
              <p className="mt-[10px] text-[13px] leading-[20px] text-zinc-400">
                Could not load what this backend serves.{' '}
                <button type="button" onClick={() => void retry()} className={`rounded-[4px] font-medium text-zinc-200 underline decoration-white/25 underline-offset-[3px] hover:text-white ${FOCUS}`}>
                  Try again
                </button>
              </p>
            ) : !hasRealBackend ? (
              <p className={`${ROW_TEXT} ${endpointUrl ? 'mt-[10px]' : ''}`}>Nothing is built yet, so there is nothing to publish.</p>
            ) : (
              <>
                <Facts className="mt-[10px]">
                  {tableCount > 0 && <Fact>{plural(tableCount, 'table')}</Fact>}
                  {typeof backend?.endpointCount === 'number' && backend.endpointCount > 0 && (
                    <Fact>
                      <span title={`${backend.endpointCount} endpoints: ${tableCount * 5} table CRUD, ${Math.max(0, backend.endpointCount - (tableCount * 5))} custom/functions/auth`}>
                        {plural(backend.endpointCount, 'endpoint')}
                        <span className="ml-1 font-normal text-zinc-500">
                          ({tableCount > 0 ? `${tableCount * 5} CRUD · ` : ''}{Math.max(0, backend.endpointCount - (tableCount * 5))} custom/func)
                        </span>
                      </span>
                    </Fact>
                  )}
                  {hasAuth && <Fact>Auth on</Fact>}
                  {hasStorage && <Fact>Storage on</Fact>}
                  {frontendFact && <Fact>{frontendFact}</Fact>}
                </Facts>
                {!publishable && (
                  <p className={ROW_TEXT}>Publishing records the schema, so it needs a table, an API or auth first.</p>
                )}
              </>
            )}
          </div>
        )}
      </Panel>
    </Section>
  )

  // ── Versions ─────────────────────────────────────────────────────────────
  const versionRows: ReactNode[] = []
  if (deploying) {
    versionRows.push(
      <VersionLine key="publishing" version={nextVersion}>
        <span className="inline-flex items-center gap-[8px] text-zinc-200">
          <StatusGlyph state="busy" label="" className="motion-safe:animate-pulse" />
          Publishing…
        </span>
      </VersionLine>,
    )
  } else if (refusal) {
    versionRows.push(
      <Row
        key="refused"
        lead="glyph"
        glyph="failed"
        glyphLabel="Not published"
        title={<p className="text-[13px] leading-[20px] text-rose-300 [overflow-wrap:anywhere]">{refusal.message}</p>}
        actions={
          refusal.retry && role.canWrite ? (
            <KitButton size="sm" onClick={() => void publish()}>
              Try again
            </KitButton>
          ) : undefined
        }
      />,
    )
  } else if (status === 'FAILED') {
    versionRows.push(
      <Row
        key="failed"
        lead="glyph"
        glyph="failed"
        glyphLabel="Publish failed"
        title={<p className={ROW_TITLE}>The last publish failed. No version was recorded.</p>}
        actions={
          role.canWrite ? (
            <KitButton size="sm" onClick={() => void publish()}>
              Try again
            </KitButton>
          ) : undefined
        }
      >
        {project?.deploymentError && <p className="mt-1 text-[13px] leading-[20px] text-rose-300 [overflow-wrap:anywhere]">{project.deploymentError}</p>}
      </Row>,
    )
  } else if (unchanged !== null) {
    versionRows.push(
      <Row
        key="unchanged"
        lead="glyph"
        glyph="done"
        glyphLabel="Up to date"
        title={
          <p role="status" className="text-[13px] leading-[20px] text-zinc-300">
            Nothing changed since v{unchanged}, so no version was recorded.
          </p>
        }
      />,
    )
  }
  if (drifted && !deploying && latest) {
    versionRows.push(
      <Row
        key="drift"
        lead="none"
        title={
          <p className="text-[13px] leading-[20px] text-zinc-200">
            Changed since v{latest.version}. Publish to record v{nextVersion}.
          </p>
        }
        actions={
          <KitButtonLink href={`/app/projects/${projectId}/changes`} size="sm">
            See changes
          </KitButtonLink>
        }
      />,
    )
  }
  for (const v of versions ?? []) {
    versionRows.push(
      <VersionLine
        key={v.id}
        version={v.version}
        current={v.isActive}
        at={v.publishedAt}
        action={
          v.isActive ? (
            <StatusGlyph state="live" label="Current" showLabel />
          ) : role.canAdminister ? (
            // The backend as it was when this was published: every change since undone, each checked.
            <KitButton
              size="sm"
              onClick={() =>
                setRestoreTo({
                  version: v.version,
                  label: `v${v.version}`,
                  detail: `${v.changeSummary}, published ${formatTime(v.publishedAt, 'dateTime')}.`,
                })
              }
            >
              Restore to v{v.version}
            </KitButton>
          ) : null
        }
      >
        {v.changeSummary}
      </VersionLine>,
    )
  }

  const versionsSection = (
    <Section id="deploy-versions" title="Versions" count={versions?.length ?? null}>
      <Panel>
        {versionsFailed && versions === null ? (
          <ErrorRow things="versions" onRetry={() => void retry()} retrying={retrying} />
        ) : (
          <>
            {versionsFailed && versionsAt && <ErrorRow things="versions" staleAt={versionsAt} onRetry={() => void retry()} retrying={retrying} />}
            {versionRows.length > 0 ? (
              <RowList>{versionRows}</RowList>
            ) : (
              <EmptyLine>No versions yet. Your first publish records v1.</EmptyLine>
            )}
            {versionRows.length > 0 && (versions?.length ?? 0) === 0 && !deploying && (
              <p className="border-t border-white/[0.06] px-[20px] py-[12px] text-[13px] leading-[20px] text-zinc-400">
                No versions yet. Your first publish records v1.
              </p>
            )}
          </>
        )}
      </Panel>
    </Section>
  )

  // ── Readiness ────────────────────────────────────────────────────────────
  const checkRow = (c: ReadinessCheck) => {
    const stops = stopsPublish(c)
    const page = fixPageFor(c.id)
    // What failed, in the checker's own lines ("✗ RLS isolation: …"), when it says more than the message.
    const failedLines = c.details.filter((d) => d.trim().startsWith('✗')).map((d) => d.trim().replace(/^✗\s*/, '')).slice(0, 6)
    return (
      <Row
        key={c.id}
        lead="glyph"
        glyph={stops ? 'failed' : 'waiting'}
        glyphLabel={stops ? 'Stops a publish' : 'Needs a look'}
        title={<p className={ROW_TITLE}>{checkName(c)}</p>}
        actions={
          page ? (
            <KitButtonLink href={`/app/projects/${projectId}/${page.path}`} size="sm">
              Open {page.label}
            </KitButtonLink>
          ) : undefined
        }
      >
        <p className={ROW_TEXT}>{c.message}</p>
        {failedLines.length > 0 && (
          <ul className="mt-[6px] space-y-[2px] text-[12.5px] leading-[18px] text-zinc-400">
            {failedLines.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        )}
        {stops && (
          <Facts>
            <Fact>Stops a publish</Fact>
          </Facts>
        )}
      </Row>
    )
  }

  const checksToggle = (
    <button
      type="button"
      onClick={() => setShowChecks((s) => !s)}
      aria-expanded={showChecks}
      aria-controls="deploy-passing-checks"
      className={`inline-flex h-[28px] flex-shrink-0 items-center gap-1 rounded-[6px] px-[6px] text-[12.5px] font-medium text-zinc-400 transition-colors hover:text-zinc-100 ${FOCUS}`}
    >
      {showChecks ? 'Hide checks' : 'Show checks'}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${showChecks ? 'rotate-180' : ''}`} strokeWidth={1.75} />
    </button>
  )

  const readinessSection = hasRealBackend && (
    <Section id="deploy-readiness" title="Readiness">
      <Panel>
        {checks === null && !checksFailed ? (
          <RowSkeleton rows={1} lead="none" />
        ) : checksFailed && (checks === null || checks.length === 0) ? (
          <ErrorRow things="the readiness checks" stillWorks="Publishing still runs them." onRetry={() => void loadReadiness()} />
        ) : ran.length === 0 ? (
          <EmptyLine>No checks have run yet. Publishing runs them.</EmptyLine>
        ) : (
          <RowList>
            {failingChecks.map(checkRow)}
            {role.canWrite && (fixableChecks.length > 0 || fixNote) && (
              <li className="flex flex-wrap items-center gap-x-[24px] gap-y-[10px] px-[20px] py-[14px] sm:flex-nowrap">
                <p
                  role={fixNote ? 'status' : undefined}
                  className={`min-w-0 flex-1 text-[13px] leading-[20px] [overflow-wrap:anywhere] ${fixNote?.failed ? 'text-rose-300' : 'text-zinc-400'}`}
                >
                  {fixNote
                    ? fixNote.text
                    : `Backenly can fix ${fixableChecks.length === 1 ? 'one of these' : `${fixableChecks.length} of these`}: ${fixableChecks.map((c) => checkName(c)).join(', ')}.` +
                      // Said only when it is one of the fixes: it changes what each table shows.
                      (fixableChecks.some((c) => c.id === 'rls_applied')
                        ? ' This turns on row-level security for the tables it can find an owner for, so check what each table should show first.'
                        : '')}
                </p>
                {fixableChecks.length > 0 && (
                  <KitButton onClick={() => void applySafeFixes()} loading={applyingFixes}>
                    {applyingFixes ? 'Applying…' : 'Apply safe fixes'}
                  </KitButton>
                )}
              </li>
            )}
            {summary.allPass ? (
              <li className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[6px] px-[20px] py-[12px]">
                <p className="text-[13px] leading-[20px] text-zinc-200">{summary.line}</p>
                {checksToggle}
              </li>
            ) : (
              passingChecks.length > 0 && (
                <li className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[6px] px-[20px] py-[12px]">
                  <p className="text-[13px] leading-[20px] text-zinc-400">{summary.othersLine}</p>
                  {checksToggle}
                </li>
              )
            )}
            {showChecks && (
              <li id="deploy-passing-checks" className="px-0 py-0">
                <ul aria-label="Passing checks" className="divide-y divide-white/[0.06]">
                  {passingChecks.map((c) => (
                    <li key={c.id} className="flex items-start gap-[12px] px-[20px] py-[10px]">
                      <StatusGlyph state="done" label="Passes" className="mt-[4px]" />
                      <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-[16px]">
                        <p className="text-[13px] leading-[20px] text-zinc-200 sm:w-[260px] sm:flex-shrink-0">{checkName(c)}</p>
                        <p className="text-[12.5px] leading-[18px] text-faint [overflow-wrap:anywhere]">{c.message}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </RowList>
        )}
      </Panel>
    </Section>
  )

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader flush title="Deploy" meta={meta} description={LEDE} actions={actions} />

      <div className="space-y-[32px]">
        {production}
        {versionsSection}
        {readinessSection}

        {/* Function secrets live in Functions (project decision 3). */}
        <p className="text-[12.5px] leading-[18px] text-faint">
          Functions read secrets as <code className="font-mono text-[12px] text-zinc-300">ctx.env.NAME</code>.{' '}
          <Link
            href={`/app/projects/${projectId}/functions?view=secrets`}
            className={`rounded-[3px] font-medium text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors hover:text-white hover:decoration-white/60 ${FOCUS}`}
          >
            Manage secrets in Functions
          </Link>
        </p>
      </div>

      {restoreTo && (
        <RestoreToDialog
          projectId={projectId}
          point={restoreTo}
          onClose={() => setRestoreTo(null)}
          onDone={() => void fetchAll()}
          // The step that stopped it opens where every change is: History.
          onOpenChange={(id) => router.push(`/app/projects/${projectId}/changes?change=${encodeURIComponent(id)}`)}
        />
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

/**
 * One version: its number, what changed, when, and Current or Restore. On a
 * phone the time and the action drop to a second line, so Restore stays in view.
 */
function VersionLine({
  version,
  current = false,
  at,
  action,
  children,
}: {
  version: number
  current?: boolean
  at?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-[16px] gap-y-[6px] px-[16px] py-[12px] sm:flex-nowrap sm:px-[20px]">
      <span className={`w-[36px] flex-shrink-0 text-[13px] font-medium leading-[20px] tabular-nums ${current ? 'text-white' : 'text-zinc-300'}`}>
        v{version}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">{children}</span>
      {(at || action) && (
        <span className="flex basis-full items-center justify-between gap-[12px] pl-[52px] sm:contents">
          <span className="text-[12.5px] leading-[18px] text-faint sm:w-[150px] sm:flex-shrink-0 sm:text-right">
            {at && <Time iso={at} mode="dateTime" className="whitespace-nowrap" />}
          </span>
          <span className="flex min-h-[28px] items-center justify-end sm:w-[132px] sm:flex-shrink-0">{action}</span>
        </span>
      )}
    </li>
  )
}
