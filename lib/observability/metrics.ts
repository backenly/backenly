/**
 * PHASE 18 — OBSERVABILITY WITHOUT VISIBILITY
 * 
 * Full internal metrics, alerts, and tracing.
 * Surface to users ONLY as: "Everything is running normally."
 * 
 * Users must NEVER see:
 * - Latency numbers
 * - Error rates
 * - Request counts
 * - Technical dashboards
 * 
 * They only see:
 * - "Everything's working"
 * - "A bit slower right now"
 * - "All caught up"
 */

export interface SystemMetric {
  timestamp: Date
  metric: string
  value: number
  labels?: Record<string, string>
}

export interface Alert {
  id: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  timestamp: Date
  resolved: boolean
  metadata?: Record<string, unknown>
}

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  operation: string
  startTime: Date
  endTime?: Date
  duration?: number
  status: 'success' | 'error'
  tags?: Record<string, string>
  logs?: Array<{ timestamp: Date; message: string }>
}

/**
 * Internal metrics collection (NEVER exposed to users)
 */
class MetricsCollector {
  private metrics: SystemMetric[] = []
  private readonly maxMetrics = 10000 // Keep last 10k metrics in memory

  record(metric: string, value: number, labels?: Record<string, string>) {
    this.metrics.push({
      timestamp: new Date(),
      metric,
      value,
      labels,
    })

    // Prune old metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics)
    }

    // Internal logging only
    console.log(`[Metrics] ${metric}=${value}`, labels || '')
  }

  getMetrics(metricName: string, since?: Date): SystemMetric[] {
    let filtered = this.metrics.filter((m) => m.metric === metricName)

    if (since) {
      filtered = filtered.filter((m) => m.timestamp >= since)
    }

    return filtered
  }

  getAverageValue(metricName: string, windowMinutes: number = 5): number {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000)
    const metrics = this.getMetrics(metricName, since)

    if (metrics.length === 0) return 0

    const sum = metrics.reduce((acc, m) => acc + m.value, 0)
    return sum / metrics.length
  }

  getMaxValue(metricName: string, windowMinutes: number = 5): number {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000)
    const metrics = this.getMetrics(metricName, since)

    if (metrics.length === 0) return 0

    return Math.max(...metrics.map((m) => m.value))
  }
}

/**
 * Internal alert system (NEVER exposed to users)
 */
class AlertManager {
  private alerts: Alert[] = []
  private readonly maxAlerts = 1000

  trigger(severity: Alert['severity'], message: string, metadata?: Record<string, unknown>) {
    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      severity,
      message,
      timestamp: new Date(),
      resolved: false,
      metadata,
    }

    this.alerts.push(alert)

    // Prune old alerts
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(-this.maxAlerts)
    }

    // Internal logging only
    console.log(`[Alert ${severity.toUpperCase()}] ${message}`, metadata || '')

    // TODO: Send to external monitoring (PagerDuty, Slack, etc.)
    // This is INTERNAL ONLY - never shown to users
  }

  resolve(alertId: string) {
    const alert = this.alerts.find((a) => a.id === alertId)
    if (alert) {
      alert.resolved = true
      console.log(`[Alert RESOLVED] ${alert.message}`)
    }
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter((a) => !a.resolved)
  }

  getCriticalAlerts(): Alert[] {
    return this.getActiveAlerts().filter((a) => a.severity === 'critical')
  }
}

/**
 * Distributed tracing (NEVER exposed to users)
 */
class TracingSystem {
  private traces: Map<string, TraceSpan[]> = new Map()
  private readonly maxTraces = 1000

  startSpan(operation: string, parentSpanId?: string): TraceSpan {
    const traceId = parentSpanId
      ? this.findTraceId(parentSpanId) || this.generateTraceId()
      : this.generateTraceId()

    const span: TraceSpan = {
      traceId,
      spanId: this.generateSpanId(),
      parentSpanId,
      operation,
      startTime: new Date(),
      status: 'success',
      tags: {},
      logs: [],
    }

    const traceSpans = this.traces.get(traceId) || []
    traceSpans.push(span)
    this.traces.set(traceId, traceSpans)

    // Prune old traces
    if (this.traces.size > this.maxTraces) {
      const oldestTraceId = Array.from(this.traces.keys())[0]
      this.traces.delete(oldestTraceId)
    }

    return span
  }

  endSpan(spanId: string, status: 'success' | 'error' = 'success') {
    const traceId = this.findTraceId(spanId)
    if (!traceId) return

    const spans = this.traces.get(traceId)
    const span = spans?.find((s) => s.spanId === spanId)

    if (span) {
      span.endTime = new Date()
      span.duration = span.endTime.getTime() - span.startTime.getTime()
      span.status = status
    }
  }

