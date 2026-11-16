'use client'

/**
 * Project settings: one page, no tabs (project console decisions, 2026-11-16).
 *
 *   Settings
 *   General          name, description; project ID, region, created
 *   Access  2        who can open this project       [Manage members]  (Cloud)
 *   Delete project   one row, then a dialog that asks for the name
 *
 * Settings holds no credentials (decision 4): API keys moved to Connect → API,
 * and the old `?tab=keys` link lands there. `?tab=access` scrolls to Access.
 *
 * Roles come from useProjectRole (GET /api/projects/[id], the server's own
 * resolution). Viewers read General and are told who can change it;
 * developers edit it; deleting is ADMIN, and everyone else is told so instead
 * of seeing a button the server refuses. Access is the team's: "Manage
 * members" and "Upgrade to Pro" open the project's own team
 * (organizationId), never the team the browser last remembered.
 *
 * A project that could not be loaded is never drawn as an empty one: its
 * name would be blank and a delete confirmation would match nothing.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { DeleteRefusedError, deleteProject, forgetProjectReads, getProject, updateProject, type Project, type Reauthentication } from '@/lib/api/projects'
import { SignInAgain } from '@/components/console/SignInAgain'
import {
  CopyField,
  KitButton,
  KitButtonLink,
  KitConfirmDialog,
  KitInput,
  PageHeader,
  Skeleton,
  Tag,
} from '@/components/inspector/kit'
import { EmptyLine, Panel, RowSkeleton, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { formatTime } from '@/components/console/format'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH, RULE } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { findRegion, HOME_REGION } from '@/lib/regions'
import { refreshProjectRole, useProjectRole, type ProjectRoleState } from '@/lib/hooks/useProjectRole'

const LINK = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string
  const role = useProjectRole(projectId)
  const [project, setProject] = useState<Project | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  // API keys live on Connect → API now; an old link to them still lands on them.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'keys') {
      setRedirecting(true)
      router.replace(`/app/projects/${projectId}/connect?tab=api`)
    }
  }, [projectId, router])

  const read = useCallback(async () => {
    try {
      const p = await getProject(projectId)
      setProject(p)
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    if (projectId) void read()
  }, [projectId, read])

  // `?tab=access` was a tab; it is a section now.
  useEffect(() => {
    if (load !== 'ready' || new URLSearchParams(window.location.search).get('tab') !== 'access') return
    document.getElementById('access')?.scrollIntoView({ block: 'start' })
  }, [load])

  let body: ReactNode
  if (redirecting) {
    body = null
  } else if (load === 'error' || (load === 'ready' && !project)) {
    body = (
      <Panel>
        <ErrorRow
          things="this project’s settings"
          onRetry={() => {
            setRetrying(true)
            // The role is read with the project: ask for both again, in one request.
            void refreshProjectRole(projectId)
            void read()
          }}
          retrying={retrying}
        />
      </Panel>
    )
  } else if (load === 'loading' || !project) {
    body = (
      <div aria-busy="true" aria-label="Loading settings" className="space-y-[36px]">
        <div>
          <Skeleton className="mb-[12px] h-[16px] w-[90px]" />
          <Panel>
            <RowSkeleton rows={3} lead="none" />
          </Panel>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="space-y-[36px]">
        <General project={project} role={role} onSaved={setProject} />
        {CLOUD_CONTROL_PLANE && <Access projectId={projectId} organizationId={role.organizationId} canAdminister={role.canAdminister} />}
        <DeleteProject project={project} role={role} onDeleted={() => router.push('/app')} />
      </div>
    )
  }

  return (
    <div className="pb-16">
      <PageHeader title="Settings" />
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER}`}>{body}</div>
    </div>
  )
}

// ── General ───────────────────────────────────────────────────────────────────

/** A label beside its value from `sm`, above it on a phone. */
function FieldRow({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  const Label = htmlFor ? 'label' : 'dt'
  return (
    <div className="grid grid-cols-1 gap-x-[16px] gap-y-[6px] px-[20px] py-[12px] sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center">
      <Label {...(htmlFor ? { htmlFor } : {})} className="text-[13px] leading-[20px] text-zinc-400">
        {label}
        {hint && <span className="ml-[8px] text-[12px] text-faint sm:ml-0 sm:block">{hint}</span>}
      </Label>
      {htmlFor ? <div className="min-w-0">{children}</div> : <dd className="min-w-0 text-[13px] leading-[20px] text-zinc-200">{children}</dd>}
    </div>
  )
}

function General({ project, role, onSaved }: { project: Project; role: ProjectRoleState; onSaved: (p: Project) => void }) {
  const nameId = useId()
  const descriptionId = useId()
  const [name, setName] = useState(project.name ?? '')
  const [description, setDescription] = useState(project.description ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = name.trim() !== (project.name ?? '') || description.trim() !== (project.description ?? '')
  const region = findRegion(project.region) ?? findRegion(HOME_REGION)

  async function save() {
    if (!dirty || !name.trim() || saving) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const updated = await updateProject(project.id, { name: name.trim(), description: description.trim() || null })
      // The top bar and the switcher read the same project: let them read it afresh.
      forgetProjectReads(project.id)
      onSaved({ ...project, ...updated })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const facts = (
    <dl className={`divide-y divide-white/[0.06] ${role.canWrite ? `border-t ${RULE}` : ''}`}>
      <FieldRow label="Project ID">
        <CopyField value={project.id} variant="inline" label="Copy project ID" />
      </FieldRow>
      <FieldRow label="Region">
        {CLOUD_CONTROL_PLANE && region ? (
          <span className="flex flex-wrap items-baseline gap-x-[8px]">
            {region.city}
            <code className="font-mono text-[11.5px] text-faint">{region.id}</code>
          </span>
        ) : (
          'This server'
        )}
      </FieldRow>
      <FieldRow label="Created">{formatTime(project.createdAt, 'date')}</FieldRow>
    </dl>
  )

  return (
    <Section id="general" title="General">
      <Panel>
        {role.canWrite ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="divide-y divide-white/[0.06]">
              <FieldRow label="Name" htmlFor={nameId}>
                <KitInput id={nameId} name="project-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              </FieldRow>
              <FieldRow label="Description" htmlFor={descriptionId} hint="Optional">
                <KitInput
                  id={descriptionId}
                  name="project-description"
                  autoComplete="off"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this backend powers"
                />
              </FieldRow>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-x-[12px] gap-y-[8px] px-[20px] pb-[14px] pt-[4px]">
              {error ? (
                <RefusedLine className="mr-auto">{error}</RefusedLine>
              ) : saved ? (
                <p role="status" className="mr-auto text-[12.5px] leading-[18px] text-zinc-300">
                  Saved
                </p>
              ) : null}
              <KitButton type="submit" variant="primary" loading={saving} disabled={!dirty || !name.trim()}>
                Save
              </KitButton>
            </div>
          </form>
        ) : (
          <dl className="divide-y divide-white/[0.06] border-b border-white/[0.06]">
            <FieldRow label="Name">{project.name}</FieldRow>
            <FieldRow label="Description">{project.description || <span className="text-faint">None</span>}</FieldRow>
          </dl>
        )}
        {facts}
      </Panel>
      {!role.canWrite && !role.loading && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Only developers and admins can change these.</p>
      )}
    </Section>
  )
}

// ── Access ────────────────────────────────────────────────────────────────────
// Project access is organization membership (lib/auth/project-access.ts): the
// owner and every member open it, unless a member is project-scoped (Pro), in
// which case they see only the projects granted to them. Granting and removing
// a scoped member happens here; roles and invites on the team's Members page.

type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'
interface AccessMember {
  userId: string
  name: string | null
  email: string
  role: OrgRole
  isOwner: boolean
  restricted: boolean
  hasAccess: boolean
}
interface ProjectAccessData {
  hasOrg: boolean
  canManage: boolean
  isPaid: boolean
  me?: { userId: string; role: OrgRole }
  members: AccessMember[]
}

const ROLE_WORD: Record<OrgRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', DEVELOPER: 'Developer', VIEWER: 'Viewer' }

function initials(m: AccessMember): string {
  const words = (m.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
  return (words[0]?.[0] ?? m.email[0] ?? '?').toUpperCase()
}

function Access({ projectId, organizationId, canAdminister }: { projectId: string; organizationId: string | null; canAdminister: boolean }) {
  const [data, setData] = useState<ProjectAccessData | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ userId: string; message: string } | null>(null)

  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/access`, { credentials: 'include' })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.success) throw new Error('no access')
      setData(j.data)
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void read()
  }, [read])

  async function setAccess(userId: string, grant: boolean) {
    setBusy(userId)
    setRefusal(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/access`, {
        method: grant ? 'POST' : 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error ?? 'Could not change access.')
      await read()
    } catch (err) {
      setRefusal({ userId, message: err instanceof Error ? err.message : 'Could not change access.' })
    } finally {
      setBusy(null)
    }
  }

  const team = organizationId ? `/app/org/${encodeURIComponent(organizationId)}` : null
  // The route's answer and the project role must both allow it: hidden, never offered and refused.
  const canManage = !!data?.canManage && canAdminister

  let body: ReactNode
  if (load === 'loading') body = <RowSkeleton rows={2} lead="actor" />
  else if (load === 'error' || !data)
    body = (
      <ErrorRow
        things="who can open this project"
        onRetry={() => {
          setRetrying(true)
          void read()
        }}
        retrying={retrying}
      />
    )
  else if (!data.hasOrg || data.members.length === 0) body = <EmptyLine>Only you can open this project.</EmptyLine>
  else
    body = (
      <ul className="divide-y divide-white/[0.06]">
        {data.members.map((m) => {
          const orgWide = !m.restricted || m.isOwner || m.role === 'ADMIN'
          const access = orgWide ? 'All projects' : m.hasAccess ? 'This project' : 'No access'
          const scoped = canManage && m.restricted && !m.isOwner && m.role !== 'ADMIN'
          return (
            <li key={m.userId} className="px-[20px] py-[12px]">
              <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
                <span className="flex min-w-0 flex-[1_1_240px] items-center gap-[12px]">
                  <span
                    aria-hidden
                    className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#27272a,#18181b)] text-[11px] font-medium text-zinc-200 ring-1 ring-inset ring-white/[0.12]"
                  >
                    {initials(m)}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-[8px]">
                      <span className="truncate text-[13.5px] font-medium leading-[20px] text-zinc-50">{m.name || m.email}</span>
                      {m.userId === data.me?.userId && <Tag>You</Tag>}
                    </span>
                    {m.name && <span className="block truncate text-[12px] leading-[16px] text-faint">{m.email}</span>}
                  </span>
                </span>
                <span className="flex flex-shrink-0 flex-wrap items-center gap-x-[20px] gap-y-[6px] pl-[40px] text-[13px] leading-[20px] sm:pl-0">
                  <span className={access === 'No access' ? 'text-faint' : 'text-zinc-300'}>{access}</span>
                  <span className="w-[76px] text-zinc-300">{ROLE_WORD[m.role]}</span>
                  {scoped &&
                    (m.hasAccess ? (
                      <KitButton size="sm" variant="ghost" loading={busy === m.userId} onClick={() => void setAccess(m.userId, false)}>
                        Remove
                      </KitButton>
                    ) : data.isPaid ? (
                      <KitButton size="sm" loading={busy === m.userId} onClick={() => void setAccess(m.userId, true)}>
                        Add to project
                      </KitButton>
                    ) : null)}
                </span>
              </div>
              {refusal?.userId === m.userId && <RefusedLine className="mt-[8px] pl-[40px]">{refusal.message}</RefusedLine>}
            </li>
          )
        })}
      </ul>
    )

  return (
    <Section
      id="access"
      title="Access"
      count={data?.hasOrg ? data.members.length : null}
      aside={
        canManage && team ? (
          <KitButtonLink href={`${team}/members`} size="sm">
            Manage members
          </KitButtonLink>
        ) : undefined
      }
    >
      <Panel>{body}</Panel>
      {data?.hasOrg && !data.isPaid && canManage && team && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
          Project-only access comes with Pro.{' '}
          <Link href={`${team}/billing`} className={LINK}>
            Upgrade to Pro
          </Link>
        </p>
      )}
    </Section>
  )
}

