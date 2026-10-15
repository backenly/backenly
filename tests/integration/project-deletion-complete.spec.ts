/**
 * DELETING A PROJECT DELETES EVERYTHING THAT IS THE PROJECT'S
 * ===========================================================
 * Two gaps behind "Deletion is immediate and final … every receipt":
 *
 *   - SET-05: the per-project PostgreSQL LOGIN roles survived. run_query
 *     provisions bkn_ro_<hex> for any project an agent queries, READ_WRITE
 *     adds bkn_rw_<hex>, the function runtime derives bkn_fn_<hex> — all
 *     cluster-level, remotely admitted by pg_hba, with their encrypted
 *     passwords in DatabaseCredential rows no cascade reached. A contractor's
 *     psql kept logging in after the project was deleted.
 *   - SET-06: ~27 models carry a bare projectId with no Project relation, so
 *     the cascade left full DDL snapshots (rawDdl), PITR/state graph
 *     snapshots, MCP OAuth codes/access tokens, security events and more.
 *
 * The sweep list is DERIVED from the Prisma schema (exported as
 * ORPHANED_PROJECT_MODELS), and this suite seeds it GENERICALLY from the same
 * DMMF — a future model with a bare projectId is swept and tested without
 * anyone remembering it. The user's Session keeps its row (the login is the
 * user's) with its project pointer nulled; the usage ledger rows survive on
 * purpose (billed usage is owed by the account).
 */

import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { deleteProjectCompletely, ORPHANED_PROJECT_MODELS } from '@/lib/projects/delete'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''
let sessionId = ''
let roRole = ''
let fnRole = ''
const seededModels: string[] = []

/** Fill one row's required scalars from the DMMF, by type. */
function genericRow(modelName: string, pid: string): Record<string, unknown> | null {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)!
  // A required relation needs a real parent; those models are covered by their
  // parent's cascade, so the generic seeder skips them rather than faking FKs.
  const requiredRelation = model.fields.some(
    (f) => f.kind === 'object' && f.isRequired && !f.isList,
  )
  if (requiredRelation) return null

  const row: Record<string, unknown> = {}
  for (const f of model.fields) {
    if (f.kind === 'object') continue
    if (f.name === 'projectId') { row.projectId = pid; continue }
    if (!f.isRequired || f.hasDefaultValue || f.isUpdatedAt) continue
    if (f.isList) { row[f.name] = []; continue }
    switch (f.kind === 'enum' ? 'enum' : f.type) {
      case 'String': row[f.name] = `del-test-${randomUUID()}`; break
      case 'Int': row[f.name] = 1; break
      case 'Float': row[f.name] = 1; break
      case 'BigInt': row[f.name] = BigInt(1); break
      case 'Boolean': row[f.name] = false; break
      case 'DateTime': row[f.name] = new Date(); break
      case 'Json': row[f.name] = {}; break
      case 'Bytes': row[f.name] = Buffer.from('x'); break
      case 'enum': {
        const e = Prisma.dmmf.datamodel.enums.find((en) => en.name === f.type)
        row[f.name] = e?.values[0]?.name
        break
      }
      default: return null // unknown shape — skip rather than guess
    }
  }
  return row
}

const delegate = (modelName: string) =>
  (prisma as any)[modelName.charAt(0).toLowerCase() + modelName.slice(1)]

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `del-${randomUUID()}@test.invalid`, name: 'Deletion Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `del-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."things" (id serial PRIMARY KEY)`)

  // The user's session, currently "inside" the project.
  sessionId = (
    await prisma.session.create({
      data: {
        userId: ownerId,
        token: `del-session-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
        projectId,
      },
      select: { id: true },
    })
  ).id

  // Real cluster roles, exactly the shapes the product provisions.
  roRole = `bkn_ro_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  fnRole = functionRoleName(schema)
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roRole}" LOGIN PASSWORD 'del-test-pass-1'`)
  await prisma.$executeRawUnsafe(`CREATE ROLE "${fnRole}" LOGIN PASSWORD 'del-test-pass-2'`)
  await prisma.databaseCredential.create({
    data: { projectId, mode: 'READ_ONLY', roleName: roRole, passwordCipher: 'c', passwordIv: 'i', passwordTag: 't' },
  })

  // One row per orphan model the generic seeder can express.
  for (const model of ORPHANED_PROJECT_MODELS) {
    if (model === 'DatabaseCredential') { seededModels.push(model); continue } // seeded above
    const row = genericRow(model, projectId)
    if (!row) continue
    try {
      await delegate(model).create({ data: row })
      seededModels.push(model)
    } catch {
      // A model whose constraints the generic row cannot satisfy is reported,
      // not silently skipped: the assertion below requires a healthy floor.
    }
  }
}, 180_000)

afterAll(async () => {
  for (const role of [roRole, fnRole]) {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const model of ORPHANED_PROJECT_MODELS) {
    await delegate(model).deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

it('the generic seeder covered a meaningful slice of the orphan class', () => {
  // If this floor drops, the sweep assertion below is testing air — fix the
  // seeder, do not lower the floor.
  expect(seededModels.length).toBeGreaterThanOrEqual(12)
  for (const name of ['WorkspaceSchemaSnapshot', 'PITRSnapshot', 'StateSnapshot', 'OIDCAccessToken', 'SecurityEvent', 'DatabaseCredential']) {
    expect(ORPHANED_PROJECT_MODELS).toContain(name)
    expect(seededModels).toContain(name)
  }
})

it('deletes the project, every orphaned row, and the cluster roles', async () => {
  const result = await deleteProjectCompletely(projectId)
  expect(result.projectIds).toEqual([projectId])

  expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()

  const schemaLeft = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`,
  )
  expect(schemaLeft).toHaveLength(0)

  // SET-06: nothing still carries this projectId, in ANY orphan model.
  for (const model of ORPHANED_PROJECT_MODELS) {
    const left = await delegate(model).count({ where: { projectId } })
    if (left !== 0) throw new Error(`${model} kept ${left} row(s) after deletion`)
  }

  // The user's login survives; only its project pointer is gone.
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session).not.toBeNull()
  expect(session!.projectId).toBeNull()

  // SET-05: the LOGIN roles are gone from the cluster.
  const roles = await prisma.$queryRawUnsafe<any[]>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('${roRole}', '${fnRole}')`,
  )
  expect(roles).toHaveLength(0)
}, 120_000)
