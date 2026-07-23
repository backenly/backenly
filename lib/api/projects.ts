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
  apiRequests?: number
  avgLatency?: number
  errorCount?: number
  storageUsed?: number
  activeUsers?: number
}

// Memory cache for projects
let cachedProjects: Project[] | null = null
let cachedProjectsTime = 0
const PROJECTS_CACHE_TTL = 30000 // 30 seconds

const projectCache = new Map<string, { data: Project; time: number }>()
const PROJECT_CACHE_TTL = 30000 // 30 seconds

export async function getProjects(userId?: string): Promise<Project[]> {
  const now = Date.now()
  if (cachedProjects && (now - cachedProjectsTime < PROJECTS_CACHE_TTL)) {
    return cachedProjects
  }

  const url = userId ? `/api/projects?userId=${userId}` : '/api/projects'
  const response = await fetch(url, { credentials: 'include' })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch projects')
  
  cachedProjects = data.data
  cachedProjectsTime = now
  return data.data
}

export async function getProject(id: string): Promise<Project> {
  const now = Date.now()
  const cached = projectCache.get(id)
  if (cached && (now - cached.time < PROJECT_CACHE_TTL)) {
    return cached.data
  }

  const response = await fetch(`/api/projects/${id}`, { credentials: 'include' })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch project')
  
  projectCache.set(id, { data: data.data, time: now })
  return data.data
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
  cachedProjects = null
  projectCache.delete(id)
}

