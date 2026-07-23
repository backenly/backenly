/**
 * Client-side API helpers for monitoring
 */

import { apiRequest } from './client'

const API_BASE = '/api/monitoring'
const FETCH_TIMEOUT = 8000 // 8 seconds

// Helper function for fetch with timeout
function fetchWithTimeout(url: string, options: RequestInit = {}, timeout: number = FETCH_TIMEOUT): Promise<Response> {
  return Promise.race([
    fetch(url, options),
    new Promise<Response>((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), timeout)
    )
  ])
}

export interface DataPoint {
  timestamp: number
  value: number
}

export interface MetricStats {
  responseTime: { value: number; change: number; status: 'healthy' | 'warning' | 'critical' }
  uptime: { value: number; change: number; status: 'healthy' | 'warning' | 'critical' }
  errors: { value: number; change: number; status: 'healthy' | 'warning' | 'critical' }
  requests: { value: number; change: number; status: 'healthy' | 'warning' | 'critical' }
}

export interface Anomaly {
  id: string
  type: 'spike' | 'drop' | 'error'
  metric: string
  timestamp: string
  value: number
  expectedValue: number
  deviation: number
  explanation?: string
  status: 'detected' | 'acknowledged' | 'resolved'
}

export interface Incident {
  id: string
  title: string
  description: string
  severity: 'critical' | 'warning' | 'info'
  status: 'active' | 'resolved' | 'acknowledged'
  startedAt: string
  resolvedAt?: string
  acknowledgedAt?: string
  affectedServices: string[]
  project?: { id: string; name: string }
  acknowledgedBy?: { id: string; email: string; name: string | null }
}

export interface PerformanceBreakdown {
  endpoint?: string
  function?: string
  database?: string
  requests: number
  avgResponseTime: number
  errorRate: number
  p95: number
  p99: number
}

/**
 * Get metrics data for charts
 */
export async function getMetrics(
  type: 'responseTime' | 'requestVolume' | 'errorRate' | 'uptime',
  timeRange: '1h' | '24h' | '7d' | '30d' = '24h',
  source?: 'api' | 'function' | 'database',
  sourceId?: string,
  projectId?: string
): Promise<DataPoint[]> {
  const params = new URLSearchParams({
    type,
    timeRange,
  })

  if (source) params.append('source', source)
  if (sourceId) params.append('sourceId', sourceId)
  if (projectId) params.append('projectId', projectId)

  const url = `${API_BASE}/metrics${params.toString() ? `?${params.toString()}` : ''}`
  const result = await apiRequest<{ data: DataPoint[] }>(url)
  return result.data || []
}

/**
 * Get aggregated stats
 */
export async function getStats(
  timeRange: '1h' | '24h' | '7d' | '30d' = '24h',
  projectId?: string
): Promise<MetricStats> {
  const params = new URLSearchParams({ timeRange })
  if (projectId) params.append('projectId', projectId)

  const response = await fetchWithTimeout(`${API_BASE}/stats?${params}`, {}, FETCH_TIMEOUT)
  if (!response.ok) {
    throw new Error('Failed to fetch stats')
  }

  const result = await response.json()
  return result.data
}

/**
 * Get recent anomalies
 */
export async function getAnomalies(
  limit: number = 10,
  projectId?: string,
  status?: 'detected' | 'acknowledged' | 'resolved'
): Promise<Anomaly[]> {
  const params = new URLSearchParams({ limit: limit.toString() })
  if (projectId) params.append('projectId', projectId)
  if (status) params.append('status', status)

  const response = await fetchWithTimeout(`${API_BASE}/anomalies?${params}`, {}, FETCH_TIMEOUT)
  if (!response.ok) {
    throw new Error('Failed to fetch anomalies')
  }

  const result = await response.json()
  return result.data || []
}

/**
 * Trigger anomaly detection
 */
