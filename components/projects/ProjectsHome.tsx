'use client'

/**
 * The projects page, shared by both editions.
 *
 * Single-tenant renders it at /app with no organization: every project the
 * account can reach, which there is one of. Backenly Cloud renders it at
 * /app/org/[orgId] for one organization: that team's projects, created inside
 * that team, and only by the people allowed to (owners and admins).
 *
 * Rebuilt 2026-11-16 (console team pages, designers/DECISIONS.md §3): a grid
 * of project cards (ProjectList: the founder's call the same evening, after
 * one project shown as a row across the whole page looked unfinished), the
 * header's one fact ("1 of 1" when a plan limit is reached, else the count),
 * and live state filled in after the cards are on screen: what waits on you,
 * when the self-healing loop last checked, whether your agent has connected
 * (GET /api/projects/status). A list that fails to load says so in a panel,
 * with Retry; it never turns into the first-project screen.
 *
 * Starting: on Backenly Cloud, an owner or admin of an organization with no
 * projects is asked once, in a large dialog, to create their first project,
 * with importing from Supabase, Firebase or Postgres as one quiet link
 * (components/onboarding/WelcomeDialog). New project is the form with the same
 * link. A project being moved in says "Importing" on its card until it is done
 * (GET /api/import?orgId=).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Building2, Database, FolderPlus, Plus, Search, X } from 'lucide-react'
import { DeleteRefusedError, deleteProject, type Project, type Reauthentication } from '@/lib/api/projects'
import { SignInAgain } from '@/components/console/SignInAgain'
import { RecentlyDeleted } from './RecentlyDeleted'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  INPUT_BASE,
  KitButton,
  KitButtonLink,
  KitConfirmDialog,
  KitModal,
  KitNote,
  PageHeader,
  Skeleton,
} from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { EmptyLine, Row, RowList, ROW_TEXT, ROW_TITLE } from '@/components/autonomy/rows'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { FREE_INCLUDED, PRO_PRICE } from '@/lib/pricing/plan-rows'
import type { CloudRegionId } from '@/lib/regions'
import { sharedRead } from '@/lib/client/shared-read'
import { MovedNotice } from '@/components/migrate/MovedNotice'
import { WelcomeDialog } from '@/components/onboarding/WelcomeDialog'
import { useOrgImports } from '@/components/onboarding/useOrgImports'
import { useStartChoice } from '@/components/onboarding/useStartChoice'
import { importPath, isRunning } from '@/lib/import/client'
import type { ImportSourceId } from '@/lib/import/contract'
import { ProjectCard, ProjectGrid, ProjectsPanel, SkeletonCards } from './ProjectList'
import { NewProjectDialog } from './NewProjectDialog'
import { useLiveStatus, useNow } from './useLiveStatus'

type UserProfile = { id: string; name?: string; email?: string }

/** The organization whose projects these are, and the caller's role in it. */
export interface ProjectsHomeOrg {
  id: string
  name: string
  role: string
}

/**
 * Where the organization itself stands. The Cloud page knows the id from the
 * URL before it knows the name and the caller's role, so the list can load
 * while the organization does, behind one skeleton.
 */
export type ProjectsHomeOrgStatus = 'ready' | 'loading' | 'missing' | 'failed'

// Keyed by organization, so switching teams never flashes the last team's list.
const cachedProjects = new Map<string, Project[]>()
const cachedOrgs = new Map<string, ProjectsHomeOrg>()
let cachedCurrentUser: UserProfile | null = null

/** Search earns its place once there is something to search through. */
const SEARCH_THRESHOLD = 6

/** Pro's monthly price, from the plan facts the Billing page compares (lib/pricing/plan-rows.ts). */
const PRO_MONTHLY = '$' + (PRO_PRICE.monthlyCents / 100).toLocaleString('en-US')

const PLAN_NAMES: Record<string, string> = { SANDBOX: 'Free', FREE: 'Free', BUILDER: 'Pro', SCALE: 'Enterprise' }

/** Owners and admins create and delete projects; developers build in them, so they may rename one. */
function permissionsOf(org: ProjectsHomeOrg | null) {
  if (!org) return { create: CLOUD_CONTROL_PLANE, rename: true, remove: true }
  const admin = org.role === 'OWNER' || org.role === 'ADMIN'
  return { create: CLOUD_CONTROL_PLANE && admin, rename: admin || org.role === 'DEVELOPER', remove: admin }
}

