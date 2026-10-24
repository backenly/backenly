'use client'

/**
 * The projects page, shared by both editions.
 *
 * Single-tenant renders it at /app with no organization: every project the
 * account can reach, which there is one of. Backenly Cloud renders it at
 * /app/org/[orgId] for one organization: that team's projects, created inside
 * that team, and only by the people allowed to (owners and admins).
 *
 * Rebuilt 2026-10-02 on the console kit. A project card is a real link (it
 * prefetches, and Cmd/Ctrl-click opens a new tab), it states only what the
 * listing actually returns (status, tables, last change), and its secondary
 * actions live behind one overflow menu. A new account sees what a project is
 * and how it gets built, instead of an empty dashed box.
 */

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Cable, Database, MessageSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { getProjects, deleteProject, type Project } from '@/lib/api/projects'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  EmptyState,
  KitButton,
  KitConfirmDialog,
  KitInput,
  KitModal,
  KitNote,
  OverflowMenu,
  PageHeader,
  Skeleton,
  StatusDot,
  type StatusTone,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_CONTROL, R_PANEL, WELL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { CLOUD_REGIONS, HOME_REGION, regionLabel, type CloudRegion, type CloudRegionId } from '@/lib/regions'

type UserProfile = { id: string; name?: string; email?: string }

/** The organization whose projects these are, and the caller's role in it. */
export interface ProjectsHomeOrg {
  id: string
  name: string
  role: string
}

// Keyed by organization, so switching teams never flashes the last team's list.
const cachedProjects = new Map<string, Project[]>()
let cachedCurrentUser: UserProfile | null = null

const canCreateIn = (org?: ProjectsHomeOrg | null) => !org || org.role === 'OWNER' || org.role === 'ADMIN'

/** Search earns its place once there is something to search through. */
const SEARCH_THRESHOLD = 6

async function getCurrentUser(): Promise<UserProfile | null> {
  try {
    const response = await fetch('/api/auth/me')
    if (!response.ok) return null
    const data = await response.json()
    return data.user || null
  } catch {
    return null
  }
}

function timeAgo(dateStr: string | Date | undefined): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The project's state, in the words the top bar's project switcher uses. */
function statusOf(project: Project): { tone: StatusTone; label: string; pulse?: boolean } {
  // A paused project's API refuses every call, so its publish status would
  // mislead. Neutral on purpose: paused is a state, not an alarm.
  if (project.pausedAt) return { tone: 'paused', label: 'Paused' }
  switch (project.projectStatus) {
    case 'LIVE':
      return { tone: 'operational', label: 'Live' }
    case 'DEPLOYING':
      return { tone: 'attention', label: 'Deploying', pulse: true }
    case 'FAILED':
      return { tone: 'failed', label: 'Failed' }
    default:
      return { tone: 'managed', label: 'Not published' }
  }
}

