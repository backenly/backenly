'use client'

/**
 * Project Settings — first-class page (IA restructure §6.15).
 *
 * The Control Hub deleted the old project-settings page; in a single-sidebar
 * world it earns its slot back at the bottom of the sidebar. Three tabs:
 *
 *   • General  — name / description, environment info (API base URL, project
 *     id), and the danger zone (delete). Restores real, editable settings.
 *   • API Keys — THE one key-management surface (ClientKeysPanel). Connect →
 *     Direct links here instead of duplicating the manager.
 *   • Access   — who can open this project. Project access is org membership
 *     (lib/auth/project-access.ts), so this shows the live org roster and
 *     points to /app/members for management — read here, manage there.
 *
 * API Keys embeds a self-headed panel; General and Access render kit content
 * under the page's single header + tab strip. Deep-linkable via ?tab=keys|access.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Settings, SlidersHorizontal, KeyRound, Users, Copy, Check, Loader2, Trash2, AlertTriangle, Crown, UserPlus, FolderLock, Lock, Plus, X } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { getProject, updateProject, deleteProject, type Project } from '@/lib/api/projects'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import {
  KitTabs, KitTab, KitCard, KitCardHeader, KitCardBody, KitButton, KitField, KitInput, KitPage, KitBadge, KitNote,
} from '@/components/inspector/kit'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'

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
    if (t === 'keys' || t === 'access') setTab(t)
  }, [])

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col text-white">
      <InspectorPageHeader
        icon={Settings}
        title="Settings"
        description="Project identity, API keys, and access. Every change here is scoped to this project only."
        badge={{ label: 'Managed', variant: 'managed' }}
      />

      <div className="px-8 pt-4">
        <KitTabs>
          <KitTab active={tab === 'general'} onClick={() => setTab('general')}>
            <SlidersHorizontal className="w-3.5 h-3.5" />
            General
          </KitTab>
          <KitTab active={tab === 'keys'} onClick={() => setTab('keys')}>
            <KeyRound className="w-3.5 h-3.5" />
            API Keys
          </KitTab>
          <KitTab active={tab === 'access'} onClick={() => setTab('access')}>
            <Users className="w-3.5 h-3.5" />
            Access
          </KitTab>
        </KitTabs>
      </div>

      <div className="flex-1">
        {tab === 'general' && <GeneralTab projectId={projectId} onDeleted={() => router.push('/app')} />}
        {tab === 'keys' && <ClientKeysPanel />}
        {tab === 'access' && <AccessTab projectId={projectId} />}
      </div>
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
  const [copied, setCopied] = useState<string | null>(null)

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

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* clipboard blocked — non-fatal */ }
  }

  const apiBaseUrl = project?.apiUrlProd || project?.apiUrlStaging || project?.apiUrlDev || '—'

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
      <KitPage>
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      </KitPage>
    )
  }

  return (
    <KitPage>
      <div className="max-w-2xl space-y-4">
        {/* Identity */}
        <KitCard>
          <KitCardHeader title="Project" description="How this project is named across the workspace and receipts." />
          <KitCardBody className="space-y-4">
            <KitField label="Name">
              <KitInput value={name} onChange={(e) => setName(e.target.value)} placeholder="My backend" />
            </KitField>
            <KitField label="Description" hint="Optional. Shown on the project card.">
              <KitInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this backend powers" />
            </KitField>
            <div className="flex items-center gap-3 pt-1">
              <KitButton variant="primary" onClick={save} disabled={!dirty || !name.trim() || saving} icon={saving ? Loader2 : undefined}>
                {saving ? 'Saving…' : 'Save changes'}
              </KitButton>
              {saved && (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-300">
                  <Check className="w-3.5 h-3.5" /> Saved
                </span>
              )}
              {saveError && <span className="text-[12px] text-rose-300">{saveError}</span>}
            </div>
          </KitCardBody>
        </KitCard>

        {/* Environment / connection info */}
        <KitCard>
          <KitCardHeader title="Connection" description="Point your agent or app at this backend." />
          <KitCardBody className="space-y-3">
            <InfoRow label="Project ID" value={projectId} onCopy={() => copy(projectId, 'id')} copied={copied === 'id'} />
            <InfoRow label="API base URL" value={apiBaseUrl} onCopy={() => copy(apiBaseUrl, 'url')} copied={copied === 'url'} disabled={apiBaseUrl === '—'} />
            <InfoRow label="Region" value="EU · Hetzner" mono={false} />
          </KitCardBody>
        </KitCard>

        {/* Danger zone */}
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.03] overflow-hidden">
          <div className="px-4 py-3 border-b border-rose-500/15 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span className="text-[12.5px] font-semibold text-rose-200">Danger zone</span>
          </div>
          <div className="px-4 py-4 space-y-3">
            <p className="text-[12.5px] text-zinc-400 leading-5">
              Deleting a project permanently removes its schema, tables, users, storage, and every receipt. This
              cannot be undone. Type <span className="font-mono text-zinc-200">{project?.name}</span> to confirm.
            </p>
            <div className="flex items-center gap-2">
              <KitInput
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                placeholder={project?.name ?? 'project name'}
                className="flex-1 focus:border-rose-400/40 focus:ring-rose-400/15"
              />
              <KitButton
                variant="danger"
                onClick={confirmDelete}
                disabled={deleteText !== (project?.name ?? '') || deleting}
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete project
              </KitButton>
            </div>
            {deleteError && <p className="text-[12px] text-rose-300">{deleteError}</p>}
          </div>
        </div>
      </div>
    </KitPage>
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
      <KitPage>
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading access…
        </div>
      </KitPage>
    )
  }

  const canManage = !!data?.canManage
  const scopedCount = data?.members.filter((m) => m.restricted).length ?? 0

  return (
    <KitPage>
      <div className="max-w-2xl space-y-4">
        <KitCard>
          <KitCardHeader
            title="Who can open this project"
            description={
              scopedCount > 0
                ? 'Org-wide members can open every project. Project-scoped members only see the projects granted to them. Grant or revoke this project below.'
                : 'Everyone in your organization can open this project. To limit someone to specific projects, set them to project-scoped on the Members page (Pro).'
            }
            actions={
              <KitButton variant="secondary" icon={UserPlus} onClick={() => router.push('/app/members')}>
                Manage members
              </KitButton>
            }
          />
          <KitCardBody>
            {!data || data.members.length === 0 ? (
              <p className="text-[12.5px] text-zinc-500 py-2">
                {data && !data.hasOrg
                  ? 'This is a solo project; only you can open it. Invite teammates from the Members page to share access.'
                  : "Couldn't load your organization roster. Manage people and roles on the Members page."}
              </p>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {data.members.map((m) => {
                  const orgWide = !m.restricted || m.isOwner || m.role === 'ADMIN'
                  return (
                    <div key={m.userId} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] text-zinc-100 truncate">{m.name || m.email}</span>
                          {m.isOwner && <Crown className="w-3 h-3 text-amber-400/80 flex-shrink-0" />}
                          {m.userId === data.me?.userId && <span className="text-[11px] text-zinc-500">(you)</span>}
                        </div>
                        {m.name && <p className="text-[11.5px] text-zinc-500 truncate">{m.email}</p>}
                      </div>
                      <div className="flex items-center gap-2.5 flex-shrink-0">
                        {/* Access state */}
                        {orgWide ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                            <Check className="w-3 h-3 text-emerald-400/80" /> Full access
                          </span>
                        ) : m.hasAccess ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-violet-300">
                            <FolderLock className="w-3 h-3" /> This project
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-600">No access</span>
                        )}

                        {/* Grant / revoke for scoped members (owners/admins only) */}
                        {canManage && m.restricted && !m.isOwner && m.role !== 'ADMIN' && (
                          m.hasAccess ? (
                            <button
                              onClick={() => setAccess(m.userId, false)}
                              disabled={busy === m.userId}
                              className="inline-flex h-6 items-center gap-1 rounded-md border border-white/10 px-2 text-[11px] text-zinc-400 hover:border-rose-400/30 hover:text-rose-300 disabled:opacity-50"
                            >
                              {busy === m.userId ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />} Remove
                            </button>
                          ) : (
                            <button
                              onClick={() => data.isPaid ? setAccess(m.userId, true) : router.push('/app/billing')}
                              disabled={busy === m.userId}
                              className="inline-flex h-6 items-center gap-1 rounded-md border border-white/[0.14] bg-white/[0.06] px-2 text-[11px] text-violet-200 hover:border-white/25 disabled:opacity-50"
                            >
                              {busy === m.userId ? <Loader2 className="w-3 h-3 animate-spin" /> : data.isPaid ? <Plus className="w-3 h-3" /> : <Lock className="w-3 h-3" />} Add to project
                            </button>
                          )
                        )}

                        <KitBadge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</KitBadge>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {err && <p className="mt-3 text-[12px] text-rose-300">{err}</p>}
          </KitCardBody>
        </KitCard>

        {data?.hasOrg && !data.isPaid && (
          <KitNote icon={Lock}>
            Project-scoped access, limiting a teammate to specific projects, is a Pro feature.{' '}
            <button onClick={() => router.push('/app/billing')} className="text-violet-300 hover:text-violet-200 underline underline-offset-2">Upgrade</button> to enable it.
          </KitNote>
        )}
      </div>
    </KitPage>
  )
}

function InfoRow({
  label, value, onCopy, copied, mono = true, disabled = false,
}: {
  label: string; value: string; onCopy?: () => void; copied?: boolean; mono?: boolean; disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-zinc-500 flex-shrink-0">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-[12px] text-zinc-200 truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
        {onCopy && (
          <button
            onClick={onCopy}
            disabled={disabled}
            className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-200 disabled:opacity-30 transition-colors"
            aria-label={`Copy ${label}`}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  )
}