export async function detectAnomalies(
  timeRange: '1h' | '24h' | '7d' | '30d' = '24h',
  projectId?: string
): Promise<{ detected: number; anomalies: Anomaly[] }> {
  const response = await fetchWithTimeout(`${API_BASE}/anomalies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeRange, projectId }),
  })

  if (!response.ok) {
    throw new Error('Failed to detect anomalies')
  }

  const result = await response.json()
  return result.data
}

/**
 * Acknowledge an anomaly
 */
export async function acknowledgeAnomaly(anomalyId: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/anomalies/${anomalyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'acknowledge' }),
  }, FETCH_TIMEOUT)

  if (!response.ok) {
    throw new Error('Failed to acknowledge anomaly')
  }
}

/**
 * Resolve an anomaly
 */
export async function resolveAnomaly(anomalyId: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/anomalies/${anomalyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve' }),
  }, FETCH_TIMEOUT)

  if (!response.ok) {
    throw new Error('Failed to resolve anomaly')
  }
}

/**
 * Get incidents
 */
export async function getIncidents(
  projectId?: string,
  status?: 'active' | 'resolved' | 'acknowledged',
  severity?: 'critical' | 'warning' | 'info',
  limit: number = 50
): Promise<Incident[]> {
  const params = new URLSearchParams({ limit: limit.toString() })
  if (projectId) params.append('projectId', projectId)
  if (status) params.append('status', status)
  if (severity) params.append('severity', severity)

  const response = await fetchWithTimeout(`${API_BASE}/incidents?${params}`, {}, FETCH_TIMEOUT)
  if (!response.ok) {
    throw new Error('Failed to fetch incidents')
  }

  const result = await response.json()
  return result.data || []
}

/**
 * Get active incidents
 */
export async function getActiveIncidents(projectId?: string): Promise<Incident[]> {
  return getIncidents(projectId, 'active')
}

/**
 * Create an incident
 */
export async function createIncident(data: {
  title: string
  description: string
  severity: 'critical' | 'warning' | 'info'
  affectedServices: string[]
  projectId?: string
  metadata?: Record<string, any>
}): Promise<string> {
  const response = await fetchWithTimeout(`${API_BASE}/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    throw new Error('Failed to create incident')
  }

  const result = await response.json()
  return result.data.id
}

/**
 * Update an incident
 */
export async function updateIncident(
  incidentId: string,
  data: {
    title?: string
    description?: string
    severity?: 'critical' | 'warning' | 'info'
    status?: 'active' | 'resolved' | 'acknowledged'
    affectedServices?: string[]
    metadata?: Record<string, any>
  }
): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/incidents/${incidentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, FETCH_TIMEOUT)

  if (!response.ok) {
    throw new Error('Failed to update incident')
  }
}

/**
 * Acknowledge an incident
 */
export async function acknowledgeIncident(incidentId: string, userId: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/incidents/${incidentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'acknowledge', userId }),
  }, FETCH_TIMEOUT)

  if (!response.ok) {
    throw new Error('Failed to acknowledge incident')
  }
}

/**
 * Resolve an incident
 */
export async function resolveIncident(incidentId: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/incidents/${incidentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve' }),
  }, FETCH_TIMEOUT)

  if (!response.ok) {
    throw new Error('Failed to resolve incident')
  }
}

/**
 * Get performance breakdown
 */
export async function getPerformanceBreakdown(
  timeRange: '1h' | '24h' | '7d' | '30d' = '24h',
  source: 'api' | 'function' | 'database',
  projectId?: string
): Promise<PerformanceBreakdown[]> {
  const params = new URLSearchParams({ timeRange, source })
  if (projectId) params.append('projectId', projectId)

  const response = await fetchWithTimeout(`${API_BASE}/performance?${params}`, {}, FETCH_TIMEOUT)
  if (!response.ok) {
    throw new Error('Failed to fetch performance breakdown')
  }

  const result = await response.json()
  return result.data || []
}