export function ProjectsHome({ org = null }: { org?: ProjectsHomeOrg | null }) {
  const router = useRouter()
  const cacheKey = org?.id ?? ''
  const loginRedirect = `/auth/login?redirect=${encodeURIComponent(org ? `/app/org/${org.id}` : '/app')}`
  const canCreate = CLOUD_CONTROL_PLANE && canCreateIn(org)
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects.get(cacheKey) || [])
  const [loading, setLoading] = useState(() => !cachedProjects.has(cacheKey))
  const [user, setUser] = useState<UserProfile | null>(() => cachedCurrentUser)
  const [creating, setCreating] = useState(false)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [limitError, setLimitError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewModal, setShowNewModal] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const fetchProjects = async () => {
      try {
        const currentUser = await getCurrentUser()
        if (cancelled) return
        if (!currentUser) {
          router.push(loginRedirect)
          return
        }
        cachedCurrentUser = currentUser
        setUser(currentUser)
        const fetchedProjects = await getProjects(currentUser.id, { orgId: org?.id ?? null })
        if (cancelled) return
        cachedProjects.set(cacheKey, fetchedProjects)
        setProjects(fetchedProjects)
      } catch (error: any) {
        if (cancelled) return
        const message = error?.message?.toLowerCase() || ''
        if (message.includes('session') || message.includes('unauthorized')) {
          router.push(loginRedirect)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    fetchProjects()
    return () => {
      cancelled = true
    }
  }, [router, org?.id, cacheKey, loginRedirect])

  // Creates the project, then opens its workspace. Building happens through
  // the user's coding agent over MCP (Connect) once the workspace is open.
  const createProject = async (name: string, region: CloudRegionId | null): Promise<string | null> => {
    if (!user) return null
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // Inside an organization the project is created there, for that team.
      // The region is sent only on Cloud, where the picker exists.
      body: JSON.stringify({
        name,
        userId: user.id,
        ...(org ? { organizationId: org.id } : {}),
        ...(region ? { region } : {}),
      }),
    })
    if (response.status === 401) {
      router.push(loginRedirect)
      return null
    }
    if (response.status === 403) {
      const errData = await response.json().catch(() => ({}))
      // A role refusal is not a plan limit: say what it is, in the form.
      if (CLOUD_CONTROL_PLANE && errData.code && errData.code !== 'PLAN_LIMIT_EXCEEDED') {
        throw new Error(errData.error || 'You cannot create projects here.')
      }
      // Off Cloud a 403 here is PROJECT_CREATION_UNSUPPORTED: architectural,
      // not a tier ceiling. "Your free plan" would be both wrong and an
      // upsell on a deployment with nothing to sell.
      setLimitError(
        errData.error ||
          (CLOUD_CONTROL_PLANE
            ? 'You have reached your project limit on the free plan.'
            : 'This deployment hosts one project. That is architectural, not a limit that can be lifted.'),
      )
      return null
    }
    if (!response.ok) throw new Error('Failed to create project')
    const data = await response.json()
    return data.project?.id || data.data?.id || data.id || null
  }

  const handleDeleteProject = (projectId: string, projectName: string) => {
    setDeleteError(null)
    setDeleteTarget({ id: projectId, name: projectName })
  }

  const confirmDeleteProject = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteProject(deleteTarget.id)
      setProjects((prev) => {
        const next = prev.filter((project) => project.id !== deleteTarget.id)
        cachedProjects.set(cacheKey, next)
        return next
      })
      setDeleteTarget(null)
    } catch {
      setDeleteError('The project could not be deleted. Try again.')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleStartRename = (project: Project) => {
    setEditingProjectId(project.id)
    setEditingName(project.name)
    setTimeout(() => editInputRef.current?.select(), 0)
  }

  const handleRenameSubmit = async (projectId: string) => {
    const trimmed = editingName.trim()
    if (!trimmed) {
      setEditingProjectId(null)
      return
    }
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: trimmed }),
      })
      if (res.ok) {
        setProjects((prev) => {
          const next = prev.map((project) => (project.id === projectId ? { ...project, name: trimmed } : project))
          cachedProjects.set(cacheKey, next)
          return next
        })
      }
    } catch {
      // Keep the previous name if the request fails.
    } finally {
      setEditingProjectId(null)
    }
  }

  const isEmpty = projects.length === 0
  const query = searchQuery.trim().toLowerCase()
  const visibleProjects = query ? projects.filter((project) => project.name.toLowerCase().includes(query)) : projects
  const showSearch = projects.length >= SEARCH_THRESHOLD

  const openNew = () => {
    setCreateError(null)
    setShowNewModal(true)
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader
          className="!px-0"
          title="Projects"
          meta={
            !loading && projects.length > 0 ? (
              <span className="text-[13px] tabular-nums text-faint">{projects.length}</span>
            ) : undefined
          }
          description={
            org
              ? `Every backend in ${org.name}. Open one to manage its data, functions and autonomy.`
              : 'Every backend on this account. Open one to manage its data, functions and autonomy.'
          }
          actions={
            !loading && !isEmpty ? (
              <>
                {showSearch && (
                  <div className="relative w-full sm:w-[240px]">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
                      strokeWidth={2}
                    />
                    <KitInput
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search projects"
                      aria-label="Search projects"
                      className="pl-8 pr-8"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        aria-label="Clear search"
                        className={`absolute right-1.5 top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 hover:text-zinc-200 ${FOCUS}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                {canCreate && (
                  <KitButton variant="primary" icon={Plus} onClick={openNew}>
                    New project
                  </KitButton>
                )}
              </>
            ) : undefined
          }
        />

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${PLATE} border ${EDGE} ${R_PANEL} p-4`}>
                <div className="flex items-center gap-3">
                  <Skeleton className="h-[32px] w-[32px] rounded-[8px]" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-[13px] w-2/5" />
                    <Skeleton className="h-[11px] w-1/4" />
                  </div>
                </div>
                <Skeleton className="mt-5 h-[12px] w-4/5" />
                <Skeleton className="mt-2 h-[12px] w-3/5" />
                <div className={`mt-5 border-t ${RULE} pt-3`}>
                  <Skeleton className="h-[12px] w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : isEmpty ? (
          canCreate ? (
            <FirstProject onCreate={openNew} />
          ) : CLOUD_CONTROL_PLANE ? (
            <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
              <EmptyState
                icon={Database}
                title="No projects yet"
                description={`${org?.name ?? 'This organization'} has no projects. Owners and admins create them; ask one of them to start one.`}
              />
            </div>
          ) : (
            <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
              <EmptyState
                icon={Database}
                title="No project yet"
                description="This deployment provisions its one project with npm run bootstrap. Run it on the server, then reload this page."
              />
            </div>
          )
        ) : visibleProjects.length === 0 ? (
          <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
            <EmptyState
              icon={Search}
              title="No matching projects"
              description={`No project name contains “${searchQuery.trim()}”.`}
              action={
                <KitButton icon={X} onClick={() => setSearchQuery('')}>
                  Clear search
                </KitButton>
              }
            />
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleProjects.map((project) => (
              <li key={project.id}>
                <ProjectCard
                  project={project}
                  renaming={editingProjectId === project.id}
                  editingName={editingName}
                  editInputRef={editInputRef}
                  onStartRename={() => handleStartRename(project)}
                  onRenameChange={setEditingName}
                  onRenameSubmit={() => handleRenameSubmit(project.id)}
                  onCancelRename={() => setEditingProjectId(null)}
                  onDelete={() => handleDeleteProject(project.id, project.name)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {canCreate && (
        <NewProjectModal
          open={showNewModal}
          creating={creating}
          error={createError}
          orgName={org?.name ?? null}
          onClose={() => {
            if (creating) return
            setShowNewModal(false)
            setCreateError(null)
          }}
          onCreate={async ({ name, region }) => {
            setCreating(true)
            setCreateError(null)
            try {
              const id = await createProject(name, region)
              if (id) {
                cachedProjects.delete(cacheKey)
                router.push(`/app/projects/${id}`)
              }
              setShowNewModal(false)
            } catch (err) {
              const message = err instanceof Error && err.message !== 'Failed to create project' ? err.message : null
              setCreateError(message ?? 'The project could not be created. Try again in a moment.')
            } finally {
              setCreating(false)
            }
          }}
        />
      )}

      {/* Delete confirmation: kit dialog, never window.confirm */}
      <KitConfirmDialog
        open={!!deleteTarget}
        onCancel={() => {
          if (!deleteBusy) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        onConfirm={confirmDeleteProject}
        title={`Delete ${deleteTarget?.name ?? 'this project'}?`}
        description="Its database, tables, end users, files and change history are removed. This cannot be undone."
        confirmLabel="Delete project"
        danger
        busy={deleteBusy}
      >
        {deleteError && (
          <KitNote icon={AlertTriangle} tone="danger">
            {deleteError}
          </KitNote>
        )}
      </KitConfirmDialog>

      {/* Plan limit */}
      <KitModal
        open={!!limitError}
        onClose={() => setLimitError(null)}
        title="Project limit reached"
        description={limitError ?? undefined}
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setLimitError(null)}>
              Dismiss
            </KitButton>
            {CLOUD_CONTROL_PLANE && (
              <KitButton variant="primary" onClick={() => router.push('/app/billing')}>
                Compare plans
              </KitButton>
            )}
          </>
        }
      />
    </OrgShell>
  )
}

// ─── First project ────────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: Plus,
    title: 'Create a project',
    body: 'Backenly provisions an isolated Postgres schema with its own auth, storage, functions and REST API.',
  },
  {
    icon: Cable,
    title: 'Connect your coding agent',
    body: 'One scoped key and one command for Claude Code, Cursor, Codex or any MCP client.',
  },
  {
    icon: MessageSquare,
    title: 'Describe what to build',
    body: 'Tables, access rules, storage and functions land as planned, verified changes you can roll back.',
  },
] as const

/** What a brand-new account sees: what a project is, and the three steps to a working backend. */
function FirstProject({ onCreate }: { onCreate: () => void }) {
  return (
    <section className={`overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`} aria-labelledby="first-project-title">
      <div className="grid gap-8 px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
        <div className="max-w-[46ch]">
          <h2 id="first-project-title" className="text-[18px] font-semibold leading-[26px] tracking-[-0.016em] text-zinc-50">
            Create your first backend
          </h2>
          <p className="mt-2 text-[14px] leading-[22px] text-zinc-400 [text-wrap:pretty]">
            A project is one backend: a Postgres database with end-user auth, file storage, functions and an
            API. Your coding agent builds it. Backenly plans each change, applies it, verifies it, and keeps it
            running.
          </p>
          <div className="mt-6">
            <KitButton variant="primary" icon={Plus} onClick={onCreate}>
              New project
            </KitButton>
          </div>
        </div>

        <ol className={`relative ${R_PANEL} border ${EDGE} ${WELL}`}>
          {STEPS.map((step, i) => {
            const Icon = step.icon
            return (
              <li key={step.title} className={`flex gap-3.5 px-4 py-4 sm:px-5 ${i > 0 ? `border-t ${RULE}` : ''}`}>
                <span
                  aria-hidden
                  className="mt-[1px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.03] text-[12px] font-medium tabular-nums text-zinc-300"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13px] font-medium leading-[20px] text-zinc-100">
                    <Icon className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} aria-hidden />
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-[20px] text-zinc-400">{step.body}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

// ─── New project ──────────────────────────────────────────────────────────────

/**
 * Create a project: one form, set out the way Supabase and Vercel set theirs.
 * Label and hint on the left, the control on the right, rows on hairlines, so
 * the decisions read in order: where it belongs, what it is called, where it
 * runs. On a phone the rows stack.
 *
 * Region (Cloud only) lists the five Backenly Cloud regions from
 * lib/regions.ts. An open region can be chosen; the others are listed, greyed,
 * as "Not open yet", so nobody picks a place their project would not actually
 * run. The server refuses a region that is not open as well.
 */
function NewProjectModal({
  open,
  creating,
  error,
  orgName,
  onClose,
  onCreate,
}: {
  open: boolean
  creating: boolean
  error?: string | null
  /** The organization it will be created in, when there is one. */
  orgName?: string | null
  onClose: () => void
  onCreate: (input: { name: string; region: CloudRegionId | null }) => void
}) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState<CloudRegionId>(HOME_REGION)
  const nameId = useId()
  const regionLabelId = useId()
  useEffect(() => {
    if (open) {
      setName('')
      setRegion(HOME_REGION)
    }
  }, [open])
  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && !creating) onCreate({ name: trimmed, region: CLOUD_CONTROL_PLANE ? region : null })
  }

  return (
    <KitModal
      open={open}
      onClose={onClose}
      width="max-w-[640px]"
      title="Create a new project"
      description="A project is one backend: a Postgres database with auth, storage, functions and an API. Your coding agent builds it once you connect it."
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </KitButton>
          <KitButton variant="primary" icon={Plus} onClick={submit} disabled={!name.trim()} loading={creating}>
            Create project
          </KitButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className={`divide-y divide-white/[0.06] overflow-hidden ${R_PANEL} border ${EDGE}`}>
          {orgName && (
            <FormRow label="Organization" hint="Its members can open the project with their roles.">
              <p
                className={`flex h-[36px] items-center ${R_CONTROL} border ${EDGE} ${WELL} px-3 text-[13px] font-medium text-zinc-100 sm:h-[32px]`}
              >
                <span className="truncate">{orgName}</span>
              </p>
            </FormRow>
          )}

          <FormRow label="Project name" hint="You can rename it later." htmlFor={nameId}>
            <KitInput
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. movie-reviews"
              maxLength={100}
              disabled={creating}
              autoComplete="off"
            />
          </FormRow>

          {CLOUD_CONTROL_PLANE && (
            <FormRow
              label="Region"
              labelId={regionLabelId}
              hint="Where the database and API run. Pick the one closest to your users."
            >
              <RegionPicker value={region} onChange={setRegion} disabled={creating} labelledBy={regionLabelId} />
            </FormRow>
          )}
        </div>

        {/* A hidden submit keeps Enter in the name field submitting the form. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />

        {error && (
          <div className="mt-4">
            <KitNote icon={AlertTriangle} tone="danger">
              {error}
            </KitNote>
          </div>
        )}
      </form>
    </KitModal>
  )
}

/** One row of the create form: what it is on the left, the control on the right. */
function FormRow({
  label,
  hint,
  htmlFor,
  labelId,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  labelId?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-2.5 px-4 py-4 sm:grid-cols-[168px_minmax(0,1fr)] sm:gap-6">
      <div className="min-w-0 sm:pt-[6px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </label>
        ) : (
          <p id={labelId} className="text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </p>
        )}
        {hint && <p className="mt-0.5 text-[12px] leading-[17px] text-faint [text-wrap:pretty]">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * The regions with what this deployment serves as open (GET /api/regions), so
 * a region opened on the running deployment can be chosen without a new build.
 * Until the answer arrives, or if it never does, the build's own list stands.
 * The answer can only open a region this build lists; creating the project is
 * checked again on the server either way.
 */
function useRegionsAsServed(): readonly CloudRegion[] {
  const [regions, setRegions] = useState<readonly CloudRegion[]>(CLOUD_REGIONS)
  useEffect(() => {
    let cancelled = false
    fetch('/api/regions')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { regions?: { id?: unknown; open?: unknown }[] } | null) => {
        if (cancelled || !Array.isArray(body?.regions)) return
        const open = new Set(body.regions.filter((r) => r?.open === true).map((r) => r.id))
        setRegions(CLOUD_REGIONS.map((r) => ({ ...r, open: r.open || open.has(r.id) })))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return regions
}

/**
 * The five regions as one list. Native radio inputs underneath: Tab reaches
 * the group, the arrow keys move between the open regions, and the regions
 * that are not open are disabled, so they are skipped and announced as such.
 */
function RegionPicker({
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  value: CloudRegionId
  onChange: (region: CloudRegionId) => void
  disabled?: boolean
  labelledBy: string
}) {
  const regions = useRegionsAsServed()
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className={`divide-y divide-white/[0.06] overflow-hidden ${R_CONTROL} border ${EDGE} ${WELL}`}
    >
      {regions.map((r) => {
        const selected = r.id === value
        return (
          <label
            key={r.id}
            className={`flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-violet-300/60 ${
              r.open ? 'cursor-pointer hover:bg-white/[0.025]' : 'cursor-not-allowed'
            } ${selected ? 'bg-white/[0.035]' : ''}`}
          >
            <input
              type="radio"
              name="project-region"
              value={r.id}
              checked={selected}
              disabled={!r.open || disabled}
              onChange={() => onChange(r.id)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={`flex h-[22px] w-[32px] shrink-0 items-center justify-center rounded-[5px] border ${EDGE} font-mono text-[10.5px] font-medium tracking-[0.04em] ${
                r.open ? 'text-zinc-300' : 'text-zinc-600'
              }`}
            >
              {r.countryCode}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] font-medium leading-[18px] ${r.open ? 'text-zinc-100' : 'text-zinc-500'}`}>
                {r.city}
              </span>
              <span className={`block truncate font-mono text-[11.5px] leading-[16px] ${r.open ? 'text-faint' : 'text-zinc-600'}`}>
                {r.area} · {r.id}
              </span>
            </span>
            {r.open ? (
              <span
                aria-hidden
                className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
                  selected ? 'border-violet-300 bg-violet-400/20' : 'border-white/20'
                }`}
              >
                {selected && <span className="h-[6px] w-[6px] rounded-full bg-violet-200" />}
              </span>
            ) : (
              <span className="shrink-0 text-[11.5px] text-faint">Not open yet</span>
            )}
          </label>
        )
      })}
    </div>
  )
}

// ─── Project card ─────────────────────────────────────────────────────────────

/**
 * A project's mark: its initial on one of a few muted tints, chosen from the
 * id so a project keeps its colour wherever it appears and a grid of them can
 * be told apart at a glance. Identity only; status stays with the dot.
 */
const MONOGRAM_TINTS = [
  'border-violet-300/20 bg-violet-400/[0.09] text-violet-200',
  'border-sky-300/20 bg-sky-400/[0.08] text-sky-200',
  'border-emerald-300/20 bg-emerald-400/[0.08] text-emerald-200',
  'border-amber-300/20 bg-amber-400/[0.08] text-amber-200',
  'border-rose-300/20 bg-rose-400/[0.08] text-rose-200',
  'border-teal-300/20 bg-teal-400/[0.08] text-teal-200',
] as const

function tintOf(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return MONOGRAM_TINTS[h % MONOGRAM_TINTS.length]
}

function Monogram({ id, name }: { id: string; name: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || '·'
  return (
    <span
      aria-hidden
      className={`flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded-[8px] border text-[13px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${tintOf(id)}`}
    >
      {letter}
    </span>
  )
}

function ProjectCard({
  project,
  renaming,
  editingName,
  editInputRef,
  onStartRename,
  onRenameChange,
  onRenameSubmit,
  onCancelRename,
  onDelete,
}: {
  project: Project
  renaming: boolean
  editingName: string
  editInputRef: React.RefObject<HTMLInputElement>
  onStartRename: () => void
  onRenameChange: (name: string) => void
  onRenameSubmit: () => void
  onCancelRename: () => void
  onDelete: () => void
}) {
  const status = statusOf(project)
  const tables = project.metrics?.totalTables
  const description = project.description?.trim()
  const href = `/app/projects/${project.id}`

  return (
    <article
      className={`group relative flex h-full min-h-[172px] flex-col ${PLATE} border ${EDGE} ${R_PANEL} p-4 transition-[border-color,background-color] duration-150 hover:border-white/[0.14] hover:bg-[#111215]`}
    >
      {/* The whole card is the link; the menu and the rename field sit above it. */}
      <Link
        href={href}
        aria-label={`Open ${project.name}`}
        className={`absolute inset-0 z-0 ${R_PANEL} ${FOCUS}`}
      />

      <div className="flex items-start gap-3">
        <Monogram id={project.id} name={project.name} />
        <div className="min-w-0 flex-1 pt-[1px]">
          {renaming ? (
            <input
              ref={editInputRef}
              value={editingName}
              onChange={(e) => onRenameChange(e.target.value)}
              onBlur={onRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameSubmit()
                if (e.key === 'Escape') onCancelRename()
              }}
              aria-label="Project name"
              maxLength={100}
              autoFocus
              className="relative z-10 -my-[3px] h-[28px] w-full rounded-[6px] border border-violet-300/40 bg-[#08090a] px-2 text-[14px] font-semibold text-zinc-50 outline-none ring-[3px] ring-violet-400/15"
            />
          ) : (
            <h3 className="truncate text-[14px] font-semibold leading-[22px] tracking-[-0.01em] text-zinc-50">
              {project.name}
            </h3>
          )}
          <p className="truncate text-[12px] leading-[16px] text-faint">
            {/* The region holding the project's data; null reads as the home region (lib/regions.ts). */}
            {CLOUD_CONTROL_PLANE ? regionLabel(project.region) : 'Self-hosted'}
          </p>
        </div>
        {/* Always visible: a hover-only trigger would also hide its own open
            menu the moment the pointer left the card. */}
        <div className="relative z-10 -mr-1.5 -mt-1">
          <OverflowMenu
            label={`Actions for ${project.name}`}
            items={[
              { label: 'Rename', icon: Pencil, onClick: onStartRename },
              { separator: true },
              { label: 'Delete project', icon: Trash2, onClick: onDelete, danger: true },
            ]}
          />
        </div>
      </div>

      <p
        className={`mt-3 line-clamp-2 min-h-[40px] text-[13px] leading-[20px] [text-wrap:pretty] ${
          description ? 'text-zinc-400' : 'text-faint'
        }`}
      >
        {description || 'No description yet.'}
      </p>

      <div className={`mt-auto flex items-center gap-3 border-t ${RULE} pt-3 text-[12px] leading-[16px] text-faint`}>
        <StatusDot tone={status.tone} label={status.label} pulse={status.pulse} />
        {typeof tables === 'number' && (
          <span className="tabular-nums">
            {tables} {tables === 1 ? 'table' : 'tables'}
          </span>
        )}
        {project.updatedAt && (
          <span className="ml-auto tabular-nums" title={new Date(project.updatedAt).toLocaleString()}>
            Updated {timeAgo(project.updatedAt)}
          </span>
        )}
      </div>
    </article>
  )
}
