'use client'

/**
 * Bringing a backend in (/app/org/[orgId]/import, Backenly Cloud): Connect,
 * Review, Move, Done, in the organization's shell. The founder-approved flow
 * of 2026-11-16 (Supabase, Firebase and any Postgres); wire types in
 * lib/import/contract.ts, calls in lib/import/client.ts.
 *
 *   ?source=supabase|firebase|postgres   where to start (Connect)
 *   ?job=<id>                            an import already running or done
 *
 * Connect asks for what the source needs, masked and never echoed; Continue
 * reads the source (inspect) and Review lays out what will move beside the
 * new project's name and region. Move to Backenly creates the project and
 * starts the job (POST /api/import); from then on the URL is ?job=, so a
 * reload, or the Projects list's "Importing" row, comes back to the ledger,
 * which follows the job every second. The credentials are dropped from this
 * page the moment the job starts: the server holds them for the job's life.
 *
 * Owners and admins import (the API answers no one else); anyone else reads
 * one sentence saying so.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Building2 } from 'lucide-react'
import type { ImportPreview, ImportProgress, ImportSourceId } from '@/lib/import/contract'
import {
  cancelImport,
  importPath,
  inspectImport,
  isImportSource,
  isRunning,
  readImport,
  startImport,
} from '@/lib/import/client'
import { DeleteRefusedError, deleteProject, type Reauthentication } from '@/lib/api/projects'
import { SignInAgain } from '@/components/console/SignInAgain'
import { FREE_INCLUDED, PRO_PRICE } from '@/lib/pricing/plan-rows'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  Breadcrumbs,
  KitButton,
  KitButtonLink,
  KitConfirmDialog,
  KitNote,
  PageHeader,
  Skeleton,
} from '@/components/inspector/kit'
import { EDGE, PAGE_GUTTER, PAGE_WIDTH, PLATE, R_PANEL } from '@/components/console/tokens'
import { Row, RowList, ROW_TEXT, ROW_TITLE } from '@/components/autonomy/rows'
import { SOURCES } from '@/components/migrate/sources'
import { useRegionsAsServed } from '@/components/projects/NewProjectDialog'
import {
  ConnectStep,
  EMPTY_CONNECT,
  checkConnect,
  connectionOf,
  isConnectField,
  type ConnectErrors,
  type ConnectValues,
} from './ConnectStep'
import { MoveStep } from './MoveStep'
import { ReviewStep, type ReviewErrors } from './ReviewStep'
import { Trail, type TrailStep } from './parts'

export interface ImportFlowOrg {
  id: string
  name: string
  role: string
}

type Step = 'connect' | 'review' | 'move'

const POLL_MS = 1000

/** Pro's monthly price, from the plan facts Billing compares (lib/pricing/plan-rows.ts). */
const PRO_MONTHLY = '$' + (PRO_PRICE.monthlyCents / 100).toLocaleString('en-US')

/** The source's own name for the project, as a starting name: trimmed, and short enough to keep. */
function suggestedName(label: string): string {
  return label.trim().slice(0, 100)
}

/** The clock for the ledger's elapsed time: every second while a job runs. */
function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  return now
}

