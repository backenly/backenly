import { fetchWithTimeout } from '@/lib/utils/fetchWithTimeout'

export type LogType = 'api' | 'auth' | 'database' | 'function' | 'system' | 'all'
export type LogSeverity = 'error' | 'warning' | 'info' | 'debug' | 'all'

export interface Log {
  id: string
  type: LogType
  severity: LogSeverity
  message: string
  service?: string | null
  endpoint?: string | null
  method?: string | null
  statusCode?: number | null
  userId?: string | null
  projectId?: string | null
  metadata?: any
  stackTrace?: string | null
  duration?: number | null
  timestamp: string
  createdAt: string
  project?: {
    id: string
    name: string
  } | null
}

export interface LogsResponse {
  logs: Log[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  stats: {
    total: number
    error: number
    warning: number
    info: number
    debug: number
  }
}

export interface LogsQueryParams {
  page?: number
  limit?: number
  type?: LogType
  severity?: LogSeverity
  service?: string
  search?: string
  startDate?: string
  endDate?: string
  projectId?: string
}

/**
 * Fetch logs with filters
 */
export async function getLogs(params: LogsQueryParams = {}): Promise<LogsResponse> {
  const searchParams = new URLSearchParams()
  
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.type && params.type !== 'all') searchParams.set('type', params.type)
  if (params.severity && params.severity !== 'all') searchParams.set('severity', params.severity)
  if (params.service) searchParams.set('service', params.service)
  if (params.search) searchParams.set('search', params.search)
  if (params.startDate) searchParams.set('startDate', params.startDate)
  if (params.endDate) searchParams.set('endDate', params.endDate)
  if (params.projectId) searchParams.set('projectId', params.projectId)

  const url = `/api/logs${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const response = await fetchWithTimeout(url)
  if (!response.ok) {
    throw new Error('Failed to fetch logs')
  }
  return response.json()
}

