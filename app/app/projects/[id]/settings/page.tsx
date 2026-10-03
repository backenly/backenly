'use client'

/**
 * Project Settings — first-class page (IA restructure §6.15).
 *
 * Three tabs:
 *
 *   • General  — name / description, connection facts (project id, API base
 *     URL, where it runs), and the danger zone (delete).
 *   • API Keys — THE one key-management surface (ClientKeysPanel). Connect →
 *     Direct links here instead of duplicating the manager.
 *   • Access   — who can open this project. Project access is org membership
 *     (lib/auth/project-access.ts), so this shows the live org roster and
 *     points to /app/members for management — read here, manage there.
 *
 * Deep-linkable via ?tab=keys|access. Settings are cards of one concern each:
 * title, sentence, control, and a footer holding the hint and the action.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { SlidersHorizontal, KeyRound, Users, Check, Trash2, Crown, UserPlus, FolderLock, Lock, Plus, X } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { getProject, updateProject, deleteProject, type Project } from '@/lib/api/projects'
import {
  CopyField,
  DetailList,
  DetailRow,
  KitBadge,
  KitButton,
  KitInput,
  KitNote,
  KitTab,
  KitTabs,
  PageHeader,
  SettingsCard,
  Skeleton,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

type Tab = 'general' | 'keys' | 'access'

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string
  const [tab, setTab] = useState<Tab>('general')

  // Deep link: /settings?tab=keys|access (used by Connect → Direct). Read after
  // mount — useSearchParams would need a Suspense boundary at export time.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'keys' || (t === 'access' && CLOUD_CONTROL_PLANE)) setTab(t)
  }, [])

  // Keep the URL in step with the tab, so a refresh or a shared link lands on
  // the same tab. replaceState: switching tabs is not navigation.
  const selectTab = (next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'general') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(null, '', url.toString())
  }

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="pb-16">
      <PageHeader
        title="Settings"
        description="Project identity, API keys and access. Every change here is scoped to this project."
        tabs={
          <KitTabs>
            <KitTab active={tab === 'general'} onClick={() => selectTab('general')}>
              <SlidersHorizontal />
              General
            </KitTab>
            <KitTab active={tab === 'keys'} onClick={() => selectTab('keys')}>
              <KeyRound />
              API keys
            </KitTab>
            {/* Access is team management, and a team is an organization. Both the
                page and the API behind it are Cloud control plane, so a public
                build has no roster to show and no route to ask. */}
            {CLOUD_CONTROL_PLANE && (
              <KitTab active={tab === 'access'} onClick={() => selectTab('access')}>
                <Users />
                Access
              </KitTab>
            )}
          </KitTabs>
        }
      />

      {tab === 'general' && <GeneralTab projectId={projectId} onDeleted={() => router.push('/app')} />}
      {tab === 'keys' && <ClientKeysPanel />}
      {tab === 'access' && CLOUD_CONTROL_PLANE && <AccessTab projectId={projectId} />}
    </div>
  )
}

