import { apiRequest } from './client'

export type SecurityIssueSeverity = 'high' | 'medium' | 'low'
export type SecurityIssueCategory = 'api_key' | 'password_policy' | 'cors' | 'encryption' | 'access_control' | 'other'
export type AttackType = 'sql_injection' | 'xss' | 'path_traversal' | 'command_injection' | 'other'
export type ScanType = 'configuration' | 'vulnerability' | 'compliance'
export type ScanStatus = 'running' | 'completed' | 'failed'

export interface SecurityIssue {
  id: string
  severity: SecurityIssueSeverity
  title: string
  description: string
  category: SecurityIssueCategory
  detectedAt: string
  fixed: boolean
  fixedAt?: string | null
  fixedBy?: string | null
  projectId?: string | null
  metadata?: any
  aiFixPreview?: {
    configChanges: string
    securityScoreImprovement: number
    estimatedTime: string
  }
  project?: {
    id: string
    name: string
  } | null
}

export interface BlockedAttack {
  id: string
  attackType: AttackType
  pattern: string
  endpoint?: string | null
  method?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  requestBody?: string | null
  blockedAt: string
  projectId?: string | null
  metadata?: any
  project?: {
    id: string
    name: string
  } | null
}

export interface SecurityScan {
  id: string
  scanType: ScanType
  status: ScanStatus
  startedAt: string
  completedAt?: string | null
  issuesFound: number
  score?: number | null
  projectId?: string | null
  metadata?: any
  error?: string | null
  project?: {
    id: string
    name: string
  } | null
}

export interface SecurityIssuesResponse {
  issues: SecurityIssue[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  stats: {
    total: number
    unfixed: number
    high: number
    medium: number
    low: number
  }
}

export interface BlockedAttacksResponse {
  attacks: BlockedAttack[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  stats: {
    total: number
    byType: Record<string, number>
  }
}

export interface SecurityScansResponse {
  scans: SecurityScan[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface SecurityStats {
  securityScore: number
  issues: {
    total: number
    unfixed: number
    bySeverity: {
      high: number
      medium: number
      low: number
    }
  }
  attacks: {
    total: number
    last24h: number
    byType: Record<string, number>
  }
  latestScan: {
    score: number | null
    issuesFound: number
    completedAt: string | null
  } | null
}

/**
 * Fetch security issues
 */
export async function getSecurityIssues(params: {
  page?: number
  limit?: number
  severity?: SecurityIssueSeverity | 'all'
  category?: string
  fixed?: boolean
  projectId?: string
} = {}): Promise<SecurityIssuesResponse> {
  const searchParams = new URLSearchParams()
  
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.severity && params.severity !== 'all') searchParams.set('severity', params.severity)
  if (params.category) searchParams.set('category', params.category)
  if (params.fixed !== undefined) searchParams.set('fixed', params.fixed.toString())
  if (params.projectId) searchParams.set('projectId', params.projectId)

  const url = `/api/security/issues${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  return apiRequest<SecurityIssuesResponse>(url)
}

/**
 * Update security issue
 */
export async function updateSecurityIssue(id: string, data: { fixed?: boolean }): Promise<SecurityIssue> {
  return apiRequest<SecurityIssue>(`/api/security/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/**
 * Delete security issue
 */
export async function deleteSecurityIssue(id: string): Promise<void> {
  await apiRequest(`/api/security/issues/${id}`, {
    method: 'DELETE',
  })
}

/**
 * Fetch blocked attacks
 */
export async function getBlockedAttacks(params: {
  page?: number
  limit?: number
  attackType?: AttackType
  projectId?: string
  startDate?: string
  endDate?: string
} = {}): Promise<BlockedAttacksResponse> {
  const searchParams = new URLSearchParams()
  
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.attackType) searchParams.set('attackType', params.attackType)
  if (params.projectId) searchParams.set('projectId', params.projectId)
  if (params.startDate) searchParams.set('startDate', params.startDate)
  if (params.endDate) searchParams.set('endDate', params.endDate)

  const url = `/api/security/attacks${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  return apiRequest<BlockedAttacksResponse>(url)
}

/**
 * Fetch security scans
 */
export async function getSecurityScans(params: {
  page?: number
  limit?: number
  scanType?: ScanType
  status?: ScanStatus
  projectId?: string
} = {}): Promise<SecurityScansResponse> {
  const searchParams = new URLSearchParams()
  
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.scanType) searchParams.set('scanType', params.scanType)
  if (params.status) searchParams.set('status', params.status)
  if (params.projectId) searchParams.set('projectId', params.projectId)

  const url = `/api/security/scans${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  return apiRequest<SecurityScansResponse>(url)
}

/**
 * Create security scan
 */
export async function createSecurityScan(data: {
  scanType: ScanType
  projectId?: string
}): Promise<SecurityScan> {
  return apiRequest<SecurityScan>('/api/security/scans', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Fetch security stats
 */
export async function getSecurityStats(projectId?: string): Promise<SecurityStats> {
  const searchParams = new URLSearchParams()
  if (projectId) searchParams.set('projectId', projectId)

  const url = `/api/security/stats${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  return apiRequest<SecurityStats>(url)
}

