'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { forgetProjectReads, getProject, type Project } from '@/lib/api/projects'

/**
 * useProjectRole: what the signed-in person may do in this project, and which
 * team owns it.
 *
 * GET /api/projects/[id] answers it with the project (2026-11-16): `role`,
 * `canWrite` (DEVELOPER and above, the floor of every ordinary change),
 * `canAdminister` (ADMIN and above: keys, deletes, approvals, anything that
 * cannot be undone) and `organizationId`, all from the one resolution the
 * server's own permission checks make (lib/edition/guard.ts). Not
 * /api/projects/[id]/access: that route is Cloud-only, so a self-hosted build
 * would have no answer at all, and it reports the organization role rather
 * than the one the checks enforce.
 *
 * The console HIDES what a person cannot do and never disables it; a viewer
 * gets one sentence instead of controls. The server refuses on its own either
 * way: this only keeps the console from offering what would be refused.
 *
 * Read through getProject (lib/api/projects.ts), so the shell and the page
 * that reads the same project share one request and its cache. One answer per
 * project for the life of the page: a role rarely changes, and an old answer
 * can only show a control the server then refuses, or hide one until a reload.
 *
 *   loading  no answer yet. Both floors read false, so an action appears once
 *            it is allowed instead of flashing and vanishing.
 *   error    the project could not be read, or the answer named no role.
 *            Both floors stay false; the page shows its own load error. It is
 *            asked again when the window regains focus.
 */

export type ProjectRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'

export interface ProjectRoleState {
  /** Null until known, and when it could not be. */
  role: ProjectRole | null
  /** DEVELOPER and above: create and change things. */
  canWrite: boolean
  /** ADMIN and above: keys, deletes, approvals, anything that cannot be undone. */
  canAdminister: boolean
  /** The team that owns the project. Null on a self-hosted deployment, for a project made before teams, and until known. */
  organizationId: string | null
  loading: boolean
  error: boolean
}

const LOADING: ProjectRoleState = {
  role: null,
  canWrite: false,
  canAdminister: false,
  organizationId: null,
  loading: true,
  error: false,
}
const FAILED: ProjectRoleState = { ...LOADING, loading: false, error: true }
/** Asked with no project: there is nothing to be allowed. */
const NO_PROJECT: ProjectRoleState = { ...LOADING, loading: false }

const ROLES: ReadonlySet<string> = new Set<ProjectRole>(['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'])

/**
 * The role fields of a GET /api/projects/[id] answer. The floors are the
 * server's own booleans, never re-derived here, so the console cannot drift
 * from the checks; an answer that names no role grants nothing.
 */
export function parseProjectRole(project: Partial<Project> | null | undefined): ProjectRoleState {
  const role = typeof project?.role === 'string' && ROLES.has(project.role) ? (project.role as ProjectRole) : null
  if (!role) return FAILED
  return {
    role,
    canWrite: project?.canWrite === true,
    canAdminister: project?.canAdminister === true,
    organizationId: typeof project?.organizationId === 'string' && project.organizationId ? project.organizationId : null,
    loading: false,
    error: false,
  }
}

interface Entry {
  state: ProjectRoleState
  inflight: Promise<void> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function load(projectId: string, fresh: boolean): Promise<void> {
  const current = entries.get(projectId)
  if (current?.inflight) return current.inflight
  // Registered before the request starts, so a request that settles at once
  // replaces this entry instead of being overwritten by it.
  const pending: Entry = { state: current?.state ?? LOADING, inflight: null }
  entries.set(projectId, pending)
  pending.inflight = (async () => {
    let next: ProjectRoleState
    try {
      if (fresh) forgetProjectReads(projectId)
      next = parseProjectRole(await getProject(projectId))
    } catch {
      // A failed refresh keeps a good answer; with none, nothing is granted.
      next = pending.state.role ? pending.state : FAILED
    }
    entries.set(projectId, { state: next, inflight: null })
    listeners.forEach((l) => l())
  })()
  return pending.inflight
}

/** Ask the server again, past every kept answer. */
export function refreshProjectRole(projectId: string): Promise<void> {
  return load(projectId, true)
}

/** The answer as it stands, without asking for one. */
export function readProjectRole(projectId: string): ProjectRoleState {
  return entries.get(projectId)?.state ?? LOADING
}

/** Forget every answer. For tests, which share this module across cases. */
export function clearProjectRoleCache(): void {
  entries.clear()
  listeners.forEach((l) => l())
}

export function useProjectRole(projectId: string | null | undefined): ProjectRoleState {
  const state = useSyncExternalStore(
    subscribe,
    () => (projectId ? readProjectRole(projectId) : NO_PROJECT),
    () => LOADING,
  )

  useEffect(() => {
    if (!projectId) return
    const entry = entries.get(projectId)
    if (!entry || (!entry.inflight && entry.state.error)) void load(projectId, false)
    // A failed first read is asked again when the person comes back to the tab.
    const onFocus = () => {
      const now = entries.get(projectId)
      if (now && !now.inflight && now.state.error) void load(projectId, false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId])

  return state
}