/** The signed-in person, and whether the session was refused (401) rather than unread. */
async function readCurrentUser(): Promise<{ user: UserProfile | null; signedOut: boolean }> {
  try {
    const response = await sharedRead<{ user?: UserProfile }>('/api/auth/me')
    return { user: response.ok ? response.data?.user ?? null : null, signedOut: response.status === 401 }
  } catch {
    return { user: null, signedOut: false }
  }
}

/** Most recently used first; never used last, in the order the server gave. */
function byLastUsed(projects: Project[]): Project[] {
  const at = (p: Project) => (p.lastActivityAt ? new Date(p.lastActivityAt).getTime() : -Infinity)
  return projects
    .map((project, i) => ({ project, i }))
    .sort((a, b) => at(b.project) - at(a.project) || a.i - b.i)
    .map(({ project }) => project)
}

export function ProjectsHome({
  org = null,
  orgStatus = 'ready',
  onRetryOrg,
}: {
  org?: ProjectsHomeOrg | null
  orgStatus?: ProjectsHomeOrgStatus
  onRetryOrg?: () => void
}) {
  const router = useRouter()
  const orgId = org?.id ?? null
  const cacheKey = orgId ?? ''
  // The organization as last seen, so a return visit renders at once.
  const orgMeta: ProjectsHomeOrg | null = orgStatus === 'ready' ? org : orgId ? cachedOrgs.get(orgId) ?? null : null
  // Nothing is offered until the caller's role in the organization is known.
  const may = orgId && !orgMeta ? { create: false, rename: false, remove: false } : permissionsOf(orgMeta)
  const loginRedirect = `/auth/login?redirect=${encodeURIComponent(orgId ? `/app/org/${orgId}` : '/app')}`
  const billingHref = orgId ? `/app/org/${orgId}/billing` : '/app/billing'

  const [projects, setProjects] = useState<Project[] | null>(() => cachedProjects.get(cacheKey) ?? null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [user, setUser] = useState<UserProfile | null>(() => cachedCurrentUser)

  const [searchQuery, setSearchQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [showLimit, setShowLimit] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Set when the server asks for a sign-in from the last ten minutes first.
  const [deleteReauth, setDeleteReauth] = useState<Reauthentication | null>(null)
  // Moves when a project is deleted here, so Recently deleted reads its list again.
  const [deletedVersion, setDeletedVersion] = useState(0)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(null)
  const renameBusy = useRef(false)

  // Whether a project can be created here, asked before the form opens (GET
  // /api/projects/can-create), and, when the plan is full, how full: the
  // header says "1 of 1" before anyone clicks. Null until known.
  const [creation, setCreation] = useState<{ allowed: boolean; error?: string; code?: string; currentPlan?: string } | null>(null)
  const [limit, setLimit] = useState<{ used: number; max: number } | null>(null)
  const [creationSettled, setCreationSettled] = useState(false)
  const [creationAsked, setCreationAsked] = useState(0)

  useEffect(() => {
    if (orgStatus === 'ready' && org) cachedOrgs.set(org.id, org)
  }, [orgStatus, org])

  // The signed-in person, for creating; asked alongside the list, not before
  // it. Only a refused session signs out: a failed read is not one.
  useEffect(() => {
    let cancelled = false
    readCurrentUser().then(({ user: me, signedOut }) => {
      if (cancelled) return
      if (signedOut) {
        router.push(loginRedirect)
        return
      }
      if (me) {
        cachedCurrentUser = me
        setUser(me)
      }
    })
    return () => {
      cancelled = true
    }
  }, [router, loginRedirect])

  // The list. Its access rule and organization scoping are the server's
  // (GET /api/projects); a failure is said, never shown as "no projects".
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(orgId ? `/api/projects?orgId=${encodeURIComponent(orgId)}` : '/api/projects', {
          credentials: 'include',
          cache: 'no-store',
        })
        if (res.status === 401) {
          router.push(loginRedirect)
          return
        }
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !body?.success || !Array.isArray(body.data)) throw new Error('list')
        cachedProjects.set(cacheKey, body.data)
        setProjects(body.data)
        setLoadFailed(false)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [router, orgId, cacheKey, loginRedirect, attempt])

  useEffect(() => {
    if (!may.create) return
    let cancelled = false
    const ask = async () => {
      try {
        const res = await fetch(
          orgId ? `/api/projects/can-create?orgId=${encodeURIComponent(orgId)}` : '/api/projects/can-create',
          { credentials: 'include' },
        )
        const answer = res.ok ? await res.json() : null
        if (cancelled) return
        setCreation(answer)
        const full = answer?.allowed === false && (!answer.code || answer.code === 'PLAN_LIMIT_EXCEEDED')
        if (full) {
          // How full, in the plan's own numbers (GET /api/billing/usage).
          const usage = await fetch(
            orgId ? `/api/billing/usage?orgId=${encodeURIComponent(orgId)}` : '/api/billing/usage',
            { credentials: 'include' },
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
          if (cancelled) return
          const used = Number(usage?.projectsUsed)
          const max = Number(usage?.maxProjects)
          setLimit(usage?.maxProjects != null && Number.isFinite(used) && Number.isFinite(max) && max > 0 ? { used, max } : null)
        } else {
          setLimit(null)
        }
      } catch {
        if (!cancelled) setCreation(null)
      } finally {
        if (!cancelled) setCreationSettled(true)
      }
    }
    ask()
    return () => {
      cancelled = true
    }
  }, [may.create, orgId, creationAsked])

  const loading = (projects === null && !loadFailed) || (orgStatus === 'loading' && !orgMeta)
  // The organization's imports (owners and admins on Cloud): which projects
  // are being moved in, and whether importing is offered here at all. When
  // one ends, the list is read again to show what arrived.
  const readListAgain = useCallback(() => setAttempt((n) => n + 1), [])
  const imports = useOrgImports(orgId, !!orgId && may.create, readListAgain)

  // Most recently used first. A project being moved in comes before them all,
  // then one whose import failed in the last day: that is what is happening
  // now, and a project an import created has no "last used" to sort by yet.
  const listed = useMemo(() => {
    if (!projects) return []
    const ordered = byLastUsed(projects)
    const rank = (p: Project) => {
      const job = imports.byProject.get(p.id)
      return !job ? 2 : isRunning(job) ? 0 : job.status === 'failed' ? 1 : 2
    }
    return ordered.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ p }) => p)
  }, [projects, imports.byProject])
  const listFailed = loadFailed && !projects
  const showList = !loading && !listFailed && orgStatus !== 'missing' && orgStatus !== 'failed'
  const hasProjects = listed.length > 0
  const live = useLiveStatus(orgId, showList && hasProjects)
  const now = useNow(10_000)

  const query = searchQuery.trim().toLowerCase()
  const visible = query ? listed.filter((project) => project.name.toLowerCase().includes(query)) : listed
  const showSearch = listed.length >= SEARCH_THRESHOLD
  const region = CLOUD_CONTROL_PLANE
  const atLimit = creation?.allowed === false && (!creation.code || creation.code === 'PLAN_LIMIT_EXCEEDED')
  // Only Free limits projects (Pro has no limit; Enterprise is by contract). The
  // Free rule that counts across organizations names no plan, so no plan named
  // reads as Free too.
  const onFree = !creation?.currentPlan || PLAN_NAMES[creation.currentPlan] === 'Free'
  // That rule can be full while this organization is not: then the server's
  // own sentence says where the project is.
  const fullElsewhere = !!limit && limit.used < limit.max && !!creation?.error
  // Free's limit as this organization's plan row states it, else as Free is sold.
  const freeProjects = limit?.max ?? FREE_INCLUDED.projects

  // The header's one fact, said once it is settled: "1 of 1" at a plan's
  // limit, else the count.
  const fact =
    !showList || (may.create && !creationSettled)
      ? null
      : atLimit && limit && limit.used >= limit.max
        ? `${limit.used.toLocaleString('en-US')} of ${limit.max.toLocaleString('en-US')}`
        : hasProjects
          ? listed.length.toLocaleString('en-US')
          : null

  // Importing is offered where the import API answers; it is one quiet line in both dialogs.
  const importHref = orgId && may.create && imports.available === true ? importPath(orgId) : null

  // The first run: an owner or admin, a team with no projects, room on the
  // plan, and never answered before. Backenly first: "Create your first
  // project", with importing as a line at the bottom (WelcomeDialog).
  const firstRun = useStartChoice(!!orgId && may.create && showList && !hasProjects && creationSettled && !atLimit)

  // Both dialogs create the same way: the project, then straight into it.
  const createAndOpen = async (name: string, chosen: CloudRegionId | null, done: () => void) => {
    setCreating(true)
    setCreateError(null)
    try {
      const id = await createProject(name, chosen)
      if (id) {
        cachedProjects.delete(cacheKey)
        done()
        router.push(`/app/projects/${id}`)
      }
    } catch (err) {
      const message = err instanceof Error && err.message !== 'Failed to create project' ? err.message : null
      setCreateError(message ?? 'The project could not be created. Try again in a moment.')
    } finally {
      setCreating(false)
    }
  }

  const openNew = () => {
    // A plan limit is said before the form, not after it is filled in.
    if (atLimit) {
      setShowLimit(true)
      return
    }
    setCreateError(null)
    setShowNew(true)
  }

  // /app/org/[id]?new=1 (the project switcher's New project) opens the same
  // flow once it is known whether the plan has room (never during the first,
  // server-matching render: creation is unsettled then), then drops the flag.
  const [newAnswered, setNewAnswered] = useState(false)
  if (!newAnswered && may.create && creationSettled && typeof window !== 'undefined') {
    if (new URLSearchParams(window.location.search).get('new') === '1') {
      setNewAnswered(true)
      if (atLimit) {
        setShowLimit(true)
      } else {
        setCreateError(null)
        setShowNew(true)
      }
    }
  }
  useEffect(() => {
    if (!newAnswered) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('new') !== '1') return
    params.delete('new')
    const rest = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  }, [newAnswered])

  // Creates the project, then opens it. Building happens through the person's
  // coding agent over MCP (Connect) once it is open.
  const createProject = async (name: string, chosenRegion: CloudRegionId | null): Promise<string | null> => {
    const read = user ? { user, signedOut: false } : await readCurrentUser()
    if (read.signedOut) {
      router.push(loginRedirect)
      return null
    }
    const me = read.user
    if (!me) throw new Error('Failed to create project')
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name,
        userId: me.id,
        ...(orgId ? { organizationId: orgId } : {}),
        ...(chosenRegion ? { region: chosenRegion } : {}),
      }),
    })
    if (response.status === 401) {
      router.push(loginRedirect)
      return null
    }
    if (response.status === 403) {
      const refusal = await response.json().catch(() => ({}))
      if (!refusal.code || refusal.code === 'PLAN_LIMIT_EXCEEDED') {
        // The plan filled up since the page asked: say so the same way.
        setCreation({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED', error: refusal.error, currentPlan: refusal.currentPlan })
        setCreationAsked((n) => n + 1)
        setShowNew(false)
        setShowLimit(true)
        return null
      }
      throw new Error(refusal.error || 'You cannot create projects here.')
    }
    if (!response.ok) {
      // A region that is not open is refused with a sentence worth showing.
      const failure = await response.json().catch(() => ({}))
      throw new Error(response.status === 400 && failure.code && failure.error ? failure.error : 'Failed to create project')
    }
    const data = await response.json()
    return data.project?.id || data.data?.id || data.id || null
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    setDeleteReauth(null)
    try {
      // The name the person typed; the dialog does not confirm until it matches.
      await deleteProject(deleteTarget.id, deleteTarget.name)
      setProjects((prev) => {
        const next = (prev ?? []).filter((project) => project.id !== deleteTarget.id)
        cachedProjects.set(cacheKey, next)
        return next
      })
      setDeleteTarget(null)
      setDeletedVersion((n) => n + 1)
      // A delete can free a place on the plan.
      setCreationAsked((n) => n + 1)
    } catch (err) {
      if (err instanceof DeleteRefusedError && err.code === 'REAUTH_REQUIRED' && err.reauth) setDeleteReauth(err.reauth)
      else setDeleteError('The project could not be deleted. Try again.')
    } finally {
      setDeleteBusy(false)
    }
  }

  const submitRename = async () => {
    if (!renaming || renameBusy.current) return
    const { id, value } = renaming
    const trimmed = value.trim()
    const current = listed.find((p) => p.id === id)
    setRenaming(null)
    if (!trimmed || !current || trimmed === current.name) return
    renameBusy.current = true
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        const refusal = await res.json().catch(() => ({}))
        throw new Error(res.status === 403 ? 'You cannot rename this project.' : refusal.error || '')
      }
      setProjects((prev) => {
        const next = (prev ?? []).map((project) => (project.id === id ? { ...project, name: trimmed } : project))
        cachedProjects.set(cacheKey, next)
        return next
      })
    } catch (err) {
      const said = err instanceof Error && err.message ? err.message : null
      setRenameError({ id, message: said ?? `Could not rename it to “${trimmed}”. Try again.` })
    } finally {
      renameBusy.current = false
    }
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = (
    <PageHeader
      flush
      title="Projects"
      meta={fact ? <span className="text-[13px] tabular-nums text-faint">{fact}</span> : undefined}
      actions={
        loading ? (
          // The button's place, held while it is not yet known whether this
          // person may create here: the list below does not move when it lands.
          orgStatus === 'loading' && !orgMeta && CLOUD_CONTROL_PLANE ? (
            <Skeleton className="h-[36px] w-[132px] rounded-[7px]" />
          ) : may.create ? (
            <KitButton variant="primary" size="lg" icon={Plus} onClick={openNew}>
              New project
            </KitButton>
          ) : undefined
        ) : (showList || listFailed) && (may.create || showSearch) ? (
          <>
            {showSearch && (
              <div className="relative min-w-0 flex-1 sm:w-[240px] sm:flex-none">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-[11px] top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-zinc-500"
                  strokeWidth={2}
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  className={`${INPUT_BASE} h-[36px] pl-[32px] pr-[34px] [&::-webkit-search-cancel-button]:hidden`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className={`absolute right-[6px] top-1/2 flex h-[24px] w-[24px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 hover:text-zinc-200 ${FOCUS}`}
                  >
                    <X className="h-[14px] w-[14px]" />
                  </button>
                )}
              </div>
            )}
            {may.create && (
              <KitButton variant="primary" size="lg" icon={Plus} onClick={openNew}>
                New project
              </KitButton>
            )}
          </>
        ) : undefined
      }
    />
  )

  // ── Body ────────────────────────────────────────────────────────────────────
  let body: React.ReactNode
  if (orgStatus === 'missing' || orgStatus === 'failed') {
    body = (
      <ProjectsPanel>
        <RowList>
          {orgStatus === 'failed' ? (
            <Row
              icon={AlertTriangle}
              tone="danger"
              title={<p className={ROW_TITLE}>Could not load this organization. Try again.</p>}
              actions={onRetryOrg ? <KitButton onClick={onRetryOrg}>Retry</KitButton> : undefined}
            >
              <p className={`${ROW_TEXT} !text-faint`}>Your projects keep running.</p>
            </Row>
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
      </ProjectsPanel>
    )
  } else if (loading) {
    body = <SkeletonCards />
  } else if (listFailed) {
    body = (
      <ProjectsPanel>
        <RowList>
          <Row
            icon={AlertTriangle}
            tone="danger"
            title={<p className={ROW_TITLE}>Could not load projects. Try again.</p>}
            actions={
              <KitButton
                onClick={() => {
                  setLoadFailed(false)
                  setAttempt((n) => n + 1)
                }}
              >
                Retry
              </KitButton>
            }
          >
            <p className={`${ROW_TEXT} !text-faint`}>Your projects keep running.</p>
          </Row>
        </RowList>
      </ProjectsPanel>
    )
  } else if (!hasProjects) {
    body = (
      <ProjectsPanel>
        {may.create ? (
          <EmptyLine icon={FolderPlus}>
            <span className="font-medium text-zinc-100">Create your first project.</span> It’s a Postgres backend with
            auth, storage, functions and an API that your coding agent builds.
          </EmptyLine>
        ) : CLOUD_CONTROL_PLANE ? (
          <EmptyLine icon={Database}>No projects yet. Ask an owner or admin to create one.</EmptyLine>
        ) : (
          <EmptyLine icon={Database}>
            No project yet. Run <code className="font-mono text-[12px] text-zinc-300">npm run bootstrap</code> on the
            server, then reload this page.
          </EmptyLine>
        )}
      </ProjectsPanel>
    )
  } else {
    body = (
      <>
        <MovedNotice projects={listed} />
        {visible.length === 0 ? (
          <ProjectsPanel>
            <EmptyLine icon={Search}>No project name contains “{searchQuery.trim()}”.</EmptyLine>
          </ProjectsPanel>
        ) : (
            <ProjectGrid>
              {visible.map((project) => {
                const job = imports.byProject.get(project.id) ?? null
                return (
                <ProjectCard
                  key={project.id}
                  project={project}
                  job={job}
                  jobHref={job && orgId ? importPath(orgId, { job: job.jobId }) : null}
                  live={live.byId?.get(project.id)}
                  liveSettled={live.settled}
                  now={now}
                  region={region}
                  actions={{
                    canRename: may.rename,
                    canDelete: may.remove,
                    onStartRename: () => {
                      setRenameError(null)
                      setRenaming({ id: project.id, value: project.name })
                    },
                    onDelete: () => {
                      setDeleteError(null)
                      setDeleteReauth(null)
                      setDeleteTarget({ id: project.id, name: project.name })
                    },
                  }}
                  rename={
                    renaming?.id === project.id
                      ? {
                          value: renaming.value,
                          onChange: (value) => setRenaming({ id: project.id, value }),
                          onSubmit: submitRename,
                          onCancel: () => setRenaming(null),
                        }
                      : null
                  }
                  renameError={renameError?.id === project.id ? renameError.message : null}
                />
                )
              })}
            </ProjectGrid>
        )}
      </>
    )
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        {header}
        {body}
        <RecentlyDeleted
          orgId={orgId ?? null}
          canRestore={may.remove}
          refreshKey={deletedVersion}
          onRestored={() => {
            readListAgain()
            // A restore takes a place on the plan back.
            setCreationAsked((n) => n + 1)
          }}
        />
      </div>

      {may.create && (
        <NewProjectDialog
          open={showNew}
          creating={creating}
          error={createError}
          orgName={orgMeta?.name ?? null}
          importHref={importHref}
          onClose={() => {
            if (creating) return
            setShowNew(false)
            setCreateError(null)
          }}
          onCreate={({ name, region: chosen }) => void createAndOpen(name, chosen, () => setShowNew(false))}
        />
      )}

      {may.create && (
        <WelcomeDialog
          open={firstRun.ask}
          creating={creating}
          error={firstRun.ask ? createError : null}
          importHref={importHref}
          onClose={() => {
            if (creating) return
            firstRun.answer()
            setCreateError(null)
          }}
          onCreate={({ name, region: chosen }) => void createAndOpen(name, chosen, () => firstRun.answer())}
        />
      )}

      <KitConfirmDialog
        open={!!deleteTarget}
        onCancel={() => {
          if (!deleteBusy) {
            setDeleteTarget(null)
            setDeleteError(null)
            setDeleteReauth(null)
          }
        }}
        onConfirm={confirmDelete}
        title={`Delete ${deleteTarget?.name ?? 'this project'}?`}
        description="Its API stops answering at once. You can restore it from Recently deleted for 7 days; then its database, tables, end users, files and change history are removed for good."
        confirmLabel="Delete project"
        danger
        busy={deleteBusy}
        requireText={deleteTarget?.name}
      >
        {deleteError && (
          <KitNote icon={AlertTriangle} tone="danger">
            {deleteError}
          </KitNote>
        )}
        {deleteReauth && <SignInAgain reauth={deleteReauth} onSignedIn={() => void confirmDelete()} />}
      </KitConfirmDialog>

      {/* A full plan, said before the form */}
      <KitModal
        open={showLimit}
        onClose={() => setShowLimit(false)}
        width="max-w-[420px]"
        title={
          onFree
            ? `Free includes ${freeProjects.toLocaleString('en-US')} project${freeProjects === 1 ? '' : 's'}`
            : 'Project limit reached'
        }
        description={
          onFree && !fullElsewhere
            ? `Pro has no project limit, for ${PRO_MONTHLY} a month.`
            : creation?.error ?? 'This plan has no room for another project.'
        }
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setShowLimit(false)}>
              Not now
            </KitButton>
            {onFree ? (
              <KitButtonLink href={billingHref} variant="primary">
                Upgrade to Pro
              </KitButtonLink>
            ) : (
              <KitButtonLink href={billingHref}>Billing</KitButtonLink>
            )}
          </>
        }
      />
    </OrgShell>
  )
}
