/**
 * Client-side API helpers for audit logs
 */

const API_BASE = '/api'

export interface AuditLog {
  id: string
  action: string
  type: 'ui' | 'code' | 'auto'
  timestamp: string
  user?: string | null
  details?: string | null
  metadata?: any
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth-token')
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  }
}

export async function getAuditLogs(params?: {
  page?: number
  limit?: number
  type?: 'ui' | 'code' | 'auto'
}): Promise<{ logs: AuditLog[]; pagination: any }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', params.page.toString())
  if (params?.limit) searchParams.set('limit', params.limit.toString())
  if (params?.type) searchParams.set('type', params.type)
  
  const response = await fetch(`${API_BASE}/audit-logs?${searchParams}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch audit logs')
  }
  
  return await response.json()
}

