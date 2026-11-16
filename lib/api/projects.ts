// Client-side API helpers for Projects

export interface Project {
  id: string
  name: string
  description?: string | null
  userId: string
  projectStatus?: 'PRIVATE' | 'DEPLOYING' | 'LIVE' | 'FAILED'
  deployedAt?: Date | string | null
  environment: 'development' | 'staging' | 'production'
  apiUrlDev?: string | null
  apiUrlStaging?: string | null
  apiUrlProd?: string | null
  apiRequests: number
  avgLatency: number
  errorCount: number
  storageUsed: number
  storageLimit: number // P0: Storage quota limit
  maxFileSize: number // P0: Max individual file size
  maxFilesPerBucket: number // P1: Max files per bucket limit
  activeUsers: number
  lastMetricsUpdate?: Date | null
  createdAt: Date
  updatedAt: Date
  /** Set while the project is paused for inactivity. Never set on a self-hosted deployment. */
  pausedAt?: Date | string | null
  /** The Backenly Cloud region holding the project's data (lib/regions.ts). Null is the home region. */
  region?: string | null
  /**
   * When the project was last really used: runtime traffic, an MCP call, a
   * dashboard write, opening its console (lib/projects/activity.ts). Stamped at
   * most once an hour, so it is "within the last hour" at its finest. Null
   * until it has been used.
   */
  lastActivityAt?: Date | string | null
  /**
   * The team that owns the project (Backenly Cloud), on the list and on the
   * single read. Null on a self-hosted deployment and for a project made before
   * teams existed.
   */
  organizationId?: string | null
  /**
   * The caller's authority here, on GET /api/projects/[id] only (the list does
   * not carry it): the role the server's own permission checks resolve, and
   * the two floors they hold work to (lib/edition/guard.ts). Read it through
   * useProjectRole (lib/hooks/useProjectRole.ts).
   */
  role?: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'
  /** DEVELOPER and above: ordinary changes. */
  canWrite?: boolean
  /** ADMIN and above: keys, deletes, approvals, anything that cannot be undone. */
  canAdminister?: boolean
  /**
   * Set when the project was moved in from another platform (components/migrate):
   * where it came from, when, what matched, and how many access rules still
   * wait for a person's approval.
   */
  importedFrom?: {
    source: 'supabase' | 'firebase' | 'postgres'
    at: string
    tables: number
    rows: number
    users?: number
    files?: number
    rulesPending: number
  } | null
  /**
   * `{origin}/api/v1/{id}` in the project's region (lib/data-plane/regional.ts
   * regionApiOrigin). Null when the server has no API address for that region.
   */
  apiBaseUrl?: string | null
  metrics?: {
    totalFunctions: number
    totalTables: number
    totalWorkspaces: number
    apiRequests: number
    avgLatency: number
    errorCount: number
    storageUsed: number
    activeUsers: number
    lastMetricsUpdate?: Date | null
  }
}

export interface CreateProjectData {
  name: string
  description?: string
  environment?: 'development' | 'staging' | 'production'
  apiUrlDev?: string
  apiUrlStaging?: string
  apiUrlProd?: string
  userId: string
}

export interface UpdateProjectData {
  name?: string
  description?: string | null
  environment?: 'development' | 'staging' | 'production'
  apiUrlDev?: string | null
  apiUrlStaging?: string | null
  apiUrlProd?: string | null
}

// Memory cache for project lists, one entry per organization filter, so one
// team's list can never be served for another's.
const listCache = new Map<string, { data: Project[]; time: number }>()
const PROJECTS_CACHE_TTL = 30000 // 30 seconds

const projectCache = new Map<string, { data: Project; time: number }>()
const PROJECT_CACHE_TTL = 30000 // 30 seconds
// The shell (useProjectRole) and the page under it ask for the same project as
// the page mounts: the second ask joins the first request instead of sending
// its own.
const projectInFlight = new Map<string, Promise<Project>>()

/**
 * Forget kept answers, so the next read asks the server: one project's, or
 * with no id every one (the lists too). After a change these reads would
 * otherwise serve stale for 30 s, and tests share this module across cases.
 */
export function forgetProjectReads(id?: string): void {
  if (id) {
    projectCache.delete(id)
    projectInFlight.delete(id)
    return
  }
  listCache.clear()
  projectCache.clear()
  projectInFlight.clear()
}

export async function getProjects(userId?: string, options: { orgId?: string | null } = {}): Promise<Project[]> {
  const now = Date.now()
  const key = options.orgId ?? ''
  const cached = listCache.get(key)
  if (cached && (now - cached.time < PROJECTS_CACHE_TTL)) {
    return cached.data
  }

  const params = new URLSearchParams()
  if (userId) params.set('userId', userId)
  if (options.orgId) params.set('orgId', options.orgId)
  const query = params.toString()
  const response = await fetch(query ? `/api/projects?${query}` : '/api/projects', { credentials: 'include' })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch projects')

  listCache.set(key, { data: data.data, time: now })
  return data.data
}

export async function getProject(id: string): Promise<Project> {
  const now = Date.now()
  const cached = projectCache.get(id)
  if (cached && (now - cached.time < PROJECT_CACHE_TTL)) {
    return cached.data
  }
  const pending = projectInFlight.get(id)
  if (pending) return pending

  const request = (async () => {
    const response = await fetch(`/api/projects/${id}`, { credentials: 'include' })
    const data = await response.json()
    if (!data.success) throw new Error(data.error || 'Failed to fetch project')
    projectCache.set(id, { data: data.data, time: Date.now() })
    return data.data as Project
  })()
  projectInFlight.set(id, request)
  try {
    return await request
  } finally {
    if (projectInFlight.get(id) === request) projectInFlight.delete(id)
  }
}

export async function createProject(projectData: CreateProjectData): Promise<Project> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectData),
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to create project')
  return data.data
}

export async function updateProject(id: string, projectData: UpdateProjectData): Promise<Project> {
  const response = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectData),
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to update project')
  return data.data
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${id}`, {
    method: 'DELETE',
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to delete project')
  
  // Invalidate cache
  listCache.clear()
  projectCache.delete(id)
}

