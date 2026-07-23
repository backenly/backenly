'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronRight,
  Clock,
  Database,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getProjects, deleteProject, type Project } from '@/lib/api/projects'
import { OrgShell } from '@/components/shell/OrgShell'
import { AgentSetupCard } from '@/components/connect/AgentSetupCard'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import { KitConfirmDialog } from '@/components/inspector/kit'

type UserProfile = { id: string; name?: string; email?: string }

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
  const now = new Date()
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function getStatus(status?: string) {
  if (status === 'LIVE') return { label: 'Live', dot: 'bg-emerald-400', text: 'text-emerald-300' }
  if (status === 'DEPLOYING') return { label: 'Deploying', dot: 'bg-amber-300 animate-pulse', text: 'text-amber-500' }
  if (status === 'FAILED') return { label: 'Failed', dot: 'bg-rose-400', text: 'text-rose-300' }
  return { label: 'Draft', dot: 'bg-zinc-500', text: 'text-zinc-400' }
}

export default function DashboardPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<UserProfile | null>(null)
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
    const fetchProjects = async () => {
      try {
        const currentUser = await getCurrentUser()
        if (!currentUser) {
          router.push('/auth/login?redirect=/app')
          return
        }
        setUser(currentUser)
        const fetchedProjects = await getProjects(currentUser.id)
        setProjects(fetchedProjects)
      } catch (error: any) {
        const message = error?.message?.toLowerCase() || ''
        if (message.includes('session') || message.includes('unauthorized')) {
          router.push('/auth/login?redirect=/app')
        }
      } finally {
        setLoading(false)
      }
    }
    fetchProjects()
  }, [router])

  // Creates the project, then opens its workspace. Building happens through
  // the user's coding agent over MCP (Connect) once the workspace is open.
  const createProject = async (name: string): Promise<string | null> => {
    if (!user) return null
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, userId: user.id }),
    })
    if (response.status === 401) {
      router.push('/auth/login?redirect=/app')
      return null
    }
    if (response.status === 403) {
      const errData = await response.json().catch(() => ({}))
      setLimitError(errData.error || 'You have reached your project limit on the free plan.')
      return null
    }
    if (!response.ok) throw new Error('Failed to create project')
    const data = await response.json()
    return data.project?.id || data.data?.id || data.id || null
  }

  const handleDeleteProject = (
    e: React.MouseEvent | React.KeyboardEvent,
    projectId: string,
    projectName: string,
  ) => {
    e.stopPropagation()
    setDeleteError(null)
    setDeleteTarget({ id: projectId, name: projectName })
  }

  const confirmDeleteProject = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteProject(deleteTarget.id)
      setProjects((prev) => prev.filter((project) => project.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch {
      setDeleteError('Failed to delete the project. Please try again.')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleStartRename = (e: React.MouseEvent | React.KeyboardEvent, project: Project) => {
    e.stopPropagation()
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
        setProjects((prev) =>
          prev.map((project) => (project.id === projectId ? { ...project, name: trimmed } : project)),
        )
      }
    } catch {
      // Keep the previous name if the request fails.
    } finally {
      setEditingProjectId(null)
    }
  }

  if (loading) return <GlobalLoading />

  const isEmpty = projects.length === 0
  const query = searchQuery.trim().toLowerCase()
  const visibleProjects = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects

  return (
    <OrgShell>
      <main className="mx-auto w-full max-w-[1180px] px-6 pb-16 lg:px-10">
        {/* ── Projects ──────────────────────────────────────────────────── */}
        <section className="pt-10">
          <h1 className="text-[1.75rem] font-semibold tracking-tight text-white">Projects</h1>

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search project"
                className="h-9 w-full rounded-lg border border-white/[0.07] bg-[#16171d] pl-9 pr-3 text-[13px] text-zinc-50 outline-none transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              New project
            </button>
          </div>

          <div className="mt-6">
            {visibleProjects.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(280px,360px))]">
                {visibleProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    editingProjectId={editingProjectId}
                    editingName={editingName}
                    editInputRef={editInputRef}
                    onOpen={() => router.push(`/app/projects/${project.id}`)}
                    onStartRename={handleStartRename}
                    onRenameChange={setEditingName}
                    onRenameSubmit={handleRenameSubmit}
                    onCancelRename={() => setEditingProjectId(null)}
                    onDelete={handleDeleteProject}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.1] bg-white/[0.02] px-6 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
                  <Database className="h-5 w-5 text-zinc-400" />
                </div>
                {isEmpty ? (
                  <>
                    <h3 className="mt-4 text-sm font-semibold text-white">No projects yet</h3>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                      Create your first project to get started.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowNewModal(true)}
                      className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200"
                    >
                      <Plus className="h-4 w-4" />
                      New project
                    </button>
                  </>
                ) : (
                  <>
                    <h3 className="mt-4 text-sm font-semibold text-white">No matching projects</h3>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                      No project matches "{searchQuery.trim()}".
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Connect your coding agent (empty / new accounts) ──────────── */}
        {isEmpty && (
          <section className="mt-8">
            <AgentSetupCard />
          </section>
        )}
      </main>

      {/* New Project modal */}
      {showNewModal && (
        <NewProjectModal
          creating={creating}
          error={createError}
          onClose={() => { setShowNewModal(false); setCreateError(null) }}
          onCreate={async (name) => {
            setCreating(true)
            setCreateError(null)
            try {
              const id = await createProject(name)
              if (id) {
                router.push(`/app/projects/${id}`)
              }
              setShowNewModal(false)
            } catch {
              setCreateError('Something went wrong creating the project. Please try again.')
            } finally {
              setCreating(false)
            }
          }}
        />
      )}

      {/* Delete confirmation — kit dialog, never window.confirm */}
      <KitConfirmDialog
        open={!!deleteTarget}
        onCancel={() => { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(null) } }}
        onConfirm={confirmDeleteProject}
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
        description="The project's backend, tables and data are removed. This cannot be undone."
        confirmLabel="Delete project"
        danger
        busy={deleteBusy}
      >
        {deleteError && (
          <p className="text-[11.5px] leading-5 text-rose-300">{deleteError}</p>
        )}
      </KitConfirmDialog>

      {/* Plan-limit modal */}
      {limitError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setLimitError(null)} />
          <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-[13px] font-semibold text-zinc-100">Project limit reached</h3>
                  <p className="mt-1 text-[11.5px] text-zinc-500">Upgrade to create more backends.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setLimitError(null)}
                  className="rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="p-5">
              <p className="text-[12.5px] leading-5 text-zinc-300">{limitError}</p>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => router.push('/app/billing')}
                  className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
                >
                  Upgrade
                </button>
                <button
                  type="button"
                  onClick={() => setLimitError(null)}
                  className="rounded-lg border border-white/[0.08] px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </OrgShell>
  )
}

