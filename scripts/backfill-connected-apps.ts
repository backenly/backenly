/**
 * Backfill: Project.allowedOrigins  →  ConnectedApp
 *
 * Run ONCE on production BEFORE `npm run db:push` drops the
 * `allowedOrigins` column. After this script completes, every
 * legacy origin lives as a row in `connected_apps`, isActive=true.
 *
 * Idempotent: re-running is safe — existing rows are left untouched
 * (handled by the (projectId, origin) unique constraint via upsert).
 *
 *   npx tsx scripts/backfill-connected-apps.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function normalizeOrigin(raw: string): string | null {
  try {
    let v = raw.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(v)) {
      v = (v.includes('localhost') || v.startsWith('127.0.0.1') ? 'http://' : 'https://') + v
    }
    return new URL(v).origin
  } catch {
    return null
  }
}

async function backfill() {
  // We have to use raw SQL because the column we're reading is the one
  // about to be dropped — Prisma client may already be stale.
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; allowed_origins: string[] }>>(
    `SELECT id, allowed_origins FROM projects WHERE allowed_origins IS NOT NULL AND array_length(allowed_origins, 1) > 0`,
  )

  let projects = 0
  let migrated = 0
  let skipped = 0

  for (const row of rows) {
    projects++
    for (const raw of row.allowed_origins ?? []) {
      const origin = normalizeOrigin(raw)
      if (!origin) {
        console.warn(`  ⚠ skip invalid origin "${raw}" on project ${row.id}`)
        skipped++
        continue
      }

      const result = await (prisma as any).connectedApp.upsert({
        where: { projectId_origin: { projectId: row.id, origin } },
        update: {}, // do not clobber an existing row
        create: {
          projectId: row.id,
          origin,
          isActive: true,
          connectedBy: 'BACKFILL',
          backendVersion: 0, // legacy — no DeploymentAudit linkage available
        },
      })
      if (result) migrated++
    }
  }

  console.log(`\n✓ Backfill complete`)
  console.log(`  Projects scanned:   ${projects}`)
  console.log(`  Origins migrated:   ${migrated}`)
  console.log(`  Origins skipped:    ${skipped}`)
  console.log(`\nNext: run \`npm run db:push\` to drop the legacy allowed_origins column.`)
}

backfill()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
