/**
 * The Getting Started guide's stored state (the `user_onboarding` table).
 *
 * Only a person's choices live here: hiding the guide and reopening it, plus
 * bookkeeping that keeps each funnel milestone counted once. Step completion is
 * never stored; see ./guide.
 *
 * Every read tolerates the table not existing yet. A release can reach a server
 * before its migration does, and in that window the guide must degrade to
 * "nothing stored" rather than take the page that hosts it down with it.
 */

import { prisma } from '@/lib/db/prisma'
import type { GuidePreference, StepId } from './guide'

export interface StoredPreference extends GuidePreference {
  reportedSteps: string[]
  /** False when the table is not there yet, so nothing can be saved. */
  available: boolean
  /** Whether a row exists for this user. */
  exists: boolean
}

const EMPTY: Omit<StoredPreference, 'available'> = {
  startedAt: null,
  dismissedAt: null,
  reopenedAt: null,
  reportedSteps: [],
  exists: false,
}

/** Prisma's "table does not exist" (P2021), and the raw Postgres code behind it. */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null
  return e?.code === 'P2021' || e?.meta?.code === '42P01'
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export async function readPreference(userId: string): Promise<StoredPreference> {
  try {
    const row = await prisma.userOnboarding.findUnique({ where: { userId } })
    if (!row) return { ...EMPTY, available: true }
    return {
      startedAt: iso(row.startedAt),
      dismissedAt: iso(row.dismissedAt),
      reopenedAt: iso(row.reopenedAt),
      reportedSteps: row.reportedSteps,
      available: true,
      exists: true,
    }
  } catch (err) {
    if (isMissingTable(err)) return { ...EMPTY, available: false }
    throw err
  }
}

export class PreferenceUnavailableError extends Error {
  constructor() {
    super('Getting Started preferences cannot be saved until the database migration has run.')
  }
}

async function write<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    if (isMissingTable(err)) throw new PreferenceUnavailableError()
    throw err
  }
}

/**
 * Makes sure the row exists, atomically. Prisma's upsert is a read then a write,
 * so two tabs loading the guide at once both see no row and one insert fails on
 * the primary key; ON CONFLICT DO NOTHING has no such window.
 */
async function ensureRow(userId: string): Promise<void> {
  await prisma.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true })
}

export async function dismissGuide(userId: string, at = new Date()): Promise<void> {
  await write(async () => {
    await ensureRow(userId)
    await prisma.userOnboarding.update({ where: { userId }, data: { dismissedAt: at } })
  })
}

export async function reopenGuide(userId: string, at = new Date()): Promise<void> {
  await write(async () => {
    await ensureRow(userId)
    await prisma.userOnboarding.update({ where: { userId }, data: { dismissedAt: null, reopenedAt: at } })
  })
}

/**
 * Marks the guide as started, once. True only for the call that did it, so the
 * caller reports onboarding_started exactly once however many tabs are polling.
 */
export async function claimStart(userId: string, at = new Date()): Promise<boolean> {
  return write(async () => {
    await ensureRow(userId)
    const { count } = await prisma.userOnboarding.updateMany({
      where: { userId, startedAt: null },
      data: { startedAt: at },
    })
    return count === 1
  })
}

/**
 * Claims the right to report one step's completion. The conditional update is
 * the dedupe: two concurrent reads that both see the step as new race on it,
 * and only the one whose update matched reports it.
 */
export async function claimStepReport(userId: string, step: StepId): Promise<boolean> {
  return write(async () => {
    const { count } = await prisma.userOnboarding.updateMany({
      where: { userId, NOT: { reportedSteps: { has: step } } },
      data: { reportedSteps: { push: step } },
    })
    return count === 1
  })
}
