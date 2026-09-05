#!/usr/bin/env tsx
/**
 * Sandbox Cleanup Cron Script
 *
 * Deletes sandbox projects whose expiresAt timestamp has passed.
 * For each expired project:
 *   1. Drops the workspace_{projectId} PostgreSQL schema (all end-user data)
 *   2. Deletes the project record (cascades to all related platform data)
 *
 * Run via cron (every hour is recommended):
 *   0 * * * * cd /app && npx tsx scripts/fleet/sandbox-cleanup.ts >> /var/log/sandbox-cleanup.log 2>&1
 *
 * Or via PM2 cron mode:
 *   pm2 start scripts/fleet/sandbox-cleanup.ts --interpreter npx --interpreter-args tsx \
 *     --cron "0 * * * *" --no-autorestart --name sandbox-cleanup
 *
 * Also can be triggered via API:
 *   POST /api/admin/sandbox-cleanup  (requires CRON_SECRET header)
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function cleanupExpiredSandboxes(): Promise<void> {
  const now = new Date()
  console.log(`[${now.toISOString()}] Starting sandbox cleanup...`)

  const expiredProjects = await prisma.project.findMany({
    where: {
      expiresAt: { lte: now },
    },
    select: { id: true, name: true, userId: true, expiresAt: true },
  })

  if (expiredProjects.length === 0) {
    console.log('No expired sandbox projects found.')
    return
  }

  console.log(`Found ${expiredProjects.length} expired sandbox project(s) to clean up.`)

  let deleted = 0
  const errors: Array<{ projectId: string; name: string; error: string }> = []

  for (const project of expiredProjects) {
    try {
      console.log(`  Processing: ${project.name} (${project.id}) — expired at ${project.expiresAt?.toISOString()}`)

      // Step 1: Drop the workspace schema (all end-user tables/data)
      const schemaName = `workspace_${project.id}`
      try {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        console.log(`    ✅ Dropped schema: ${schemaName}`)
      } catch (schemaErr: any) {
        // Non-fatal — schema may not exist if project was never fully initialized
        console.warn(`    ⚠️  Could not drop schema ${schemaName}: ${schemaErr?.message}`)
      }

      // Step 2: Delete the project record (cascades to all FK references)
      await prisma.project.delete({ where: { id: project.id } })
      console.log(`    ✅ Deleted project record: ${project.name}`)

      deleted++
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      errors.push({ projectId: project.id, name: project.name, error: msg })
      console.error(`    ❌ Failed to delete ${project.name} (${project.id}): ${msg}`)
    }
  }

  // Summary
  console.log(`\nCleanup complete: ${deleted}/${expiredProjects.length} deleted.`)
  if (errors.length > 0) {
    console.error(`Errors (${errors.length}):`)
    for (const e of errors) {
      console.error(`  - ${e.name} (${e.projectId}): ${e.error}`)
    }
    process.exitCode = 1
  }
}

// Also clean up usage records for deleted projects (orphan cleanup)
async function cleanupOrphanUsageRecords(): Promise<void> {
  try {
    const deleted = await prisma.projectUsage.deleteMany({
      where: { project: { is: undefined } },
    })
    if (deleted.count > 0) {
      console.log(`Cleaned up ${deleted.count} orphan usage records.`)
    }
  } catch {
    // Non-critical
  }
}

async function main(): Promise<void> {
  try {
    await cleanupExpiredSandboxes()
    await cleanupOrphanUsageRecords()
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