export function ImportFlow({
  orgId,
  org,
  orgStatus,
  onRetryOrg,
}: {
  orgId: string
  /** The organization and the caller's role in it, once known. */
  org: ImportFlowOrg | null
  orgStatus: 'ready' | 'loading' | 'missing' | 'failed'
  onRetryOrg?: () => void
}) {
  const router = useRouter()
  const search = useSearchParams()
  const jobParam = search.get('job')
  const sourceParam = search.get('source') ?? search.get('from')
  const projectsHref = `/app/org/${encodeURIComponent(orgId)}`
  const billingHref = `${projectsHref}/billing`
  const loginHref = `/auth/login?redirect=${encodeURIComponent(
    jobParam ? importPath(orgId, { job: jobParam }) : importPath(orgId, isImportSource(sourceParam) ? { source: sourceParam } : {}),
  )}`

  // ── Connect ────────────────────────────────────────────────────────────────
  const [source, setSource] = useState<ImportSourceId>(isImportSource(sourceParam) ? sourceParam : 'supabase')
  const [step, setStep] = useState<Step>(jobParam ? 'move' : 'connect')
  const [values, setValues] = useState<ConnectValues>(EMPTY_CONNECT)
  const [connectErrors, setConnectErrors] = useState<ConnectErrors>({})
  const [connectError, setConnectError] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)

  // ── Review ─────────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const regions = useRegionsAsServed()
  const [name, setName] = useState('')
  const [chosenRegion, setRegion] = useState<CloudRegionId>(HOME_REGION)
  // The chosen region while it is open to this person, else the first that is.
  const openRegions = regions.filter((r) => r.open)
  const region: CloudRegionId = openRegions.some((r) => r.id === chosenRegion)
    ? chosenRegion
    : openRegions[0]?.id ?? chosenRegion
  const [include, setInclude] = useState({ users: true, files: true })
  const [reviewErrors, setReviewErrors] = useState<ReviewErrors>({})
  const [starting, setStarting] = useState(false)

  // ── Move and Done ──────────────────────────────────────────────────────────
  const [jobId, setJobId] = useState<string | null>(jobParam)
  const [job, setJob] = useState<ImportProgress | null>(null)
  const [jobProblem, setJobProblem] = useState<{ status: number; error: string } | null>(null)
  const [staleSince, setStaleSince] = useState<number | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [project, setProject] = useState<{ name: string | null; region: string | null }>({ name: null, region: null })
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Set when the server asks for a sign-in from the last ten minutes first.
  const [deleteReauth, setDeleteReauth] = useState<Reauthentication | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const lastGood = useRef<number | null>(null)

  const admin = org ? org.role === 'OWNER' || org.role === 'ADMIN' : false
  const ready = orgStatus === 'ready' && !!org && admin
  const now = useTicker(!!job && isRunning(job))

  // An import creates a project, so a plan with no room is said before
  // anything is pasted (GET /api/projects/can-create), not after Review.
  const [full, setFull] = useState<{ error?: string; currentPlan?: string } | null>(null)
  useEffect(() => {
    if (!ready || jobParam) return
    let cancelled = false
    fetch(`/api/projects/can-create?orgId=${encodeURIComponent(orgId)}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((answer: { allowed?: boolean; code?: string; error?: string; currentPlan?: string } | null) => {
        if (cancelled || !answer || answer.allowed !== false) return
        if (!answer.code || answer.code === 'PLAN_LIMIT_EXCEEDED') setFull({ error: answer.error, currentPlan: answer.currentPlan })
      })
      .catch(() => {
        /* unknown: the start says so if it comes to that */
      })
    return () => {
      cancelled = true
    }
  }, [ready, jobParam, orgId])

  // The job, every second while it runs. A failed read keeps what was shown
  // and says so; the job keeps running on the server either way.
  useEffect(() => {
    if (!ready || !jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let misses = 0

    function schedule(ms: number) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') read()
        else schedule(ms)
      }, ms)
    }

    async function read() {
      if (!jobId) return
      const result = await readImport(jobId)
      if (cancelled) return
      if (result.ok) {
        misses = 0
        lastGood.current = Date.now()
        setJob(result.data)
        setJobProblem(null)
        setStaleSince(null)
        if (isRunning(result.data)) schedule(POLL_MS)
        return
      }
      const { status, error } = result.refusal
      if (status === 401) {
        router.push(loginHref)
        return
      }
      if (status === 403 || status === 404) {
        setJobProblem({ status, error: status === 404 ? 'This import was not found. It may have ended more than a day ago.' : error })
        return
      }
      misses += 1
      if (lastGood.current) setStaleSince(lastGood.current)
      else setJobProblem({ status, error })
      schedule(Math.min(10_000, POLL_MS * 2 ** misses))
    }

    read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ready, jobId, readAttempt, router, loginHref])

  // The project's name and region, when the page opened on a job.
  const jobProjectId = job?.projectId ?? null
  useEffect(() => {
    if (!jobProjectId || project.name) return
    let cancelled = false
    fetch(`/api/projects/${encodeURIComponent(jobProjectId)}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { data?: { name?: string; region?: string | null } } | null) => {
        if (!cancelled && body?.data?.name) setProject({ name: body.data.name, region: body.data.region ?? null })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [jobProjectId, project.name])

  // ── Actions ────────────────────────────────────────────────────────────────

  const changeSource = (next: ImportSourceId) => {
    setSource(next)
    setConnectErrors({})
    setConnectError(null)
    router.replace(importPath(orgId, { source: next }), { scroll: false })
  }

  const inspect = async () => {
    const found = checkConnect(source, values)
    if (Object.keys(found).length > 0) {
      setConnectErrors(found)
      setConnectError(null)
      return
    }
    setInspecting(true)
    setConnectErrors({})
    setConnectError(null)
    const result = await inspectImport({ orgId, connection: connectionOf(source, values) })
    setInspecting(false)
    if (result.ok) {
      const p = result.data
      setPreview(p)
      setName((current) => current.trim() || suggestedName(p.sourceLabel))
      setInclude({ users: !!p.users, files: !!p.buckets?.length })
      setReviewErrors({})
      setStep('review')
      window.scrollTo({ top: 0 })
      return
    }
    const r = result.refusal
    if (r.status === 401) {
      router.push(loginHref)
      return
    }
    if (isConnectField(r.field)) setConnectErrors({ [r.field]: r.error })
    else setConnectError(r.error)
  }

  const start = async () => {
    if (!preview || preview.refusal || starting) return
    const trimmed = name.trim()
    if (!trimmed) {
      setReviewErrors({ name: 'Name the new project.' })
      return
    }
    setStarting(true)
    setReviewErrors({})
    const result = await startImport({
      orgId,
      connection: connectionOf(source, values),
      name: trimmed,
      region,
      include: { users: include.users && !!preview.users, files: include.files && !!preview.buckets?.length },
    })
    setStarting(false)
    if (result.ok) {
      // The server holds the credentials for the job's life; this page lets them go.
      setValues(EMPTY_CONNECT)
      setProject({ name: trimmed, region })
      setJob(null)
      setJobProblem(null)
      setStaleSince(null)
      lastGood.current = null
      setJobId(result.data.jobId)
      setStep('move')
      router.replace(importPath(orgId, { job: result.data.jobId }), { scroll: false })
      window.scrollTo({ top: 0 })
      return
    }
    const r = result.refusal
    if (r.status === 401) {
      router.push(loginHref)
      return
    }
    if (r.code === 'PLAN_LIMIT_EXCEEDED') {
      setReviewErrors({
        form: (
          <>
            {r.error}{' '}
            <Link href={billingHref} className="whitespace-nowrap font-medium text-zinc-100 underline underline-offset-[3px]">
              Upgrade to Pro
            </Link>
          </>
        ),
      })
      return
    }
    if (r.field === 'name' || r.field === 'region') {
      setReviewErrors({ [r.field]: r.error })
      return
    }
    // The source refused at the start (a password changed since Review): back to where it is fixed.
    if (isConnectField(r.field)) {
      setConnectErrors({ [r.field]: r.error })
      setStep('connect')
      return
    }
    setReviewErrors({ form: r.error })
  }

  const stop = async () => {
    if (!jobId) return
    setStopping(true)
    setStopError(null)
    const result = await cancelImport(jobId)
    setStopping(false)
    if (result.ok) {
      setJob(result.data)
      setConfirmStop(false)
    } else {
      setStopError(result.refusal.error)
    }
  }

  const removeProject = async () => {
    if (!job) return
    if (!project.name) {
      // The server deletes only with the project's name, read when the page opened.
      setDeleteError('The project’s name has not loaded yet. Try again in a moment.')
      return
    }
    setDeleting(true)
    setDeleteError(null)
    setDeleteReauth(null)
    try {
      // The name the person typed; the dialog does not confirm until it matches.
      await deleteProject(job.projectId, project.name)
      router.push(projectsHref)
    } catch (err) {
      if (err instanceof DeleteRefusedError && err.code === 'REAUTH_REQUIRED' && err.reauth) setDeleteReauth(err.reauth)
      else setDeleteError('The project could not be deleted. Try again.')
      setDeleting(false)
    }
  }

  const startAgain = useCallback(() => {
    const again = job?.source ?? source
    setSource(again)
    setValues(EMPTY_CONNECT)
    setConnectErrors({})
    setConnectError(null)
    setPreview(null)
    setName('')
    setJobId(null)
    setJob(null)
    setJobProblem(null)
    setStaleSince(null)
    lastGood.current = null
    setProject({ name: null, region: null })
    setStep('connect')
    router.replace(importPath(orgId, { source: again }), { scroll: false })
    window.scrollTo({ top: 0 })
  }, [job, source, orgId, router])

  // ── Page ───────────────────────────────────────────────────────────────────

  const shownSource = job?.source ?? source
  const from = SOURCES[shownSource].name
  const trail: TrailStep = step === 'move' ? (job?.status === 'done' ? 'done' : 'move') : step
  const header = (description?: ReactNode, withTrail = true) => (
    <PageHeader
      flush
      breadcrumb={<Breadcrumbs items={[{ label: 'Projects', href: projectsHref }, { label: 'Import' }]} />}
      title={`Import from ${from}`}
      description={description}
      tabs={withTrail ? <Trail current={trail} /> : undefined}
    />
  )

  let body: ReactNode
  if (orgStatus === 'loading' && !org) {
    body = (
      <>
        <div className="space-y-3 pb-[24px] pt-[36px]" aria-hidden>
          <Skeleton className="h-[14px] w-[120px]" />
          <Skeleton className="h-[30px] w-[280px]" />
        </div>
        <div className={`${PLATE} border ${EDGE} ${R_PANEL} space-y-4 p-5`} aria-hidden>
          <Skeleton className="h-[34px] w-[300px]" />
          <Skeleton className="h-[32px] w-full" />
          <Skeleton className="h-[32px] w-2/3" />
        </div>
      </>
    )
  } else if (orgStatus === 'missing' || orgStatus === 'failed' || !org) {
    body = (
      <>
        {header(undefined, false)}
        <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
          <RowList>
            {orgStatus === 'failed' ? (
              <Row
                icon={AlertTriangle}
                tone="danger"
                title={<p className={ROW_TITLE}>Could not load this organization. Try again.</p>}
                actions={onRetryOrg ? <KitButton onClick={onRetryOrg}>Retry</KitButton> : undefined}
              />
            ) : (
              <Row
                icon={Building2}
                title={<p className={ROW_TITLE}>Organization not found</p>}
                actions={<KitButtonLink href="/app/organizations">All organizations</KitButtonLink>}
              >
                <p className={ROW_TEXT}>It does not exist, or you are not a member of it.</p>
              </Row>
            )}
          </RowList>
        </div>
      </>
    )
  } else if (!admin) {
    body = (
      <>
        {header(undefined, false)}
        <p className="text-[13px] leading-[20px] text-zinc-400">
          Only owners and admins can import into {org.name}.{' '}
          <Link href={projectsHref} className="font-medium text-zinc-100 underline underline-offset-[3px]">
            Back to projects
          </Link>
        </p>
      </>
    )
  } else if (full && step === 'connect') {
    const onFree = !full.currentPlan || full.currentPlan === 'SANDBOX' || full.currentPlan === 'FREE'
    body = (
      <>
        {header(undefined, false)}
        <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
          <div className="flex flex-col gap-x-6 gap-y-3 px-5 py-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <p className={ROW_TITLE}>
                {onFree
                  ? `Free includes ${FREE_INCLUDED.projects} project${FREE_INCLUDED.projects === 1 ? '' : 's'}`
                  : 'Project limit reached'}
              </p>
              <p className={ROW_TEXT}>
                {onFree
                  ? `An import moves into a new project. Pro has no project limit, for ${PRO_MONTHLY} a month.`
                  : full.error ?? 'This plan has no room for another project.'}
              </p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-[8px]">
              <KitButtonLink href={projectsHref} variant="ghost">
                Back to projects
              </KitButtonLink>
              {onFree ? (
                <KitButtonLink href={billingHref} variant="primary">
                  Upgrade to Pro
                </KitButtonLink>
              ) : (
                <KitButtonLink href={billingHref}>Billing</KitButtonLink>
              )}
            </div>
          </div>
        </div>
      </>
    )
  } else if (step === 'connect') {
    body = (
      <>
        {header('What you paste here is used for this import and never stored.')}
        <ConnectStep
          source={source}
          onSource={changeSource}
          values={values}
          onChange={(patch) => {
            setValues((v) => ({ ...v, ...patch }))
            // Editing a field answers its error: it goes until the next Continue says otherwise.
            setConnectErrors((e) => {
              const edited = Object.keys(patch).filter((k) => k in e)
              if (edited.length === 0) return e
              const next = { ...e }
              for (const k of edited) delete next[k as keyof ConnectErrors]
              return next
            })
          }}
          errors={connectErrors}
          onFieldError={(field, message) =>
            setConnectErrors((e) => {
              const next = { ...e }
              if (message) next[field] = message
              else delete next[field]
              return next
            })
          }
          formError={connectError}
          busy={inspecting}
          onSubmit={inspect}
          cancelHref={projectsHref}
        />
      </>
    )
  } else if (step === 'review' && preview) {
    body = (
      <>
        {header()}
        <ReviewStep
          preview={preview}
          orgName={org.name}
          name={name}
          onName={setName}
          region={region}
          onRegion={setRegion}
          regions={regions}
          include={include}
          onInclude={setInclude}
          errors={reviewErrors}
          busy={starting}
          onBack={() => {
            setStep('connect')
            window.scrollTo({ top: 0 })
          }}
          onStart={start}
        />
      </>
    )
  } else if (job) {
    body = (
      <>
        {header(isRunning(job) ? 'You can leave this page. The import keeps going.' : undefined)}
        <MoveStep
          job={job}
          planned={preview?.tables ?? null}
          projectName={project.name ?? job.projectName ?? null}
          region={project.region ?? job.region ?? null}
          now={now}
          staleSince={staleSince}
          onStop={() => {
            setStopError(null)
            setConfirmStop(true)
          }}
          onStartAgain={startAgain}
          onDelete={() => {
            setDeleteError(null)
            setDeleteReauth(null)
            setConfirmDelete(true)
          }}
        />
      </>
    )
  } else if (jobProblem) {
    body = (
      <>
        {header(undefined, false)}
        <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
          <RowList>
            <Row
              icon={AlertTriangle}
              tone="danger"
              title={<p className={ROW_TITLE}>Could not load this import.</p>}
              actions={
                jobProblem.status === 404 || jobProblem.status === 403 ? (
                  <KitButtonLink href={projectsHref}>Projects</KitButtonLink>
                ) : (
                  <KitButton
                    onClick={() => {
                      setJobProblem(null)
                      setReadAttempt((n) => n + 1)
                    }}
                  >
                    Try again
                  </KitButton>
                )
              }
            >
              <p className={ROW_TEXT}>
                {jobProblem.error}
                {jobProblem.status !== 404 && jobProblem.status !== 403 ? ' The import keeps running.' : ''}
              </p>
            </Row>
          </RowList>
        </div>
      </>
    )
  } else {
    // The job was just started, or the page opened on one: its first answer is on its way.
    body = (
      <>
        {header()}
        <div className={`${PLATE} border ${EDGE} ${R_PANEL}`} aria-busy="true" aria-label="Loading the import">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-[14px]">
            <div className="space-y-2">
              <Skeleton className="h-[14px] w-[140px]" />
              <Skeleton className="h-[11px] w-[220px]" />
            </div>
            <Skeleton className="h-[12px] w-[96px]" />
          </div>
          <div className="space-y-[18px] px-5 py-[16px]">
            {['w-[180px]', 'w-[140px]', 'w-[200px]', 'w-[120px]'].map((w) => (
              <div key={w} className="flex items-center gap-4">
                <Skeleton className={`h-[12px] ${w}`} />
                <Skeleton className="h-[2px] flex-1" />
                <Skeleton className="h-[12px] w-[56px]" />
              </div>
            ))}
          </div>
        </div>
      </>
    )
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>{body}</div>

      <KitConfirmDialog
        open={confirmStop}
        onCancel={() => {
          if (!stopping) setConfirmStop(false)
        }}
        onConfirm={stop}
        title="Stop before it finishes?"
        description={`What was copied so far stays in ${project.name ?? 'the new project'}. Nothing in ${from} changes.`}
        confirmLabel="Stop import"
        cancelLabel="Keep going"
        danger
        busy={stopping}
      >
        {stopError && (
          <KitNote icon={AlertTriangle} tone="danger">
            {stopError}
          </KitNote>
        )}
      </KitConfirmDialog>

      <KitConfirmDialog
        open={confirmDelete}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false)
        }}
        onConfirm={removeProject}
        title={`Delete ${project.name ?? 'this project'}?`}
        description={`Its tables, users and files copied so far are removed. You can’t undo this. Nothing in ${from} changes.`}
        confirmLabel="Delete project"
        danger
        busy={deleting}
        requireText={project.name ?? undefined}
      >
        {deleteError && (
          <KitNote icon={AlertTriangle} tone="danger">
            {deleteError}
          </KitNote>
        )}
        {deleteReauth && <SignInAgain reauth={deleteReauth} onSignedIn={() => void removeProject()} />}
      </KitConfirmDialog>
    </OrgShell>
  )
}
