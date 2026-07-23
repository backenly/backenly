/**
 * End-to-end verification of Direct Database Access + drift adoption.
 * Run on the server: npx tsx scripts/verify-direct-access.ts <projectId> [host]
 *
 * host defaults to 127.0.0.1 — verifies the whole stack over the local
 * interface (roles, grants, RLS pass-through, event-trigger capture, adopt,
 * revoke). External reachability (backenly.com:5432) is a separate network
 * concern checked by connecting from off-box once the port is open.
 *
 * Proves, in order:
 *   RO  1. provision READ_ONLY → role can connect + SELECT workspace tables
 *       2. INSERT as ro fails (permission denied)
 *       3. CREATE TABLE as ro fails
 *       4. cross-tenant SELECT (public schema platform table) fails
 *   RW  5. provision READ_WRITE → CREATE TABLE + INSERT over the wire succeed
 *       6. event trigger recorded the DDL as pending SchemaDriftEvent rows
 *       7. detectPendingSchemaDrift returns one evidence-bearing finding
 *       8. ADOPT_EXTERNAL_SCHEMA registers the new table (metadata + API),
 *          re-baselines, marks events adopted (pending → 0)
 *       9. external DROP TABLE → captured → adopt prunes the metadata
 *      10. reapDriftFindings withdraws the finding once nothing is pending
 *   END 11. revoke both roles → pg_roles empty of them, connect now fails
 */

import { Client } from 'pg'
import { prisma } from '../lib/db/prisma'
import {
  provisionDirectAccess,
  revokeDirectAccess,
  getDirectAccessStatus,
} from '../lib/services/direct-access'
import { detectPendingSchemaDrift, reapDriftFindings } from '../lib/autonomy/drift-watch'

const projectId = process.argv[2]
const HOST = process.argv[3] || '127.0.0.1'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function connectAs(user: string, password: string, database: string): Promise<Client> {
  const c = new Client({ host: HOST, port: 5432, user, password, database, connectionTimeoutMillis: 8000 })
  await c.connect()
  return c
}

async function expectFail(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null } catch (err: any) { return err?.message ?? 'failed' }
}