/** The settings column: one readable width, left-aligned under the header. */
function SettingsColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-6`}>
      <div className="max-w-[760px] space-y-5">{children}</div>
    </div>
  )
}

// ── General ──────────────────────────────────────────────────────────────────

function GeneralTab({ projectId, onDeleted }: { projectId: string; onDeleted: () => void }) {
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [deleteText, setDeleteText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const p = await getProject(projectId)
      setProject(p)
      setName(p.name ?? '')
      setDescription(p.description ?? '')
    } catch {
      /* handled by empty state */
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { if (projectId) load() }, [projectId, load])

  const dirty = project ? name.trim() !== (project.name ?? '') || (description ?? '') !== (project.description ?? '') : false

  const save = async () => {
    if (!dirty || !name.trim()) return
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const updated = await updateProject(projectId, { name: name.trim(), description: description.trim() || null })
      setProject(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save changes. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const apiBaseUrl = project?.apiUrlProd || project?.apiUrlStaging || project?.apiUrlDev || null

  const confirmDelete = async () => {
    if (deleteText !== (project?.name ?? '')) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteProject(projectId)
      onDeleted()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the project. Try again.')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <SettingsColumn>
        <Skeleton className="h-[236px] w-full rounded-[10px]" />
        <Skeleton className="h-[180px] w-full rounded-[10px]" />
      </SettingsColumn>
    )
  }

  return (
    <SettingsColumn>
      {/* Identity */}
      <SettingsCard
        title="Project"
        description="How this project is named across the console, the project list and every receipt."
        onSubmit={save}
        footer={
          saveError ? (
            <span role="alert" className="text-rose-300">{saveError}</span>
          ) : saved ? (
            <span aria-live="polite" className="inline-flex items-center gap-1.5 text-emerald-300">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : (
            'The description is optional. It shows on the project card.'
          )
        }
        actions={
          <KitButton type="submit" variant="primary" loading={saving} disabled={!dirty || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </KitButton>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">Name</span>
            <KitInput
              name="project-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="orbit-commerce"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">Description</span>
            <KitInput
              name="project-description"
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this backend powers…"
            />
          </label>
        </div>
      </SettingsCard>

      {/* Connection facts */}
      <SettingsCard title="Connection" description="The coordinates your agent or app uses to reach this backend.">
        <DetailList>
          <DetailRow label="Project ID">
            <CopyField value={projectId} />
          </DetailRow>
          <DetailRow label="API base URL">
            {apiBaseUrl ? (
              <CopyField value={apiBaseUrl} />
            ) : (
              <span className="text-zinc-500">Set when the project is first published</span>
            )}
          </DetailRow>
          <DetailRow label="Runs on">
            {/* Honest per edition: Cloud runs one AWS region today; a
                self-hosted deployment runs wherever its operator put it. */}
            {CLOUD_CONTROL_PLANE ? 'Backenly Cloud, AWS ap-south-1' : 'This self-hosted deployment'}
          </DetailRow>
        </DetailList>
      </SettingsCard>

      {/* Danger zone */}
      <SettingsCard
        danger
        title="Delete project"
        description={
          <>
            Permanently removes this project’s schema, tables, users, storage and every receipt. This cannot be
            undone. Type <code className="font-mono text-zinc-200">{project?.name}</code> to confirm.
          </>
        }
        onSubmit={confirmDelete}
        footer={deleteError ? <span role="alert" className="text-rose-300">{deleteError}</span> : 'Deletion is immediate and final.'}
        actions={
          <KitButton
            type="submit"
            variant="danger"
            icon={Trash2}
            loading={deleting}
            disabled={deleteText !== (project?.name ?? '')}
          >
            Delete project
          </KitButton>
        }
      >
        <label className="block max-w-[420px]">
          <span className="sr-only">Project name to confirm deletion</span>
          <KitInput
            name="confirm-project-name"
            autoComplete="off"
            spellCheck={false}
            value={deleteText}
            onChange={(e) => setDeleteText(e.target.value)}
            placeholder={project?.name ?? 'project name'}
            className="focus:border-rose-400/50 focus:ring-rose-400/15"
          />
        </label>
      </SettingsCard>
    </SettingsColumn>
  )
}

// ── Access ───────────────────────────────────────────────────────────────────
// Project access is organization membership (lib/auth/project-access.ts): the
// owner plus every org member can open this project — UNLESS a member is
// project-scoped (Pro+), in which case they only see the projects granted to
// them. This tab shows who can open THIS project and lets owners/admins grant or
// revoke scoped members. Org-wide access (owner/admin/unrestricted) is managed
// on the Members page (/app/members).

type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'
interface AccessMember {
  userId: string; name: string | null; email: string; role: OrgRole
  isOwner: boolean; restricted: boolean; hasAccess: boolean
}
interface ProjectAccessData {
  hasOrg: boolean
  canManage: boolean
  isPaid: boolean
  me?: { userId: string; role: OrgRole }
  members: AccessMember[]
}

const ROLE_LABEL: Record<OrgRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', DEVELOPER: 'Developer', VIEWER: 'Viewer' }
const ROLE_TONE: Record<OrgRole, 'beta' | 'operational' | 'managed' | 'neutral'> = {
  OWNER: 'beta',
  ADMIN: 'operational',
  DEVELOPER: 'managed',
  VIEWER: 'neutral',
}

function AccessTab({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [data, setData] = useState<ProjectAccessData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // userId being granted/revoked
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/access`, { credentials: 'include' })
      const j = await res.json()
      if (j?.success) setData(j.data)
    } catch { /* handled by empty state */ } finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { if (projectId) load() }, [projectId, load])

  const setAccess = async (userId: string, grant: boolean) => {
    setBusy(userId)
    setErr(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/access`, {
        method: grant ? 'POST' : 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.success) await load()
      else setErr(j.error ?? 'Could not update access.')
    } catch {
      setErr('Network error. Try again.')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <SettingsColumn>
        <Skeleton className="h-[260px] w-full rounded-[10px]" />
      </SettingsColumn>
    )
  }

  const canManage = !!data?.canManage
  const scopedCount = data?.members.filter((m) => m.restricted).length ?? 0

  return (
    <SettingsColumn>
      <SettingsCard
        title="Who can open this project"
        description={
          scopedCount > 0
            ? 'Org-wide members can open every project. Project-scoped members only see the projects granted to them. Grant or revoke this project below.'
            : 'Everyone in your organization can open this project. To limit someone to specific projects, set them to project-scoped on the Members page (Pro).'
        }
        footer={err ? <span role="alert" className="text-rose-300">{err}</span> : 'Roles and invitations are managed on the Members page.'}
        actions={
          <KitButton variant="secondary" icon={UserPlus} onClick={() => router.push('/app/members')}>
            Manage members
          </KitButton>
        }
      >
        {!data || data.members.length === 0 ? (
          <p className="text-[13px] text-zinc-500">
            {data && !data.hasOrg
              ? 'This is a solo project; only you can open it. Invite teammates from the Members page to share access.'
              : "Couldn't load your organization roster. Manage people and roles on the Members page."}
          </p>
        ) : (
          <ul className="-mx-5 divide-y divide-white/[0.06] border-y border-white/[0.06] sm:-mx-6">
            {data.members.map((m) => {
              const orgWide = !m.restricted || m.isOwner || m.role === 'ADMIN'
              return (
                <li key={m.userId} className="flex flex-col justify-between gap-2.5 px-5 py-3 sm:flex-row sm:items-center sm:px-6">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-zinc-100">{m.name || m.email}</span>
                      {m.isOwner && <Crown className="h-3.5 w-3.5 flex-shrink-0 text-amber-300/80" aria-label="Owner" />}
                      {m.userId === data.me?.userId && <span className="text-[12px] text-zinc-500">(you)</span>}
                    </div>
                    {m.name && <p className="truncate text-[12px] text-zinc-500">{m.email}</p>}
                  </div>
                  <div className="flex flex-shrink-0 flex-wrap items-center gap-2.5">
                    {orgWide ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-zinc-400">
                        <Check className="h-3.5 w-3.5 text-emerald-400/80" /> Full access
                      </span>
                    ) : m.hasAccess ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-violet-200">
                        <FolderLock className="h-3.5 w-3.5" /> This project
                      </span>
                    ) : (
                      <span className="text-[12px] text-zinc-600">No access</span>
                    )}

                    {/* Grant / revoke for scoped members (owners/admins only) */}
                    {canManage && m.restricted && !m.isOwner && m.role !== 'ADMIN' && (
                      m.hasAccess ? (
                        <KitButton size="sm" variant="ghost" icon={X} loading={busy === m.userId} onClick={() => setAccess(m.userId, false)}>
                          Remove
                        </KitButton>
                      ) : (
                        <KitButton
                          size="sm"
                          variant="secondary"
                          icon={data.isPaid ? Plus : Lock}
                          loading={busy === m.userId}
                          onClick={() => (data.isPaid ? setAccess(m.userId, true) : router.push('/app/billing'))}
                        >
                          Add to project
                        </KitButton>
                      )
                    )}

                    <KitBadge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</KitBadge>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>

      {data?.hasOrg && !data.isPaid && (
        <KitNote icon={Lock}>
          Project-scoped access, limiting a teammate to specific projects, is a Pro feature.{' '}
          <button
            type="button"
            onClick={() => router.push('/app/billing')}
            className="font-medium text-violet-300 underline underline-offset-2 hover:text-violet-200"
          >
            Upgrade
          </button>{' '}
          to enable it.
        </KitNote>
      )}
    </SettingsColumn>
  )
}