  addTag(spanId: string, key: string, value: string) {
    const traceId = this.findTraceId(spanId)
    if (!traceId) return

    const spans = this.traces.get(traceId)
    const span = spans?.find((s) => s.spanId === spanId)

    if (span && span.tags) {
      span.tags[key] = value
    }
  }

  addLog(spanId: string, message: string) {
    const traceId = this.findTraceId(spanId)
    if (!traceId) return

    const spans = this.traces.get(traceId)
    const span = spans?.find((s) => s.spanId === spanId)

    if (span && span.logs) {
      span.logs.push({
        timestamp: new Date(),
        message,
      })
    }
  }

  private generateTraceId(): string {
    return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  private generateSpanId(): string {
    return `span-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  private findTraceId(spanId: string): string | undefined {
    for (const traceId of Array.from(this.traces.keys())) {
      const spans = this.traces.get(traceId)
      if (spans && spans.some((s) => s.spanId === spanId)) {
        return traceId
      }
    }
    return undefined
  }

  getTrace(traceId: string): TraceSpan[] | undefined {
    return this.traces.get(traceId)
  }
}

/**
 * Global instances (singleton pattern)
 */
export const metrics = new MetricsCollector()
export const alerts = new AlertManager()
export const tracing = new TracingSystem()

/**
 * Track API request metrics
 */
export function trackAPIRequest(endpoint: string, method: string, duration: number, status: number) {
  metrics.record('api_request_duration_ms', duration, { endpoint, method })
  metrics.record('api_request_count', 1, { endpoint, method, status: status.toString() })

  // Alert on slow requests (INTERNAL ONLY)
  if (duration > 5000) {
    alerts.trigger('warning', `Slow API request: ${method} ${endpoint} took ${duration}ms`, {
      endpoint,
      method,
      duration,
    })
  }

  // Alert on errors (INTERNAL ONLY)
  if (status >= 500) {
    alerts.trigger('critical', `API error: ${method} ${endpoint} returned ${status}`, {
      endpoint,
      method,
      status,
    })
  }
}

/**
 * Track AI execution metrics
 */
export function trackAIExecution(projectId: string, action: string, duration: number, success: boolean) {
  metrics.record('ai_execution_duration_ms', duration, { projectId, action })
  metrics.record('ai_execution_count', 1, { projectId, action, success: success.toString() })

  // Alert on failures (INTERNAL ONLY)
  if (!success) {
    alerts.trigger('warning', `AI execution failed: ${action} in project ${projectId}`, {
      projectId,
      action,
      duration,
    })
  }
}

/**
 * Track database operation metrics
 */
export function trackDatabaseOperation(
  operation: string,
  duration: number,
  success: boolean,
  projectId?: string
) {
  metrics.record('db_operation_duration_ms', duration, { operation, projectId })
  metrics.record('db_operation_count', 1, { operation, success: success.toString(), projectId })

  // Alert on slow queries (INTERNAL ONLY)
  if (duration > 3000) {
    alerts.trigger('warning', `Slow database operation: ${operation} took ${duration}ms`, {
      operation,
      duration,
      projectId,
    })
  }
}

/**
 * Get user-facing system health status
 * This is the ONLY thing users ever see
 */
export function getUserFacingHealth(): {
  status: 'working' | 'slower' | 'catching_up'
  message: string
} {
  // Check internal metrics (NEVER show these to users)
  const avgAPILatency = metrics.getAverageValue('api_request_duration_ms', 5)
  const criticalAlerts = alerts.getCriticalAlerts()

  // Translate internal state to user-friendly message
  if (criticalAlerts.length > 0) {
    return {
      status: 'slower',
      message: "Things are a bit slower right now. Everything's still working.",
    }
  }

  if (avgAPILatency > 3000) {
    return {
      status: 'slower',
      message: "We're handling a lot right now. Everything's working.",
    }
  }

  if (avgAPILatency > 1000) {
    return {
      status: 'catching_up',
      message: "Everything's working smoothly.",
    }
  }

  return {
    status: 'working',
    message: "Everything's running normally.",
  }
}

/**
 * Wrap function with automatic tracing
 */
export async function withTracing<T>(
  operation: string,
  fn: (span: TraceSpan) => Promise<T>,
  parentSpanId?: string
): Promise<T> {
  const span = tracing.startSpan(operation, parentSpanId)

  try {
    const result = await fn(span)
    tracing.endSpan(span.spanId, 'success')
    return result
  } catch (error) {
    tracing.endSpan(span.spanId, 'error')
    tracing.addLog(span.spanId, `Error: ${error}`)
    throw error
  }
}