// ── Delete project ────────────────────────────────────────────────────────────

function DeleteProject({ project, role, onDeleted }: { project: Project; role: ProjectRoleState; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when the server asks for a sign-in from the last ten minutes first.
  const [reauth, setReauth] = useState<Reauthentication | null>(null)

  async function confirmDelete() {
    setDeleting(true)
    setError(null)
    setReauth(null)
    try {
      // The name the person typed; the dialog does not confirm until it matches.
      await deleteProject(project.id, project.name)
      onDeleted()
    } catch (err) {
      if (err instanceof DeleteRefusedError && err.code === 'REAUTH_REQUIRED' && err.reauth) setReauth(err.reauth)
      else setError(err instanceof Error ? err.message : 'Could not delete the project. Try again.')
      setDeleting(false)
    }
  }

  if (role.loading) return null
  return (
    <Section id="delete" title="Delete project">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[10px] px-[20px] py-[14px]">
          <p className="min-w-0 flex-[1_1_320px] text-[13px] leading-[20px] text-zinc-400">
            {role.canAdminister
              ? 'Deletes the database, users, files and history. You can’t undo this.'
              : 'Only an owner or admin can delete this project.'}
          </p>
          {role.canAdminister && (
            <KitButton
              variant="danger"
              onClick={() => {
                setError(null)
                setReauth(null)
                setOpen(true)
              }}
            >
              Delete project
            </KitButton>
          )}
        </div>
      </Panel>
      <KitConfirmDialog
        open={open}
        onCancel={() => {
          if (!deleting) setOpen(false)
        }}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        danger
        title={`Delete ${project.name}?`}
        description="Its database, users, files, functions and keys are deleted at once, and apps using its API stop working."
        undoable={false}
        requireText={project.name}
        confirmLabel="Delete project"
      >
        <p className="text-[13px] leading-[20px] text-zinc-400">
          <Link href={`/app/projects/${project.id}/connect?tab=postgres`} className={LINK}>
            Download a backup
          </Link>{' '}
          first if you might need its data.
        </p>
        {error && <RefusedLine className="mt-[10px]">{error}</RefusedLine>}
        {reauth && <SignInAgain reauth={reauth} onSignedIn={() => void confirmDelete()} />}
      </KitConfirmDialog>
    </Section>
  )
}
