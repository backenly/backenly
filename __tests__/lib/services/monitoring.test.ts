/**
 * MONITORING SERVICE — real-DB integration
 * =========================================
 * The monitoring surface is derived entirely from `api_request_logs` (the only
 * table that captures real runtime traffic). These tests seed known request
 * rows and assert that every derived signal — window stats, per-type stats,
 * chart buckets, per-endpoint breakdown, and anomaly baselines — reflects them
 * exactly, and that internal `/api/*` platform rows are excluded.
 *
 * No mocks: per repo policy, the database is never mocked.
 */

import {
  getMetrics,
  getMetricStats,
  getRuntimeWindowStats,
  getPerformanceBreakdown,
} from '@/lib/services/metrics'
import { detectAnomalies } from '@/lib/services/anomalyDetection'
import { prisma } from '@/lib/db/postgres'

const MIN = 60 * 1000
const HOUR = 60 * MIN

describe('Monitoring Service (ApiRequestLog-backed)', () => {
  let userId: string
  let projectId: string
  const now = Date.now()
  const curAt = new Date(now - 5 * MIN)       // inside every window
  const baselineAt = new Date(now - 36 * HOUR) // inside the 24h baseline window

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: 'monitoring-metrics@backenly.test' },
      update: {},
      create: { email: 'monitoring-metrics@backenly.test', name: 'Monitoring Test' },
    })
    userId = user.id

    const project = await prisma.project.create({
      data: { name: 'Monitoring Metrics Project', userId, description: 'metrics test' },
    })
    projectId = project.id

    const row = (method: string, path: string, statusCode: number, duration: number, timestamp: Date) =>
      ({ projectId, userId, method, path, statusCode, duration, timestamp })

    await prisma.apiRequestLog.createMany({
      data: [
        // Current window — 10 runtime requests
        row('GET', '/companies', 200, 100, curAt),
        row('GET', '/companies', 200, 100, curAt),
        row('GET', '/companies', 200, 100, curAt),
        row('GET', '/companies', 200, 100, curAt),
        row('GET', '/companies', 200, 100, curAt),
        row('POST', '/companies', 400, 50, curAt),   // client error
        row('POST', '/companies', 400, 50, curAt),   // client error
        row('GET', '/companies', 500, 500, curAt),   // server error
        row('GET', '/companies/1', 200, 100, curAt), // → /companies/:id
        row('GET', '/companies/2', 200, 100, curAt), // → /companies/:id
        // Internal platform noise — MUST be excluded from every metric
        row('POST', '/api/ai/chat', 200, 0, curAt),
        row('POST', '/api/ai/execute', 200, 0, curAt),
        // Baseline window — 5 fast requests (drives the latency-spike anomaly)
        row('GET', '/companies', 200, 20, baselineAt),
        row('GET', '/companies', 200, 20, baselineAt),
        row('GET', '/companies', 200, 20, baselineAt),
        row('GET', '/companies', 200, 20, baselineAt),
        row('GET', '/companies', 200, 20, baselineAt),
      ],
    })
  }, 30000)

  afterAll(async () => {
    await prisma.apiRequestLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    await prisma.user.delete({ where: { email: 'monitoring-metrics@backenly.test' } }).catch(() => {})
  }, 30000)

  describe('getRuntimeWindowStats', () => {
    it('aggregates only runtime traffic and excludes /api/* rows', async () => {
      const w = await getRuntimeWindowStats(projectId, new Date(now - HOUR), new Date(now))
      expect(w.count).toBe(10)              // 12 inserted current-window rows minus 2 internal
      expect(w.errorCount).toBe(3)          // two 400s + one 500
      expect(w.serverErrorCount).toBe(1)    // the single 500
      expect(w.avgDuration).toBe(130)       // (500 + 100 + 500 + 200) / 10
      expect(w.reliabilityPct).toBe(90)     // (10 - 1) / 10 * 100
      expect(w.stabilityPct).toBe(70)       // (10 - 3) / 10 * 100
    })

    it('reports a calm 100% reliability when there is no traffic', async () => {
      const w = await getRuntimeWindowStats(projectId, new Date(now - 5 * HOUR), new Date(now - 4 * HOUR))
      expect(w.count).toBe(0)
      expect(w.reliabilityPct).toBe(100)
      expect(w.stabilityPct).toBe(100)
      expect(w.avgDuration).toBe(0)
    })
  })

  describe('getMetricStats', () => {
    it('projects each metric type off the same real aggregate', async () => {
      const [rt, rv, er, up] = await Promise.all([
        getMetricStats('responseTime', '1h', undefined, undefined, projectId),
        getMetricStats('requestVolume', '1h', undefined, undefined, projectId),
        getMetricStats('errorRate', '1h', undefined, undefined, projectId),
        getMetricStats('uptime', '1h', undefined, undefined, projectId),
      ])
      expect(rt.avg).toBe(130)
      expect(rt.count).toBe(10)
      expect(rv.count).toBe(10)
      expect(er.avg).toBe(30)   // 3 / 10 * 100
      expect(er.count).toBe(3)
      expect(up.avg).toBe(90)   // reliability
    })
  })

  describe('getMetrics (chart buckets)', () => {
    it('buckets request volume to the real total', async () => {
      const series = await getMetrics('requestVolume', '1h', undefined, undefined, projectId)
      const total = series.reduce((sum, p) => sum + p.value, 0)
      expect(total).toBe(10)
    })
  })

  describe('getPerformanceBreakdown', () => {
    it('groups by METHOD + normalized path with correct error rates', async () => {
      const rows = await getPerformanceBreakdown('1h', 'api', projectId)
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

      expect(byId['GET /companies'].requests).toBe(6)                // 5×200 + 1×500
      expect(byId['GET /companies'].errorRate).toBeCloseTo(16.67, 1)
      expect(byId['POST /companies'].requests).toBe(2)
      expect(byId['POST /companies'].errorRate).toBe(100)
      expect(byId['GET /companies/:id'].requests).toBe(2)           // /1 and /2 rolled up
      expect(byId['GET /companies/:id'].errorRate).toBe(0)
    })

    it('returns nothing for non-api sources (not tracked, not faked)', async () => {
      const rows = await getPerformanceBreakdown('1h', 'function', projectId)
      expect(rows).toEqual([])
    })
  })

  describe('detectAnomalies', () => {
    it('detects a latency spike against the real baseline window', async () => {
      const anomalies = await detectAnomalies('responseTime', '24h', projectId)
      expect(Array.isArray(anomalies)).toBe(true)
      // current avg 130ms vs baseline 20ms → > 1.5× → spike
      expect(anomalies.some((a) => a.type === 'spike')).toBe(true)
    })
  })
})
