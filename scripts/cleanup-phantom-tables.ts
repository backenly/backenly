/**
 * cleanup-phantom-tables.ts
 * ─────────────────────────
 * One-time cleanup for projects affected by BUG-01 (phantom _apis tables) and
 * BUG-09 (duplicate ConversationMessages after credential submissions).
 *
 * Usage:
 *   npx tsx scripts/cleanup-phantom-tables.ts <projectId>
 *   npx tsx scripts/cleanup-phantom-tables.ts ed81bd4f-2ffe-4b99-8325-cd568a3271fa
 *
 * What it does:
 *  1. Drops all _apis-suffixed tables from workspace_{projectId} schema
 *  2. Deletes prisma.Table records with _apis suffix names
 *  3. Deletes prisma.ApiDefinition records for _apis-named tables
 *  4. Deduplicates ConversationMessage: keeps only the LATEST AI message per buildJobId,
 *     and removes duplicate standalone credential messages (same content within 1 hour)
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const projectId = process.argv[2]
  if (!projectId) {
    console.error('Usage: npx tsx scripts/cleanup-phantom-tables.ts <projectId>')
    process.exit(1)
  }

  const schemaName = `workspace_${projectId}`
  console.log(`\n🧹 Cleaning up project: ${projectId}`)
  console.log(`   Schema: ${schemaName}\n`)

  // ── 1. Find and drop _apis phantom tables ──────────────────────────────────
  console.log('Step 1: Finding phantom _apis tables in PostgreSQL…')
  const phantomRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
       AND table_name LIKE '%_apis'
     ORDER BY table_name`,
    schemaName
  )
  const phantomTables = phantomRows.map(r => r.table_name)

  if (phantomTables.length === 0) {
    console.log('   ✓ No phantom _apis tables found in PostgreSQL.\n')
  } else {
    console.log(`   Found ${phantomTables.length} phantom tables: ${phantomTables.join(', ')}`)
    for (const tbl of phantomTables) {
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS "${schemaName}"."${tbl}" CASCADE`
      )
      console.log(`   ✓ Dropped "${schemaName}"."${tbl}"`)
    }
    console.log()
  }

  // ── 2. Delete prisma.Table records with _apis suffix ──────────────────────
  console.log('Step 2: Removing phantom _apis prisma.Table records…')
  const deletedTables = await prisma.table.deleteMany({
    where: {
      projectId,
      name: { endsWith: '_apis' },
    },
  })
  console.log(`   ✓ Deleted ${deletedTables.count} phantom Table record(s).\n`)

  // ── 3. Delete prisma.ApiDefinition records for _apis tables ───────────────
  console.log('Step 3: Removing phantom _apis ApiDefinition records…')
  const deletedApis = await prisma.apiDefinition.deleteMany({
    where: {
      projectId,
      OR: [
        { name: { endsWith: '_apis' } },
        { basePath: { endsWith: '_apis' } },
      ],
    },
  })
  console.log(`   ✓ Deleted ${deletedApis.count} phantom ApiDefinition record(s).\n`)

  // ── 4. Deduplicate ConversationMessages ───────────────────────────────────
  console.log('Step 4: Deduplicating ConversationMessages…')

  // 4a. For each buildJobId, keep only the LATEST AI message (the final state)
  //     and remove all earlier intermediate snapshots.
  const allAiMessages = await prisma.conversationMessage.findMany({
    where: { projectId, role: 'ai' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, content: true, metadata: true, createdAt: true },
  })

  // Group by buildJobId
  const byJobId = new Map<string, Array<{ id: string; createdAt: Date }>>()
  for (const msg of allAiMessages) {
    const meta = msg.metadata as Record<string, any> | null
    const jobId = meta?.buildJobId as string | undefined
    if (jobId) {
      const group = byJobId.get(jobId) ?? []
      group.push({ id: msg.id, createdAt: msg.createdAt })
      byJobId.set(jobId, group)
    }
  }

  let dedupedCount = 0
  for (const [jobId, msgs] of byJobId.entries()) {
    if (msgs.length <= 1) continue
    // Keep the latest; delete the rest
    const sorted = msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const toDelete = sorted.slice(0, -1).map(m => m.id)
    await prisma.conversationMessage.deleteMany({ where: { id: { in: toDelete } } })
    dedupedCount += toDelete.length
    console.log(`   ✓ buildJobId ${jobId.slice(0, 8)}… — kept latest, removed ${toDelete.length} stale snapshot(s)`)
  }

  // 4b. Deduplicate standalone credential messages (same content, within 60 minutes)
  const credMessages = allAiMessages.filter(m => {
    const c = m.content
    return (
      c.includes('You can now accept payments') ||
      c.includes('Google sign-in is enabled') ||
      c.includes('All integrations') ||
      c.includes('say') && c.includes('deploy')
    )
  })

  // Group by content hash (first 120 chars to handle minor trailing whitespace)
  const byContent = new Map<string, Array<{ id: string; createdAt: Date }>>()
  for (const msg of credMessages) {
    const key = msg.content.slice(0, 120).trim()
    const group = byContent.get(key) ?? []
    group.push({ id: msg.id, createdAt: msg.createdAt })
    byContent.set(key, group)
  }

  for (const [, msgs] of byContent.entries()) {
    if (msgs.length <= 1) continue
    const sorted = msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    // Only deduplicate if within 1 hour of each other
    const oldest = sorted[0].createdAt.getTime()
    const newest = sorted[sorted.length - 1].createdAt.getTime()
    if (newest - oldest > 60 * 60 * 1000) continue
    const toDelete = sorted.slice(0, -1).map(m => m.id)
    await prisma.conversationMessage.deleteMany({ where: { id: { in: toDelete } } })
    dedupedCount += toDelete.length
    console.log(`   ✓ Removed ${toDelete.length} duplicate credential message(s)`)
  }

  if (dedupedCount === 0) {
    console.log('   ✓ No duplicate messages found.')
  } else {
    console.log(`   ✓ Removed ${dedupedCount} duplicate ConversationMessage(s) total.`)
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  const remaining = await prisma.table.count({ where: { projectId } })
  const remainingApis = await prisma.apiDefinition.count({ where: { projectId } })
  console.log(`\n✅ Cleanup complete.`)
  console.log(`   Tables remaining:         ${remaining}`)
  console.log(`   ApiDefinitions remaining: ${remainingApis}`)
  console.log(`\nRefresh the project page — the chat history and table counts should now be correct.\n`)
}

main()
  .catch(err => { console.error('❌ Cleanup failed:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