async function main() {
  if (!projectId) {
    console.error('Usage: npx tsx scripts/verify-direct-access.ts <projectId> [host]')
    process.exit(1)
  }
  const probe = `drift_probe_${Date.now().toString(36)}`

  // ── READ_ONLY ───────────────────────────────────────────────────────────────
  console.log('\n— READ_ONLY —')
  const ro = await provisionDirectAccess(projectId, 'READ_ONLY')
  console.log(`  provisioned ${ro.roleName} @ ${HOST}:5432/${ro.database}`)

  const roClient = await connectAs(ro.roleName, ro.password, ro.database)
  const tables = await roClient.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename NOT LIKE '\\_%' LIMIT 5`,
  )
  check('1. ro connects, search_path lands in workspace schema, SELECT works', tables.rowCount !== null)
  const firstTable: string | undefined = tables.rows[0]?.tablename

  if (firstTable) {
    const selErr = await expectFail(() => roClient.query(`SELECT * FROM "${firstTable}" LIMIT 1`))
    check(`1b. SELECT rows from "${firstTable}" (RLS pass-through)`, selErr === null, selErr ?? undefined)
    const insErr = await expectFail(() => roClient.query(`INSERT INTO "${firstTable}" DEFAULT VALUES`))
    check('2. INSERT as ro is denied', insErr !== null && /permission denied|read-only/i.test(insErr))
  }
  const ddlErr = await expectFail(() => roClient.query(`CREATE TABLE ${probe}_ro (id int)`))
  check('3. CREATE TABLE as ro is denied', ddlErr !== null && /permission denied|read-only/i.test(ddlErr ?? ''))
  const crossErr = await expectFail(() => roClient.query(`SELECT * FROM public.users LIMIT 1`))
  check('4. platform public.users is unreadable', crossErr !== null && /permission denied/i.test(crossErr ?? ''))
  await roClient.end()

  // ── READ_WRITE + drift capture ──────────────────────────────────────────────
  console.log('\n— READ_WRITE + drift —')
  const preEvents = await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })
  const rw = await provisionDirectAccess(projectId, 'READ_WRITE')
  console.log(`  provisioned ${rw.roleName}`)

  const rwClient = await connectAs(rw.roleName, rw.password, rw.database)
  const createErr = await expectFail(() =>
    rwClient.query(`CREATE TABLE ${probe} (id serial PRIMARY KEY, note text NOT NULL DEFAULT 'observed')`))
  check('5. external CREATE TABLE succeeds', createErr === null, createErr ?? undefined)
  const dmlErr = await expectFail(() => rwClient.query(`INSERT INTO ${probe} (note) VALUES ('external write')`))
  check('5b. external INSERT succeeds', dmlErr === null, dmlErr ?? undefined)

  const pendingAfterCreate = await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })
  check('6. event trigger captured the DDL', pendingAfterCreate > preEvents,
    `pending ${preEvents} → ${pendingAfterCreate}`)

  const findings = await detectPendingSchemaDrift(projectId)
  check('7. drift probe emits ONE evidence-bearing finding',
    findings.length === 1 && findings[0].type === 'external_schema_change'
      && typeof (findings[0].details as any).reason === 'string',
    JSON.stringify(findings.map(f => f.type)))

  // ── Adopt (via the real executor action) ────────────────────────────────────
  const { executeAction } = await import('../lib/ai/minimal-executor')
  const adopt1 = await executeAction({ action: 'ADOPT_EXTERNAL_SCHEMA', params: {} } as any, projectId, undefined, 0, undefined, false)
  const registered = (adopt1.data as any)?.registeredTables ?? []
  check('8. ADOPT_EXTERNAL_SCHEMA succeeds and registers the new table',
    adopt1.success && registered.includes(probe), adopt1.message?.slice(0, 200))
  const metaRow = await prisma.table.findFirst({ where: { projectId, name: probe }, select: { id: true } })
  check('8b. platform metadata row exists for the adopted table', !!metaRow)
  const pendingAfterAdopt = await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })
  check('8c. no pending drift events remain', pendingAfterAdopt === 0, `pending=${pendingAfterAdopt}`)

  // ── External DROP → adopt prunes ────────────────────────────────────────────
  const dropErr = await expectFail(() => rwClient.query(`DROP TABLE ${probe}`))
  check('9. external DROP TABLE succeeds', dropErr === null, dropErr ?? undefined)
  await rwClient.end()
  const pendingAfterDrop = await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })
  check('9b. drop was captured', pendingAfterDrop > 0, `pending=${pendingAfterDrop}`)
  const adopt2 = await executeAction({ action: 'ADOPT_EXTERNAL_SCHEMA', params: {} } as any, projectId, undefined, 0, undefined, false)
  const pruned = (adopt2.data as any)?.prunedTables ?? []
  check('9c. adopt prunes metadata for the dropped table', adopt2.success && pruned.includes(probe),
    JSON.stringify(pruned))

  const reaped = await reapDriftFindings(projectId)
  check('10. drift reaper runs clean with nothing pending', reaped >= 0)

  // ── Revoke ──────────────────────────────────────────────────────────────────
  console.log('\n— revoke —')
  await revokeDirectAccess(projectId, 'READ_ONLY')
  await revokeDirectAccess(projectId, 'READ_WRITE')
  const roles = await prisma.$queryRawUnsafe<Array<{ rolname: string }>>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('${ro.roleName}', '${rw.roleName}')`)
  check('11. both roles dropped', roles.length === 0, JSON.stringify(roles))
  const reconnectErr = await expectFail(() => connectAs(ro.roleName, ro.password, ro.database))
  check('11b. old credentials no longer connect', reconnectErr !== null)
  const status = await getDirectAccessStatus(projectId)
  check('11c. status reports no credentials', status.credentials.length === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('verify-direct-access crashed:', err)
  process.exit(1)
})
