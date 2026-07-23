/**
 * Anomaly Detection Service
 * Detects spikes, drops, and errors by comparing current values to baseline
 */

import { prisma } from '@/lib/db/postgres'
import { getMetricStats, getMetricStatsBetween, baselineWindow, type MetricType } from './metrics'

export type AnomalyType = 'spike' | 'drop' | 'error'

export interface AnomalyData {
  type: AnomalyType
  metric: string
  value: number
  expectedValue: number
  deviation: number
  explanation?: string
  projectId?: string
}

const ANOMALY_THRESHOLDS = {
  spike: 1.5, // 150% increase
  drop: 0.5,   // 50% decrease
  error: 1.0,  // 100% increase
}

/**
 * Detect anomalies for a metric type
 */
export async function detectAnomalies(
  type: MetricType,
  timeRange: '1h' | '24h' | '7d' | '30d' = '24h',
  projectId?: string
): Promise<AnomalyData[]> {
  const anomalies: AnomalyData[] = []

  // Get current period stats
  const currentStats = await getMetricStats(type, timeRange, undefined, undefined, projectId)
  
  // Get baseline stats (previous period of same length)
  const baselineStats = await getBaselineStats(type, timeRange, projectId)

  if (currentStats.count === 0 || baselineStats.count === 0) {
    return anomalies
  }

  const currentAvg = currentStats.avg
  const baselineAvg = baselineStats.avg

  // Check for spikes
  if (currentAvg > baselineAvg * ANOMALY_THRESHOLDS.spike) {
    const deviation = ((currentAvg - baselineAvg) / baselineAvg) * 100
    anomalies.push({
      type: 'spike',
      metric: getMetricDisplayName(type),
      value: currentAvg,
      expectedValue: baselineAvg,
      deviation,
      explanation: generateExplanation('spike', type, deviation),
      projectId,
    })
  }

  // Check for drops (only for request volume and uptime)
  if ((type === 'requestVolume' || type === 'uptime') && currentAvg < baselineAvg * ANOMALY_THRESHOLDS.drop) {
    const deviation = ((baselineAvg - currentAvg) / baselineAvg) * 100
    anomalies.push({
      type: 'drop',
      metric: getMetricDisplayName(type),
      value: currentAvg,
      expectedValue: baselineAvg,
      deviation,
      explanation: generateExplanation('drop', type, deviation),
      projectId,
    })
  }

  // Check for error spikes
  if (type === 'errorRate' && currentAvg > baselineAvg * ANOMALY_THRESHOLDS.error) {
    const deviation = ((currentAvg - baselineAvg) / baselineAvg) * 100
    anomalies.push({
      type: 'error',
      metric: getMetricDisplayName(type),
      value: currentAvg,
      expectedValue: baselineAvg,
      deviation,
      explanation: generateExplanation('error', type, deviation),
      projectId,
    })
  }

  return anomalies
}

/**
 * Get baseline stats from the previous period — derived from real runtime
 * traffic (ApiRequestLog), the same source the current-period stats use.
 */
async function getBaselineStats(
  type: MetricType,
  timeRange: '1h' | '24h' | '7d' | '30d',
  projectId?: string
) {
  const { start, end } = baselineWindow(timeRange)
  const stats = await getMetricStatsBetween(type, start, end, projectId)
  return { avg: stats.avg, count: stats.count }
}

/**
 * Store detected anomaly
 */
export async function storeAnomaly(data: AnomalyData): Promise<string> {
  const anomaly = await prisma.anomaly.create({
    data: {
      type: data.type,
      metric: data.metric,
      value: data.value,
      expectedValue: data.expectedValue,
      deviation: data.deviation,
      explanation: data.explanation,
      projectId: data.projectId,
    },
  })

  return anomaly.id
}

/**
 * Get recent anomalies
 */
export async function getRecentAnomalies(
  limit: number = 10,
  projectId?: string,
  status?: 'detected' | 'acknowledged' | 'resolved'
) {
  const where: any = {}
  if (projectId) where.projectId = projectId
  if (status) where.status = status

  return await prisma.anomaly.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: limit,
  })
}

/**
 * Acknowledge an anomaly
 */
export async function acknowledgeAnomaly(anomalyId: string): Promise<void> {
  await prisma.anomaly.update({
    where: { id: anomalyId },
    data: { status: 'acknowledged' },
  })
}

/**
 * Resolve an anomaly
 */
export async function resolveAnomaly(anomalyId: string): Promise<void> {
  await prisma.anomaly.update({
    where: { id: anomalyId },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
    },
  })
}

/**
 * Helper functions
 */
function getMetricDisplayName(type: MetricType): string {
  switch (type) {
    case 'responseTime':
      return 'Response Time'
    case 'requestVolume':
      return 'Request Volume'
    case 'errorRate':
      return 'Error Rate'
    case 'uptime':
      return 'Uptime'
    default:
      return type
  }
}

function generateExplanation(
  anomalyType: AnomalyType,
  metricType: MetricType,
  deviation: number
): string {
  const deviationText = deviation.toFixed(1)

  if (anomalyType === 'spike') {
    switch (metricType) {
      case 'requestVolume':
        return `Traffic spike detected (${deviationText}% increase). Possible causes: marketing campaign, viral content, or bot activity.`
      case 'responseTime':
        return `Response time increased significantly (${deviationText}% increase). Database query optimization recommended.`
      case 'errorRate':
        return `Error rate spike detected (${deviationText}% increase). Check recent deployments and database connections.`
      default:
        return `Spike detected: ${deviationText}% increase from baseline.`
    }
  } else if (anomalyType === 'drop') {
    switch (metricType) {
      case 'requestVolume':
        return `Traffic drop detected (${deviationText}% decrease). Possible causes: service outage, DNS issues, or routing problems.`
      case 'uptime':
        return `Uptime decreased (${deviationText}% decrease). Check service health and availability.`
      default:
        return `Drop detected: ${deviationText}% decrease from baseline.`
    }
  } else {
    return `Error anomaly detected: ${deviationText}% increase in error rate. Investigate system health.`
  }
}

