// Client-side API helpers for Workspaces

export interface Workspace {
  id: string
  name: string
  description?: string | null
  projectId: string
  userId: string
  environment: 'development' | 'staging' | 'production'
  apiBaseUrl?: string | null
  status: 'active' | 'paused' | 'archived'
  totalFiles: number
  totalRoutes: number
  totalFunctions: number
  lastActivity?: Date | null
  createdAt: Date
  updatedAt: Date
  project?: {
    id: string
    name: string
    environment: string
    apiUrlDev?: string | null
    apiUrlStaging?: string | null
    apiUrlProd?: string | null
  }
}

export interface CreateWorkspaceData {
  name: string
  description?: string
  projectId: string
  userId: string
  environment?: 'development' | 'staging' | 'production'
  apiBaseUrl?: string
  status?: 'active' | 'paused' | 'archived'
}

export interface UpdateWorkspaceData {
  name?: string
  description?: string | null
  environment?: 'development' | 'staging' | 'production'
  apiBaseUrl?: string | null
  status?: 'active' | 'paused' | 'archived'
  totalFiles?: number
  totalRoutes?: number
  totalFunctions?: number
}

export async function getWorkspaces(projectId?: string, userId?: string): Promise<Workspace[]> {
  const params = new URLSearchParams()
  if (projectId) params.append('projectId', projectId)
  if (userId) params.append('userId', userId)
  const url = `/api/workspaces${params.toString() ? `?${params.toString()}` : ''}`
  const response = await fetch(url)
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch workspaces')
  return data.data
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const response = await fetch(`/api/workspaces/${id}`)
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch workspace')
  return data.data
}

export async function createWorkspace(workspaceData: CreateWorkspaceData): Promise<Workspace> {
  const response = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspaceData),
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to create workspace')
  return data.data
}

export async function updateWorkspace(id: string, workspaceData: UpdateWorkspaceData): Promise<Workspace> {
  const response = await fetch(`/api/workspaces/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspaceData),
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to update workspace')
  return data.data
}

export async function deleteWorkspace(id: string): Promise<void> {
  const response = await fetch(`/api/workspaces/${id}`, {
    method: 'DELETE',
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to delete workspace')
}

