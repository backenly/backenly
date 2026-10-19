/**
 * When kept data is finally deleted.
 *
 * A change's vault holds what it would otherwise have destroyed. It is kept for
 * the project's restore window plus a grace week (lib/changes/policy.ts), then
 * dropped here. A restore that needs a purged vault says so: the restore point
 * reports what can no longer come back (lib/changes/impact.ts), it never
 * claims more. This and the archive-cleanup cron that calls it are the only
 * places the change ledger deletes data for good, and only a schema that is
 * provably one of this project's vaults, by name, is ever dropped.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { isVaultSchema, quoteIdent } from './names'
import { rollbackWindowDays, VAULT_GRACE_DAYS } from './policy'
import type { ChangePreservation } from './types'

export async function purgeExpiredVaults(projectId: string, now = new Date()): Promise<{ purged: string[] }> {
  const windowDays = await rollbackWindowDays(projectId)
  const cutoff = new Date(now.getTime() - (windowDays + VAULT_GRACE_DAYS) * 24 * 60 * 60 * 1000)
  const purged: string[] = []
  // Vaults are schemas in the project's own database, in its region.
  const db = await workspaceRawClient(projectId)

  const rows = await prisma.backendChange.findMany({
    where: { projectId, createdAt: { lt: cutoff }, NOT: { preserved: { equals: Prisma.DbNull } } },
    select: { id: true, preserved: true },
  })
  for (const row of rows) {
    const preserved = row.preserved as unknown as ChangePreservation | null
    if (!preserved || preserved.purgedAt || !isVaultSchema(projectId, preserved.vault)) continue
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(preserved.vault)} CASCADE`)
    await prisma.backendChange.update({
      where: { id: row.id },
      data: { preserved: { ...preserved, purgedAt: now.toISOString() } as unknown as Prisma.InputJsonValue },
    })
    purged.push(preserved.vault)
  }

  // A vault whose change left no record of it (a process that died between
  // creating it and recording the change) is dropped once it is as old as the
  // window allows, judged by the change number it was named for.
  const orphans = await db.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
    `workspace_${projectId}_r%`,
  )
  for (const { nspname } of orphans) {
    if (!isVaultSchema(projectId, nspname) || purged.includes(nspname)) continue
    const seq = Number(nspname.slice(nspname.lastIndexOf('_r') + 2))
    const change = await prisma.backendChange.findFirst({ where: { projectId, seq }, select: { createdAt: true, preserved: true } })
    const recorded = change?.preserved && (change.preserved as unknown as ChangePreservation).vault === nspname
    if (recorded) continue
    if (change && change.createdAt >= cutoff) continue
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(nspname)} CASCADE`)
    purged.push(nspname)
  }

  return { purged }
}
