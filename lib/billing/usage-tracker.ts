/**
 * Per-Project Usage Tracker
 *
 * Tracks usage at the project level for credit billing (BUILDER plan).
 * All increments are non-blocking — they fire-and-forget to avoid
 * adding latency to the request path.
 *
 * Usage types:
 *   API units    — incremented by request middleware
 *   DB storage   — updated periodically by a background job
 *   File storage — updated on every B2 upload/delete
 *   Realtime     — incremented per SSE event dispatched
 */

import { prisma } from '@/lib/db/prisma'

// ─── API unit weights ─────────────────────────────────────────────────────────

/**
 * API unit weights by request complexity.
 * Simple GET = 1, heavy AI/aggregate = 5-20.
 */
export const API_UNIT_WEIGHTS = {
  simple: 1,      // GET single row, auth check
  medium: 3,      // GET list with filter, create/update row
  heavy: 10,      // AI function invocation, batch operations
  ai: 20,         // AI chat, complex orchestration
} as const

export type ApiUnitWeight = keyof typeof API_UNIT_WEIGHTS

// ─── Month key ────────────────────────────────────────────────────────────────

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

// ─── Core upsert ─────────────────────────────────────────────────────────────

async function upsertProjectUsage(
  projectId: string,
  month: string,
  data: {
    apiUnitsUsed?: { increment: number }
    realtimeEvents?: { increment: number }
  }
): Promise<void> {
  await prisma.projectUsage.upsert({
    where: { projectId_month: { projectId, month } },
    update: data,
    create: {
      projectId,
      month,
      apiUnitsUsed: BigInt(data.apiUnitsUsed?.increment ?? 0),
      realtimeEvents: BigInt(data.realtimeEvents?.increment ?? 0),
    },
  })
}

// ─── API unit tracking ────────────────────────────────────────────────────────

/**
 * Track API request units for a project.
 * Call this from the v1 runtime API middleware.
 *
 * @param projectId  The project receiving the request
 * @param units      Number of units to charge (1 = simple, 3 = medium, 10 = heavy)
 */
export async function trackProjectApiUnits(
  projectId: string,
  units: number = API_UNIT_WEIGHTS.simple
): Promise<void> {
  const month = thisMonth()
  try {
    await upsertProjectUsage(projectId, month, {
      apiUnitsUsed: { increment: units },
    })
  } catch (err) {
    // Never block requests for tracking failures
    console.error('[UsageTracker] API unit tracking failed:', err)
  }
}

// ─── Realtime event tracking ──────────────────────────────────────────────────

/**
 * Track realtime SSE events dispatched to clients.
 * Call this from the realtime broadcast/notify path.
 */
export async function trackProjectRealtimeEvent(
  projectId: string,
  count: number = 1
): Promise<void> {
  const month = thisMonth()
  try {
    await upsertProjectUsage(projectId, month, {
      realtimeEvents: { increment: count },
    })
  } catch (err) {
    console.error('[UsageTracker] Realtime event tracking failed:', err)
  }
}

// ─── Storage tracking ─────────────────────────────────────────────────────────

/**
 * Update file storage usage for a project (Backblaze B2).
 * Call after every upload or delete.
 *
 * @param projectId    The project owning the file
 * @param deltaBytes   Positive = upload, negative = delete
 */
export async function updateProjectFileStorage(
  projectId: string,
  deltaBytes: number
): Promise<void> {
  const deltaMb = deltaBytes / (1024 * 1024)
  const month = thisMonth()
  try {
    const existing = await prisma.projectUsage.findUnique({
      where: { projectId_month: { projectId, month } },
      select: { fileStorageUsedMb: true },
    })

    const currentMb = existing?.fileStorageUsedMb ?? 0
    const newMb = Math.max(0, currentMb + deltaMb)

    await prisma.projectUsage.upsert({
      where: { projectId_month: { projectId, month } },
      update: { fileStorageUsedMb: newMb },
      create: { projectId, month, fileStorageUsedMb: newMb },
    })
  } catch (err) {
    console.error('[UsageTracker] File storage update failed:', err)
  }
}

/**
 * Snapshot current PostgreSQL schema size for a project.
 * Run periodically (e.g., every 6 hours) via background job.
 *
 * Uses pg_total_relation_size to measure the workspace schema.
 */
export async function snapshotProjectDbStorage(projectId: string): Promise<void> {
  const month = thisMonth()
  const schemaName = `workspace_${projectId}`

  try {
    // Query total size of all tables in the workspace schema
    const result = await prisma.$queryRawUnsafe<Array<{ total_bytes: bigint }>>(
      `SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) AS total_bytes
       FROM pg_tables
       WHERE schemaname = $1`,
      schemaName
    )

    const totalBytes = Number(result[0]?.total_bytes ?? 0)
    const totalMb = totalBytes / (1024 * 1024)

    await prisma.projectUsage.upsert({
      where: { projectId_month: { projectId, month } },
      update: { dbStorageUsedMb: totalMb },
      create: { projectId, month, dbStorageUsedMb: totalMb },
    })
  } catch (err) {
    console.error(`[UsageTracker] DB storage snapshot failed for ${projectId}:`, err)
  }
}

// ─── Bulk DB storage snapshot ─────────────────────────────────────────────────

/**
 * Snapshot DB storage for ALL projects.
 * Call from a scheduled job (e.g., every 6 hours).
 */
export async function snapshotAllProjectsDbStorage(): Promise<void> {
  const projects = await prisma.project.findMany({
    select: { id: true },
    where: { expiresAt: null }, // only active (non-expired) projects
  })

  await Promise.allSettled(
    projects.map((p) => snapshotProjectDbStorage(p.id))
  )
}

// ─── Get current usage ────────────────────────────────────────────────────────

export interface ProjectCurrentUsage {
  projectId: string
  month: string
  apiUnitsUsed: number
  dbStorageUsedMb: number
  fileStorageUsedMb: number
  realtimeEvents: number
}

export async function getProjectUsage(
  projectId: string,
  month?: string
): Promise<ProjectCurrentUsage> {
  const m = month ?? thisMonth()
  const record = await prisma.projectUsage.findUnique({
    where: { projectId_month: { projectId, month: m } },
  })

  return {
    projectId,
    month: m,
    apiUnitsUsed: Number(record?.apiUnitsUsed ?? 0),
    dbStorageUsedMb: record?.dbStorageUsedMb ?? 0,
    fileStorageUsedMb: record?.fileStorageUsedMb ?? 0,
    realtimeEvents: Number(record?.realtimeEvents ?? 0),
  }
}

export async function getUserProjectsUsage(
  userId: string,
  month?: string
): Promise<ProjectCurrentUsage[]> {
  const m = month ?? thisMonth()
  const records = await prisma.projectUsage.findMany({
    where: { month: m, project: { userId } },
    include: { project: { select: { id: true } } },
  })

  return records.map((r) => ({
    projectId: r.projectId,
    month: m,
    apiUnitsUsed: Number(r.apiUnitsUsed),
    dbStorageUsedMb: r.dbStorageUsedMb,
    fileStorageUsedMb: r.fileStorageUsedMb,
    realtimeEvents: Number(r.realtimeEvents),
  }))
}
