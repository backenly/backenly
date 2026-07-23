/**
 * Credits-Based Billing Engine
 *
 * NOTE: As of the v4 pricing update (Free / Pro $25 / Enterprise custom),
 * no plans use pay-as-you-go billing. All plans are flat monthly rates.
 * This module is kept for backward compatibility and historical bill records,
 * but `isBuilderPlan()` will return false for all current users.
 *
 * Legacy BUILDER PAYG pricing (archived):
 *   API:       $1.50 per 100,000 units
 *   DB:        $0.20 per GB
 *   Storage:   $0.12 per GB (Backblaze B2)
 *   Realtime:  $1.00 per 50,000 events
 *   Minimum:   $5.00/month
 */

import { prisma } from '@/lib/db/prisma'

// ─── Pricing constants (legacy — no longer applied to active plans) ──────────

export const PRICING = {
  /** USD per 100,000 API units */
  API_PER_100K: 1.5,
  /** USD per GB of PostgreSQL storage */
  DB_PER_GB: 0.20,
  /** USD per GB of Backblaze B2 file storage */
  STORAGE_PER_GB: 0.12,
  /** USD per 50,000 realtime events */
  REALTIME_PER_50K: 1.0,
  /** Legacy minimum monthly charge */
  MINIMUM_CHARGE: 5.0,
} as const

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectBillBreakdown {
  projectId: string
  projectName: string
  apiUnitsUsed: number
  dbStorageUsedMb: number
  fileStorageUsedMb: number
  realtimeEvents: number
  apiCost: number
  dbCost: number
  storageCost: number
  realtimeCost: number
  totalCost: number
}

export interface MonthlyBill {
  userId: string
  month: string
  projects: ProjectBillBreakdown[]
  apiCost: number
  dbCost: number
  storageCost: number
  realtimeCost: number
  totalUsageCost: number
  finalCost: number
  overage: number
  minimumCharge: number
}

// ─── Cost calculators ─────────────────────────────────────────────────────────

export function calcApiCost(apiUnits: number): number {
  return (apiUnits / 100_000) * PRICING.API_PER_100K
}

export function calcDbCost(dbMb: number): number {
  return (dbMb / 1024) * PRICING.DB_PER_GB
}

export function calcStorageCost(fileMb: number): number {
  return (fileMb / 1024) * PRICING.STORAGE_PER_GB
}

export function calcRealtimeCost(events: number): number {
  return (events / 50_000) * PRICING.REALTIME_PER_50K
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Monthly bill computation ─────────────────────────────────────────────────

/**
 * Compute the monthly bill for a legacy pay-as-you-go user.
 * Not used for current Starter/Pro flat-rate plans.
 */
export async function computeMonthlyBill(
  userId: string,
  month: string // YYYY-MM
): Promise<MonthlyBill> {
  const usageRecords = await prisma.projectUsage.findMany({
    where: { month, project: { userId } },
    include: { project: { select: { id: true, name: true } } },
  })

  const projects: ProjectBillBreakdown[] = usageRecords.map((u) => {
    const apiUnits = Number(u.apiUnitsUsed)
    const dbMb = u.dbStorageUsedMb
    const fileMb = u.fileStorageUsedMb
    const events = Number(u.realtimeEvents)

    const apiCost = round2(calcApiCost(apiUnits))
    const dbCost = round2(calcDbCost(dbMb))
    const storageCost = round2(calcStorageCost(fileMb))
    const realtimeCost = round2(calcRealtimeCost(events))

    return {
      projectId: u.projectId,
      projectName: u.project.name,
      apiUnitsUsed: apiUnits,
      dbStorageUsedMb: dbMb,
      fileStorageUsedMb: fileMb,
      realtimeEvents: events,
      apiCost,
      dbCost,
      storageCost,
      realtimeCost,
      totalCost: round2(apiCost + dbCost + storageCost + realtimeCost),
    }
  })

  const apiCost = round2(projects.reduce((s, p) => s + p.apiCost, 0))
  const dbCost = round2(projects.reduce((s, p) => s + p.dbCost, 0))
  const storageCost = round2(projects.reduce((s, p) => s + p.storageCost, 0))
  const realtimeCost = round2(projects.reduce((s, p) => s + p.realtimeCost, 0))
  const totalUsageCost = round2(apiCost + dbCost + storageCost + realtimeCost)
  const finalCost = round2(Math.max(PRICING.MINIMUM_CHARGE, totalUsageCost))
  const overage = round2(Math.max(0, totalUsageCost - PRICING.MINIMUM_CHARGE))

  return {
    userId,
    month,
    projects,
    apiCost,
    dbCost,
    storageCost,
    realtimeCost,
    totalUsageCost,
    finalCost,
    overage,
    minimumCharge: PRICING.MINIMUM_CHARGE,
  }
}

// ─── Bill persistence ─────────────────────────────────────────────────────────

/**
 * Compute and persist the CreditBill record for a user/month.
 * Called at end-of-month or on demand (legacy PAYG users only).
 */
export async function upsertCreditBill(
  userId: string,
  month: string
): Promise<{ bill: MonthlyBill; saved: boolean }> {
  const bill = await computeMonthlyBill(userId, month)

  await prisma.creditBill.upsert({
    where: { userId_month: { userId, month } },
    update: {
      apiCost: bill.apiCost,
      dbCost: bill.dbCost,
      storageCost: bill.storageCost,
      realtimeCost: bill.realtimeCost,
      totalUsageCost: bill.totalUsageCost,
      finalCost: bill.finalCost,
      overage: bill.overage,
    },
    create: {
      userId,
      month,
      apiCost: bill.apiCost,
      dbCost: bill.dbCost,
      storageCost: bill.storageCost,
      realtimeCost: bill.realtimeCost,
      totalUsageCost: bill.totalUsageCost,
      finalCost: bill.finalCost,
      overage: bill.overage,
    },
  })

  return { bill, saved: true }
}

// ─── Current month helper ─────────────────────────────────────────────────────

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

export function nextMonthStart(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

// ─── PAYG plan check (legacy) ─────────────────────────────────────────────────

/**
 * Returns true if user is on a pay-as-you-go plan.
 * Always returns false with current Starter/Pro flat-rate pricing.
 */
export async function isBuilderPlan(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  })
  return sub?.plan.isPayAsYouGo === true
}
