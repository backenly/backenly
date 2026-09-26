'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronRight,
  Clock,
  Database,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getProjects, deleteProject, type Project } from '@/lib/api/projects'
import { OrgShell } from '@/components/shell/OrgShell'
import { KitConfirmDialog } from '@/components/inspector/kit'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { HOSTING_REGION } from '@/lib/edition/hosting-region'

type UserProfile = { id: string; name?: string; email?: string }

let cachedProjects: Project[] | null = null
let cachedCurrentUser: UserProfile | null = null

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
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects || [])
  const [loading, setLoading] = useState(() => !cachedProjects)
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
          router.push('/auth/login?redirect=/app')
          return
        }
        cachedCurrentUser = currentUser
        setUser(currentUser)
        const fetchedProjects = await getProjects(currentUser.id)
        if (cancelled) return
        cachedProjects = fetchedProjects
        setProjects(fetchedProjects)
      } catch (error: any) {
        if (cancelled) return
        const message = error?.message?.toLowerCase() || ''
        if (message.includes('session') || message.includes('unauthorized')) {
          router.push('/auth/login?redirect=/app')
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
      // Off Cloud a 403 here is PROJECT_CREATION_UNSUPPORTED — architectural,
      // not a tier ceiling. "Your free plan" would be both wrong and an
      // upsell on a deployment with nothing to sell.
      setLimitError(
        errData.error ||
          (CLOUD_CONTROL_PLANE
            ? 'You have reached your project limit on the free plan.'
            : 'This deployment hosts one project. That is architectural, not a limit that can be lifted.')
      )
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
      setProjects((prev) => {
        const next = prev.filter((project) => project.id !== deleteTarget.id)
        cachedProjects = next
        return next
      })
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
        setProjects((prev) => {
          const next = prev.map((project) => (project.id === projectId ? { ...project, name: trimmed } : project))
          cachedProjects = next
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
  const visibleProjects = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects

  return (
    <OrgShell>
      {/* Full-bleed inside the org frame: the page owns the whole content area,
          top bar to bottom edge, so a one-project account reads as a dashboard
          rather than a card stranded at the top of an empty screen. */}
      {/* overflow-x-hidden prevents horizontal scroll bleed from drawer slide-in animations */}
      <main className="flex min-h-[calc(100vh-48px)] w-full flex-col overflow-x-hidden px-4 pb-24 sm:px-6 md:pb-10 lg:px-10">
        {/* ── Header ────────────────────────────────────────────────────── */}
        {/* pt-4 on mobile (tight), pt-10 on desktop — matches the shell's chrome rhythm */}
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-y-4 gap-x-6 pt-4 sm:pt-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-white">Projects</h1>
              {projects.length > 0 && (
                <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-400">
                  {projects.length}
                </span>
              )}
            </div>
            {/* Subtitle is implied by context on mobile — hide it to save vertical space */}
            <p className="mt-1 hidden sm:block text-[12.5px] sm:text-[13px] leading-5 text-zinc-500">
              Every backend on this account. Open one to manage its data, functions and autonomy.
            </p>
          </div>

          <div className="flex w-full items-center gap-3 sm:w-auto">
            <div className="relative w-full sm:w-[260px] md:w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search project"
                className="h-9 w-full rounded-lg border border-white/[0.07] bg-[#16171d] pl-9 pr-8 text-[16px] sm:text-[13px] text-zinc-50 outline-none transition-colors placeholder:text-zinc-600 ring-1 ring-white/[0.05] sm:ring-0 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* Desktop New project button */}
            {CLOUD_CONTROL_PLANE && (
              <button
                type="button"
                onClick={() => setShowNewModal(true)}
                className="hidden sm:inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200"
              >
                <Plus className="h-4 w-4" />
                New project
              </button>
            )}
          </div>
        </header>

        {/* ── Project grid ──────────────────────────────────────────────── */}
        <section className="mt-6 sm:mt-7 flex flex-1 flex-col">
          {loading ? (
            <div className="grid content-start gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex min-h-[160px] sm:min-h-[176px] flex-col rounded-xl border border-white/[0.07] bg-[#16171d] p-4 animate-pulse"
                >
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 shrink-0 rounded-lg bg-white/[0.05]" />
                    <div className="min-w-0 flex-1 space-y-2 pt-1">
                      <div className="h-4 w-3/5 rounded bg-white/[0.06]" />
                      <div className="h-3 w-2/5 rounded bg-white/[0.03]" />
                    </div>
                  </div>
                  <div className="mt-4 h-3 w-4/5 rounded bg-white/[0.03]" />
                  <div className="mt-auto flex items-center justify-between pt-4 border-t border-white/[0.04]">
                    <div className="h-3 w-16 rounded bg-white/[0.04]" />
                    <div className="h-3 w-12 rounded bg-white/[0.04]" />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleProjects.length > 0 ? (
            <div className="grid content-start gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
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
            /* Empty state — on mobile: no dashed border, radial glow + larger icon for emotional presence */
            <div className="flex flex-1 flex-col items-center justify-center sm:rounded-xl sm:border sm:border-dashed sm:border-white/[0.1] sm:bg-white/[0.02] px-6 py-16 text-center">
              {/* Radial glow sits behind the icon for a subtle brand-warmth halo */}
              <div className="relative flex items-center justify-center">
                <div aria-hidden className="pointer-events-none absolute h-24 w-24 rounded-full bg-violet-500/[0.05] blur-2xl" />
                <div className="relative flex h-14 w-14 items-center justify-center rounded-xl border border-white/[0.08] bg-gradient-to-br from-violet-500/[0.12] to-transparent">
                  <Database className="h-6 w-6 text-zinc-400" />
                </div>
              </div>
              {isEmpty ? (
                <>
                  <h3 className="mt-4 text-sm font-bold text-white">No projects yet</h3>
                  {CLOUD_CONTROL_PLANE ? (
                    <>
                      <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                        Create a project, then wire your coding agent to it from the project&apos;s
                        Connect page.
                      </p>
                      {/* Hidden on mobile — the FAB handles creation there */}
                      <button
                        type="button"
                        onClick={() => setShowNewModal(true)}
                        className="mt-4 hidden sm:inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200"
                      >
                        <Plus className="h-4 w-4" />
                        New project
                      </button>
                    </>
                  ) : (
                    <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                      This deployment provisions its one project with{' '}
                      <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[12px] text-zinc-300">npm run bootstrap</code>.
                      Run it, then reload this page.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3 className="mt-4 text-sm font-bold text-white">No matching projects</h3>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                    No project matches &quot;{searchQuery.trim()}&quot;.
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        {/* Mobile floating action button — safe-area bottom guard for iPhone home indicator */}
        {CLOUD_CONTROL_PLANE && !showNewModal && !limitError && !deleteTarget && (
          <button
            type="button"
            onClick={() => setShowNewModal(true)}
            style={{ bottom: 'max(24px, env(safe-area-inset-bottom, 24px))' }}
            className="fixed right-4 z-30 sm:hidden inline-flex items-center gap-2 rounded-full bg-white px-4 py-3 text-[13px] font-semibold text-black shadow-[0_12px_44px_-8px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.12)] border border-white/20 active:scale-95 transition-transform duration-100"
            aria-label="New project"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
            <span>New project</span>
          </button>
        )}
      </main>

      {/* New Project modal */}
      <AnimatePresence>
        {showNewModal && CLOUD_CONTROL_PLANE && (
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
      </AnimatePresence>

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
      <AnimatePresence>
        {limitError && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/70 backdrop-blur-sm sm:backdrop-blur-none"
              onClick={() => setLimitError(null)}
            />
            <motion.div
              initial={{ y: '100%', opacity: 0.6 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: '100%', opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 300 }}
              className="relative w-full sm:max-w-md overflow-hidden rounded-t-2xl sm:rounded-xl border-t sm:border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] pb-safe sm:pb-0"
            >
              {/* Mobile drag handle */}
              <div className="sm:hidden pt-2.5 pb-1 flex justify-center">
                <div className="h-1 w-10 rounded-full bg-white/20" />
              </div>
              <div className="border-b border-white/[0.06] px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-[13px] font-semibold text-zinc-100">Project limit reached</h3>
                    <p className="mt-1 text-[11.5px] text-zinc-500">Upgrade to create more backends.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLimitError(null)}
                    className="rounded-md p-1.5 sm:p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="p-5">
                <p className="text-[12.5px] leading-5 text-zinc-300">{limitError}</p>
                <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {CLOUD_CONTROL_PLANE && (
                    <button
                      type="button"
                      onClick={() => router.push('/app/billing')}
                      className="min-h-[44px] sm:min-h-0 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
                    >
                      Upgrade
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setLimitError(null)}
                    className="min-h-[44px] sm:min-h-0 rounded-lg border border-white/[0.08] px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm sm:backdrop-blur-none"
        onClick={() => !creating && onClose()}
      />
      <motion.div
        initial={{ y: '100%', opacity: 0.6 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="relative w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-xl border-t sm:border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] pb-safe sm:pb-0"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
        {/* Mobile drag handle */}
        <div className="sm:hidden pt-2.5 pb-1 flex justify-center">
          <div className="h-1 w-10 rounded-full bg-white/20" />
        </div>
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h3 className="text-[13px] font-semibold text-zinc-100">New project</h3>
          <button
            type="button"
            onClick={() => !creating && onClose()}
            className="rounded-md p-1.5 sm:p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
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
              className="h-10 sm:h-9 w-full rounded-lg border border-white/[0.07] bg-[#0f1015] px-3 text-[16px] sm:text-[13px] text-zinc-50 outline-none transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
            />
          </div>
          <p className="text-[11.5px] leading-5 text-zinc-500">
            Then wire your coding agent on the project&apos;s Connect page. Describe
            the backend in Claude Code or Cursor and it lands here.
          </p>

          {/* Honest region: the one region there is, no fake globe/selector */}
          <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-zinc-400">
              <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
              {HOSTING_REGION.short}
            </span>
            <span>Deployed to {HOSTING_REGION.label}, Backenly&apos;s single region.</span>
          </div>

          {error && (
            <p className="text-[11.5px] leading-5 text-rose-300">{error}</p>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <button
            type="button"
            onClick={() => !creating && onClose()}
            className="min-h-[44px] sm:min-h-0 rounded-lg border border-white/[0.08] px-4 py-2 text-[13px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => name.trim() && onCreate(name.trim())}
            disabled={!name.trim() || creating}
            className="min-h-[44px] sm:min-h-0 inline-flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-zinc-600"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create project
          </button>
        </div>
      </motion.div>
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
  // A paused project's API refuses every call, so its deploy status would
  // mislead. Monochrome on purpose: paused is a state, not an alarm.
  const status = project.pausedAt
    ? { label: 'Paused', dot: 'bg-zinc-500', text: 'text-zinc-400' }
    : getStatus((project as any).projectStatus)
  const updatedAt = (project as any).updatedAt
  const description = project.description?.trim() || 'No prompt saved for this backend yet.'

  // Mobile overflow menu state — replaces always-visible action buttons on small screens.
  // Desktop keeps its reveal-on-hover behaviour (opacity-0 group-hover:opacity-100) exactly as before.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileMenuRef = useRef<HTMLDivElement>(null)

  // Close the overflow tray on any touchstart outside it
  useEffect(() => {
    if (!mobileMenuOpen) return
    const handler = (e: TouchEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false)
      }
    }
    document.addEventListener('touchstart', handler, { passive: true })
    return () => document.removeEventListener('touchstart', handler)
  }, [mobileMenuOpen])

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
      className="group relative flex min-h-[160px] sm:min-h-[176px] cursor-pointer flex-col rounded-xl border border-white/[0.07] bg-[#16171d] p-4 text-left shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] outline-none transition-colors hover:border-white/[0.14] focus-visible:border-violet-400/40 focus-visible:ring-2 focus-visible:ring-violet-400/20"
    >
      {/* Subtle depth gradient — gives 3D lift on mobile where no hover effect exists */}
      <div aria-hidden className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-white/[0.015] to-transparent" />

      <div className="flex items-start gap-3">
        {/* Violet-tinted icon container — decorative brand warmth, not an interactive accent */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-gradient-to-br from-violet-500/[0.08] to-transparent">
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
              className="w-full rounded-md border border-white/[0.12] bg-white/[0.06] px-2.5 py-1 text-base sm:text-sm font-semibold text-white outline-none focus:border-violet-400/40"
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

        {/* ─── Desktop action buttons — reveal on group-hover, invisible on touch ─── */}
        <div className="hidden sm:flex shrink-0 items-center gap-1 opacity-0 sm:transition sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <ProjectIconButton label="Rename project" icon={Pencil} onClick={(e) => onStartRename(e, project)} />
          <ProjectIconButton label="Delete project" icon={Trash2} onClick={(e) => onDelete(e, project.id, project.name)} destructive />
        </div>

        {/* ─── Mobile overflow menu (⋯) — replaces always-visible buttons ─── */}
        <div className="relative sm:hidden" ref={mobileMenuRef}>
          <button
            type="button"
            aria-label="Project actions"
            onClick={(e) => { e.stopPropagation(); setMobileMenuOpen((o) => !o) }}
            onTouchStart={(e) => e.stopPropagation()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-500 transition active:bg-white/[0.08]"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {/* Inline action tray — positions below the ⋯ button, above card content */}
          <AnimatePresence>
            {mobileMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.95 }}
                transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                className="absolute right-0 top-full mt-1 z-50 min-w-[140px] overflow-hidden rounded-lg border border-white/[0.10] bg-[#1c1d23] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.9)]"
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(false); onStartRename(e, project) }}
                  onTouchStart={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-[13px] text-zinc-300 hover:bg-white/[0.05] hover:text-white transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5 text-zinc-500" />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(false); onDelete(e, project.id, project.name) }}
                  onTouchStart={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-[13px] text-rose-300 hover:bg-rose-500/[0.08] transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* 1-line clamp on mobile — descriptions are secondary on small screens */}
      <p className="mt-4 line-clamp-1 sm:line-clamp-2 min-h-[24px] sm:min-h-[40px] text-sm leading-6 text-zinc-400">{description}</p>

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
      onTouchStart={(e) => e.stopPropagation()}
      className={`inline-flex h-9 w-9 sm:h-8 sm:w-8 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] transition ${
        destructive
          ? 'text-zinc-500 hover:border-rose-400/30 hover:bg-rose-500/10 hover:text-rose-300 active:bg-rose-500/20'
          : 'text-zinc-500 hover:border-white/20 hover:bg-white/[0.06] hover:text-white active:bg-white/[0.1]'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}
