/**
 * A SNAPSHOT RESTORE DOES NOT SWITCH PLANTED CODE BACK ON
 * ======================================================
 *
 * A snapshot is pg_dump --no-privileges --no-owner, replayed by psql as the
 * application's role (lib/services/workspace-backup.ts). Code a project planted
 * in its schema, and that scripts/neutralize-planted-objects.ts switched off,
 * comes back from it owned by the platform, with EXECUTE for PUBLIC again, and
 * a snapshot taken before the switch-off brings its trigger back on too. On a
 * database shared by several projects that code runs in the platform's
 * sessions again (lib/security/planted-objects.ts says why).
 *
 * So the restore switches it off again. This takes a snapshot of a project
 * with a planted trigger and function, switches them off, restores the
 * snapshot, and reads the catalog: the trigger is off and nobody but the
 * function's owner may run the function, which runs as whoever calls it.
 *
 * Real database, real pg_dump, real psql, as the restore runs them.
 */
import { randomBytes, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Read at module load by the service, so it has to be set before it is required.
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backenly-restore-planted-'))
process.env.BACKUP_DIR = BACKUP_DIR

// require, not import: BACKUP_DIR above must be set before the service module
// evaluates, and import declarations hoist above it.
const { prisma } = require('@/lib/db/prisma')
const { backupWorkspace, restoreWorkspace } = require('@/lib/services/workspace-backup')
const { actionsFor, findPlanted, readDatabaseFacts, stillRunning, switchOff } = require('@/lib/security/planted-objects')
const { Client } = require('pg')

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
// Stands in for a project's owner role, which a login from before acted as.
const OWNER = `bkn_own_${randomBytes(6).toString('hex')}`

let admin: InstanceType<typeof Client>
let projectId = ''
let userId = ''
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const schema = () => `workspace_${projectId}`
const T = (name: string) => `"${schema()}".${name}`

/** What the catalog says of the planted trigger and function. */
async function state() {
  const [trigger] = await q(`SELECT tgenabled::text AS e FROM pg_trigger WHERE tgname = 'touch_trg' AND tgrelid = to_regclass($1)`, [T('orders')])
  const [fn] = await q(
    `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public_runs, p.prosecdef AS definer
       FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
    [`${T('touch')}()`],
  )
  return { trigger: trigger?.e, publicRuns: fn?.public_runs, definer: fn?.definer }
}

beforeAll(async () => {
  admin = new Client({ connectionString: CONN })
  await admin.connect()
  userId = (await prisma.user.create({
    data: { email: `restore-planted-${randomUUID()}@test.invalid`, name: 'Restore planted' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: `restore-planted-${randomUUID().slice(0, 8)}`, userId }, select: { id: true } })).id

  await q(`CREATE ROLE ${OWNER} NOLOGIN`)
  await q(`CREATE SCHEMA "${schema()}"`)
  await q(`CREATE TABLE ${T('orders')} (id int PRIMARY KEY, note text)`)
  await q(`INSERT INTO ${T('orders')} VALUES (1, 'kept')`)
  // Planted: a definer function and the trigger that runs it, as the owner role made them.
  await q(`CREATE FUNCTION ${T('touch')}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$`)
  await q(`ALTER FUNCTION ${T('touch')}() OWNER TO ${OWNER}`)
  await q(`CREATE TRIGGER touch_trg BEFORE UPDATE ON ${T('orders')} FOR EACH ROW EXECUTE FUNCTION ${T('touch')}()`)
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
  for (const r of await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`${schema()}_pre%`]).catch(() => [])) {
    await q(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`).catch(() => {})
  }
  await q(`DROP OWNED BY ${OWNER}`).catch(() => {})
  await q(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceBackup.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  await admin?.end()
}, 120_000)

it('switches the planted code off again after restoring a snapshot taken before it was switched off', async () => {
  // A snapshot of the project as the code was planted.
  const backup = await backupWorkspace(projectId)
  expect(backup.success).toBe(true)

  // Switched off, as scripts/neutralize-planted-objects.ts does.
  const facts = await readDatabaseFacts(admin)
  expect(facts.shared).toBe(true)
  const report = await findPlanted(admin, [schema()], facts)
  expect(report.planted.map((p: { kind: string }) => p.kind).sort()).toEqual(['function', 'trigger'])
  const live = await stillRunning(admin, report.planted, facts)
  const off = await switchOff(projectId, actionsFor(live.map((l: { object: unknown }) => l.object)), {
    execute: (sql: string) => admin.query(sql),
    governed: false,
    mainSchema: schema(),
  })
  expect(off.failed).toEqual([])
  expect(await state()).toMatchObject({ trigger: 'D', publicRuns: false })

  // The snapshot brings both back as they were planted; the restore switches them off again.
  const restored = await restoreWorkspace(projectId)
  expect(restored.success).toBe(true)
  expect(await q(`SELECT note FROM ${T('orders')}`)).toEqual([{ note: 'kept' }])
  // Replayed as the restoring role: the platform's, and a definer once more until switched off.
  expect(await state()).toEqual({ trigger: 'D', publicRuns: false, definer: false })
  expect(await stillRunning(admin, (await findPlanted(admin, [schema()], facts)).planted, facts)).toEqual([])
  // Done by the restore, and written down for the project.
  const audit = await prisma.auditLog.findMany({ where: { projectId, action: 'PLANTED_OBJECTS_SWITCHED_OFF' } })
  expect(audit).toHaveLength(1)
  expect(JSON.parse(audit[0].details).switchedOff.map((s: { kind: string }) => s.kind).sort()).toEqual(['function', 'function', 'trigger'])
}, 180_000)