// ─── New Project modal ────────────────────────────────────────────────────────

function NewProjectModal({
  creating,
  error,
  onClose,
  onCreate,
}: {
  creating: boolean
  error?: string | null
  onClose: () => void
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={() => !creating && onClose()} />
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h3 className="text-[13px] font-semibold text-zinc-100">New project</h3>
          <button
            type="button"
            onClick={() => !creating && onClose()}
            className="rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium tracking-tight text-zinc-400">Project name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Movie Reviews"
              autoFocus
              maxLength={100}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()) }}
              className="h-9 w-full rounded-lg border border-white/[0.07] bg-[#0f1015] px-3 text-[13px] text-zinc-50 outline-none transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
            />
          </div>
          <p className="text-[11.5px] leading-5 text-zinc-500">
            Then wire your coding agent on the project&apos;s Connect page. Describe
            the backend in Claude Code or Cursor and it lands here.
          </p>

          {/* Honest region: one Hetzner region, no fake globe/selector */}
          <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-zinc-400">
              <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
              EU · Hetzner
            </span>
            <span>Deployed to Backenly's single region.</span>
          </div>

          {error && (
            <p className="text-[11.5px] leading-5 text-rose-300">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <button
            type="button"
            onClick={() => !creating && onClose()}
            className="rounded-lg border border-white/[0.08] px-4 py-2 text-[13px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => name.trim() && onCreate(name.trim())}
            disabled={!name.trim() || creating}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-zinc-600"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create project
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Project card ─────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  editingProjectId,
  editingName,
  editInputRef,
  onOpen,
  onStartRename,
  onRenameChange,
  onRenameSubmit,
  onCancelRename,
  onDelete,
}: {
  project: Project
  editingProjectId: string | null
  editingName: string
  editInputRef: React.RefObject<HTMLInputElement>
  onOpen: () => void
  onStartRename: (e: React.MouseEvent | React.KeyboardEvent, project: Project) => void
  onRenameChange: (name: string) => void
  onRenameSubmit: (projectId: string) => void
  onCancelRename: () => void
  onDelete: (e: React.MouseEvent | React.KeyboardEvent, projectId: string, projectName: string) => void
}) {
  const status = getStatus((project as any).projectStatus)
  const updatedAt = (project as any).updatedAt
  const description = project.description?.trim() || 'No prompt saved for this backend yet.'

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group flex min-h-[176px] cursor-pointer flex-col rounded-xl border border-white/[0.07] bg-[#16171d] p-4 text-left shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] outline-none transition-colors hover:border-white/[0.14] focus-visible:border-violet-400/40 focus-visible:ring-2 focus-visible:ring-violet-400/20"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
          <Database className="h-4 w-4 text-zinc-400" />
        </div>

        <div className="min-w-0 flex-1">
          {editingProjectId === project.id ? (
            <input
              ref={editInputRef}
              value={editingName}
              onChange={(e) => onRenameChange(e.target.value)}
              onBlur={() => onRenameSubmit(project.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameSubmit(project.id)
                if (e.key === 'Escape') onCancelRename()
                e.stopPropagation()
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded-md border border-white/[0.12] bg-white/[0.06] px-2.5 py-1 text-sm font-semibold text-white outline-none focus:border-violet-400/40"
              maxLength={100}
              autoFocus
            />
          ) : (
            <h3 className="line-clamp-2 text-base font-semibold leading-snug text-white">{project.name}</h3>
          )}
          <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">
            {project.environment || 'development'} workspace
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <ProjectIconButton label="Rename project" icon={Pencil} onClick={(e) => onStartRename(e, project)} />
          <ProjectIconButton label="Delete project" icon={Trash2} onClick={(e) => onDelete(e, project.id, project.name)} destructive />
        </div>
      </div>

      <p className="mt-4 line-clamp-2 min-h-[40px] text-sm leading-6 text-zinc-400">{description}</p>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
        <div className="inline-flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          <span className={`font-mono text-[11px] font-medium ${status.text}`}>{status.label}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-zinc-500">
          {updatedAt && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
              <Clock className="h-3.5 w-3.5" />
              {timeAgo(updatedAt)}
            </span>
          )}
          <ChevronRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
        </div>
      </div>
    </article>
  )
}

function ProjectIconButton({
  label,
  icon: Icon,
  onClick,
  destructive = false,
}: {
  label: string
  icon: LucideIcon
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] transition ${
        destructive
          ? 'text-zinc-500 hover:border-rose-400/30 hover:bg-rose-500/10 hover:text-rose-300'
          : 'text-zinc-500 hover:border-white/20 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}
