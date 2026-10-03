/**
 * Run purgeSyntheticAuthArtifacts for one project and let its output reach
 * stderr unfiltered.
 *
 * Exists because an in-process capture inside jest saw nothing: Prisma's
 * logger does not reliably reach a replaced `process.stderr.write` there, so a
 * test built on that passed identically against the bug. The regression is
 * about what an OPERATOR sees in the log, so it is observed the way an
 * operator observes it — from outside the process.
 *
 * Test-only. Not referenced by the application.
 */
import { prisma } from '@/lib/db/prisma'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'

async function main(): Promise<void> {
  const projectId = process.argv[2]
  if (!projectId) throw new Error('usage: probe-purge-output.ts <projectId>')
  await purgeSyntheticAuthArtifacts(projectId)
  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err instanceof Error ? err.message : String(err))
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
