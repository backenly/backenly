'use client'

/**
 * Members (/app/members) — IA restructure §5.3, now LIVE.
 *
 * Real team management on the organization model: the members table, role
 * management, and email invites with pending-invite handling. Owner/Admin can
 * invite + remove + change roles; everyone can see the roster. Flat kit.
 *
 * Project-scoped access (Pro+): a Developer/Viewer can be limited to specific
 * projects — org-wide by default, but the team leader can restrict them so they
 * never see the org's other projects. Owners/Admins are always org-wide. The
 * capability is gated to paid plans; the picker shows a Pro lock on Free.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Crown, UserPlus, Users, X, Loader2, FolderLock, Lock, Check, ChevronDown } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { SectionTitle, KitCard, KitNote } from '@/components/inspector/kit'

type Role = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'
interface ProjectLite { id: string; name: string }
interface Member { userId: string; name: string | null; email: string; role: Role; isOwner: boolean; restricted: boolean; projectIds: string[] }
interface Invite { id: string; email: string; role: Role; expiresAt: string; restricted: boolean; scopedProjectIds: string[] }
interface OrgData {
  org: { id: string; name: string; plan: string; isPaid: boolean }
  me: { userId: string; role: Role }
  members: Member[]
  invites: Invite[]
  projects: ProjectLite[]
}

const ROLE_RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, DEVELOPER: 1, VIEWER: 0 }
const ROLE_LABEL: Record<Role, string> = { OWNER: 'Owner', ADMIN: 'Admin', DEVELOPER: 'Developer', VIEWER: 'Viewer' }
// Only Developer/Viewer can be project-scoped — Owner/Admin are always org-wide.
const canScopeRole = (r: Role) => r === 'DEVELOPER' || r === 'VIEWER'

export default function MembersPage() {
  const router = useRouter()
  const [data, setData] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('DEVELOPER')
  const [inviteScopeIds, setInviteScopeIds] = useState<string[] | null>(null) // null = all projects
  const [inviting, setInviting] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // userId whose access is being edited

  const load = useCallback(async () => {
    const res = await fetch('/api/org/members', { credentials: 'include' })
    if (res.status === 401) { router.push('/auth/login?redirect=/app/members'); return }
    const j = await res.json().catch(() => null)
    if (j?.success) setData(j.data)
    setLoading(false)
  }, [router])

  useEffect(() => { load() }, [load])

  const canManage = data ? ROLE_RANK[data.me.role] >= ROLE_RANK.ADMIN : false
  const isPaid = data?.org.isPaid ?? false
  const projects = data?.projects ?? []
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  // Scoped invites are only offered for Developer/Viewer on a paid plan.
  const inviteScopeAllowed = isPaid && canScopeRole(role) && projects.length > 0
  useEffect(() => { if (!inviteScopeAllowed) setInviteScopeIds(null) }, [inviteScopeAllowed])

  const invite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || inviting) return
    const restricted = inviteScopeAllowed && inviteScopeIds !== null
    if (restricted && (inviteScopeIds?.length ?? 0) === 0) {
      setNotice({ tone: 'err', text: 'Pick at least one project, or switch to all projects.' })
      return
    }
    setInviting(true)
    setNotice(null)
    try {
      const res = await fetch('/api/org/invites', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role, restricted, projectIds: restricted ? inviteScopeIds : undefined }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.success) {
        setNotice({ tone: 'ok', text: `Invite sent to ${j.data.email}${restricted ? `, scoped to ${inviteScopeIds!.length} project${inviteScopeIds!.length === 1 ? '' : 's'}` : ''}.` })
        setEmail('')
        setInviteScopeIds(null)
        await load()
      } else {
        setNotice({ tone: 'err', text: j.error ?? 'Could not send invite.' })
      }
    } catch {
      setNotice({ tone: 'err', text: 'Network error. Try again.' })
    } finally {
      setInviting(false)
    }
  }

  const revoke = async (id: string) => {
    await fetch(`/api/org/invites/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    await load()
  }

  const remove = async (userId: string) => {
    await fetch(`/api/org/members/${userId}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    await load()
  }

  const changeRole = async (userId: string, newRole: Role) => {
    await fetch(`/api/org/members/${userId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    }).catch(() => {})
    await load()
  }

  const saveScope = async (userId: string, restricted: boolean, projectIds: string[]) => {
    const res = await fetch(`/api/org/members/${userId}/scope`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restricted, projectIds }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.success) {
      setEditing(null)
      await load()
    } else {
      setNotice({ tone: 'err', text: j.error ?? 'Could not update access.' })
    }
  }

  return (
    <OrgShell>
      <div className="mx-auto w-full max-w-[960px] px-6 py-8 lg:px-10">
        <SectionTitle
          title="Members"
          description={data ? `${data.org.name} · ${data.members.length} member${data.members.length === 1 ? '' : 's'}` : 'Who can access this organization’s projects.'}
        />

        {/* Invite form (owner/admin only) */}
        {canManage && (
          <KitCard className="px-4 py-4">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
              <UserPlus className="h-3 w-3" /> Invite a teammate
            </div>
            <form onSubmit={invite} className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/30 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="rounded-md border border-white/[0.08] bg-[#1c1d23] px-2.5 py-2 text-[13px] text-zinc-200 focus:outline-none"
              >
                <option value="ADMIN">Admin</option>
                <option value="DEVELOPER">Developer</option>
                <option value="VIEWER">Viewer</option>
              </select>
              <button
                type="submit"
                disabled={inviting || !email.trim()}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-white px-3.5 text-[12.5px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
              >
                {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                Send invite
              </button>
            </form>

            {/* Scoped-invite control — Developer/Viewer only */}
            {canScopeRole(role) && (
              <div className="mt-2.5 border-t border-white/[0.05] pt-2.5">
                {!isPaid ? (
                  <p className="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
                    <Lock className="h-3 w-3 text-zinc-500" />
                    Limiting a teammate to specific projects is a <span className="text-zinc-300">Pro</span> feature.
                    <button type="button" onClick={() => router.push('/app/billing')} className="text-violet-300 hover:text-violet-200 underline underline-offset-2">Upgrade</button>
                  </p>
                ) : projects.length === 0 ? null : (
                  <>
                    <div className="flex items-center gap-4 text-[12px]">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-300">
                        <input type="radio" checked={inviteScopeIds === null} onChange={() => setInviteScopeIds(null)} className="accent-violet-500" />
                        All projects
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-300">
                        <input type="radio" checked={inviteScopeIds !== null} onChange={() => setInviteScopeIds([])} className="accent-violet-500" />
                        <FolderLock className="h-3 w-3 text-violet-300" /> Specific projects
                      </label>
                    </div>
                    {inviteScopeIds !== null && (
                      <ProjectChecklist
                        projects={projects}
                        selected={inviteScopeIds}
                        onChange={setInviteScopeIds}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {notice && (
              <p className={`mt-2 text-[12px] ${notice.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{notice.text}</p>
            )}
          </KitCard>
        )}

        {/* Members table */}
        <div className="mt-3">
          <KitCard>
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Member</span>
              <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Access · Role</span>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              (data?.members ?? []).map((m) => {
                const scoped = m.restricted && canScopeRole(m.role)
                const accessLabel = scoped
                  ? `${m.projectIds.length} project${m.projectIds.length === 1 ? '' : 's'}`
                  : 'All projects'
                const showAccessEditor = canManage && !m.isOwner && canScopeRole(m.role)
                return (
                  <div key={m.userId} className="border-b border-white/[0.04] last:border-b-0">
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold text-zinc-100 ring-1 ring-white/[0.12]">
                        {(m.name || m.email)[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-zinc-100">{m.name ?? m.email.split('@')[0]}</p>
                        <p className="truncate text-[11.5px] text-zinc-500">{m.email}</p>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        {/* Access chip / editor toggle */}
                        {showAccessEditor ? (
                          <button
                            onClick={() => setEditing(editing === m.userId ? null : m.userId)}
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${scoped ? 'border-white/[0.14] bg-white/[0.06] text-violet-200 hover:border-white/25' : 'border-white/[0.08] text-zinc-400 hover:border-white/20 hover:text-zinc-200'}`}
                          >
                            {scoped ? <FolderLock className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                            {accessLabel}
                            <ChevronDown className={`h-3 w-3 transition-transform ${editing === m.userId ? 'rotate-180' : ''}`} />
                          </button>
                        ) : (
                          <span className="font-mono text-[10.5px] text-zinc-500">All projects</span>
                        )}

                        {m.isOwner ? (
                          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-violet-300">
                            <Crown className="h-3 w-3" /> Owner
                          </span>
                        ) : canManage ? (
                          <>
                            <select
                              value={m.role}
                              onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                              className="rounded-md border border-white/[0.08] bg-[#1c1d23] px-2 py-1 text-[11.5px] text-zinc-200 focus:outline-none"
                            >
                              <option value="ADMIN">Admin</option>
                              <option value="DEVELOPER">Developer</option>
                              <option value="VIEWER">Viewer</option>
                            </select>
                            <button
                              onClick={() => remove(m.userId)}
                              title="Remove member"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-rose-500/[0.08] hover:text-rose-300"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <span className="font-mono text-[10.5px] text-zinc-400">{ROLE_LABEL[m.role]}</span>
                        )}
                      </div>
                    </div>

                    {/* Inline access editor */}
                    {showAccessEditor && editing === m.userId && (
                      <AccessEditor
                        member={m}
                        projects={projects}
                        isPaid={isPaid}
                        onCancel={() => setEditing(null)}
                        onSave={(restricted, ids) => saveScope(m.userId, restricted, ids)}
                        onUpgrade={() => router.push('/app/billing')}
                      />
                    )}
                  </div>
                )
              })
            )}
          </KitCard>
        </div>

        {/* Pending invites */}
        {(data?.invites?.length ?? 0) > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Pending invites</p>
            <KitCard>
              {data!.invites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3 border-b border-white/[0.04] px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-zinc-200">{inv.email}</p>
                    <p className="text-[11px] text-zinc-600">
                      Invited as {ROLE_LABEL[inv.role].toLowerCase()}
                      {inv.restricted ? ` · ${inv.scopedProjectIds.length} project${inv.scopedProjectIds.length === 1 ? '' : 's'}` : ''}
                      {' '}· expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => revoke(inv.id)}
                      className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-white/10 px-2.5 text-[11.5px] text-zinc-400 hover:border-white/20 hover:text-zinc-100"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </KitCard>
          </div>
        )}

        <div className="mt-5">
          <KitNote icon={Users} tone="info" title="How teams work">
            Everyone you invite can access this organization’s projects with the role you assign: Admins manage members,
            Developers build and operate, Viewers read only. On Pro you can also limit a Developer or Viewer to specific
            projects, so they never see the rest. Your plan and billing apply across the whole team.
          </KitNote>
        </div>
      </div>
    </OrgShell>
  )
}

// ── Inline access editor ──────────────────────────────────────────────────────

function AccessEditor({
  member, projects, isPaid, onCancel, onSave, onUpgrade,
}: {
  member: Member
  projects: ProjectLite[]
  isPaid: boolean
  onCancel: () => void
  onSave: (restricted: boolean, projectIds: string[]) => void
  onUpgrade: () => void
}) {
  const [restricted, setRestricted] = useState(member.restricted)
  const [selected, setSelected] = useState<string[]>(member.projectIds)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (restricted && selected.length === 0) return
    setSaving(true)
    await onSave(restricted, restricted ? selected : [])
    setSaving(false)
  }

  return (
    <div className="border-t border-white/[0.05] bg-black/20 px-4 py-3.5">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Project access</p>
      <div className="flex items-center gap-4 text-[12.5px]">
        <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-300">
          <input type="radio" checked={!restricted} onChange={() => setRestricted(false)} className="accent-violet-500" />
          All projects
        </label>
        <label className={`inline-flex items-center gap-1.5 ${isPaid ? 'cursor-pointer text-zinc-300' : 'cursor-not-allowed text-zinc-600'}`}>
          <input type="radio" checked={restricted} disabled={!isPaid} onChange={() => setRestricted(true)} className="accent-violet-500" />
          <FolderLock className="h-3 w-3 text-violet-300" /> Specific projects
          {!isPaid && <span className="ml-1 rounded bg-white/[0.06] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400">Pro</span>}
        </label>
      </div>

      {!isPaid && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-zinc-500">
          <Lock className="h-3 w-3" /> Limiting members to specific projects is a Pro feature.
          <button onClick={onUpgrade} className="text-violet-300 hover:text-violet-200 underline underline-offset-2">Upgrade</button>
        </p>
      )}

      {restricted && isPaid && (
        <>
          {projects.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-zinc-500">No projects in this organization yet.</p>
          ) : (
            <ProjectChecklist projects={projects} selected={selected} onChange={setSelected} />
          )}
        </>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving || (restricted && selected.length === 0)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save access
        </button>
        <button onClick={onCancel} className="inline-flex h-8 items-center rounded-md border border-white/10 px-3 text-[12px] text-zinc-400 hover:border-white/20 hover:text-zinc-100">
          Cancel
        </button>
      </div>
    </div>
  )
}

function ProjectChecklist({
  projects, selected, onChange,
}: {
  projects: ProjectLite[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  return (
    <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-white/[0.07] bg-black/20 p-1.5">
      {projects.map((p) => {
        const on = selected.includes(p.id)
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => toggle(p.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-zinc-300 hover:bg-white/[0.04]"
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded border ${on ? 'border-violet-400 bg-violet-500' : 'border-white/20'}`}>
              {on && <Check className="h-3 w-3 text-white" />}
            </span>
            <span className="truncate">{p.name}</span>
          </button>
        )
      })}
    </div>
  )
}
