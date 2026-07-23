/**
 * BEHAVIORAL VERIFIER — destructive-confirm resume (chat door)
 * ============================================================
 * Proves the 2026-07-16 live-test failure is fixed by exercising the REAL
 * brain path end-to-end on a live project:
 *
 *   1. Creates a throwaway table (deterministic dispatchTool — no LLM).
 *   2. runBrain("drop the <table> table")  → must NOT drop; must persist a
 *      pending-destructive state (danger gate) or a replay marker (prose-ask).
 *   3. runBrain("confirm")                 → must execute the drop through the
 *      structured resume, and the table must be GONE from information_schema.
 *
 * Run on the server (needs OPENAI_API_KEY + DATABASE_URL):
 *   PROJECT_ID=<uuid> npx tsx scripts/verify-destructive-confirm.ts
 */

import { prisma } from '../lib/db'
import { runBrain, type BrainEvent } from '../lib/ai/brain/agent'
import { dispatchTool } from '../lib/ai/brain/tools'
import { loadPendingDestructive } from '../lib/ai/brain/pending-destructive'
import { workspaceSchemaName } from '../lib/security/workspace-schema'

const TABLE = 'junk_confirm_verify'

async function tableExists(projectId: string): Promise<boolean> {
  const schema = workspaceSchemaName(projectId)
  const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>(
    `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schema,
    TABLE,
  )
  return rows.length > 0
}

async function main() {
  const projectId = process.env.PROJECT_ID
  if (!projectId) throw new Error('PROJECT_ID env var is required')
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)
  const userId = project.userId

  const results: Array<[string, boolean, string]> = []
  const emit = (e: BrainEvent) => {
    if (e.type === 'danger') console.log(`  [danger] ${e.tool} → ${e.target}`)
    if (e.type === 'final') console.log(`  [final] ${e.summary.slice(0, 140).replace(/\n/g, ' ')}`)
  }

  // 1. Deterministic setup — throwaway table, no LLM involved.
  console.log(`\n— setup: create ${TABLE}`)
  const created = await dispatchTool(
    'create_table',
    { tableName: TABLE, columns: [{ name: 'note', type: 'text' }] },
    { projectId, userId, createdThisTurn: new Set<string>() },
  )
  results.push(['setup: table created', created.ok && (await tableExists(projectId)), created.summary.slice(0, 120)])

  // 2. Unconfirmed destructive ask — must not drop, must persist state.
  console.log(`\n— turn 1: "drop the ${TABLE} table"`)
  const turn1 = await runBrain(
    { projectId, userId, message: `drop the ${TABLE} table`, destructiveConfirmed: false },
    emit,
  )
  const stillThere = await tableExists(projectId)
  const pending = await loadPendingDestructive(projectId)
  results.push(['turn 1: table NOT dropped yet', stillThere, turn1.summary.slice(0, 120)])
  results.push([
    'turn 1: pending-destructive state persisted',
    pending !== null,
    pending ? `calls=${pending.calls.length} original="${pending.originalMessage.slice(0, 60)}"` : 'none stored',
  ])

  // 3. Bare "confirm" — the exact phrase that used to loop forever.
  console.log(`\n— turn 2: "confirm"`)
  const turn2 = await runBrain(
    { projectId, userId, message: 'confirm', destructiveConfirmed: false },
    emit,
  )
  const gone = !(await tableExists(projectId))
  const pendingCleared = (await loadPendingDestructive(projectId)) === null
  results.push(['turn 2: drop executed on bare "confirm"', turn2.success && gone, turn2.summary.slice(0, 120)])
  results.push(['turn 2: pending state consumed', pendingCleared, ''])

  console.log('\n════ RESULTS ════')
  let failed = 0
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failed++
  }
  console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
  .catch((err) => {
    console.error('Verifier crashed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
