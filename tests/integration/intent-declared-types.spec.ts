/**
 * The loop holds a column to the type a statement declared, exactly.
 *
 * Production QA (2026-11-09): `refunded_at timestamptz` was added with ALTER
 * TABLE … ADD COLUMN and ended up `timestamp without time zone`, and in an hour
 * of use the loop never said so. Two things hid it:
 *   - the intent ledger recorded only CREATE TABLE's columns, so a column added
 *     later was held to nothing;
 *   - it compared kinds, and timestamptz and timestamp are one kind there, as
 *     are numeric(10,2) and numeric.
 * A time written with an offset into `timestamp without time zone` keeps the
 * clock reading and silently drops the offset, so the drift corrupts values
 * without any write failing.
 *
 * A statement's type is a declaration (lib/mcp/migration-parser.ts,
 * exactSqlType), so it is recorded exactly and compared with the type
 * PostgreSQL reports (format_type). The typed tools' vocabulary ("timestamp",
 * "text") is a kind, and is still compared as one.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { detectIntentDrift, recordSchemaIntent } from '@/lib/autonomy/intent-conformance'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `intent-types-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'intent types' },
  })).id
  const project = await createProvisionedProject({ name: 'intent-types', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })

  const migrate = async (sql: string) => {
    const r = await applyMigrationToMain(projectId, ownerId, sql, { workspaceSchema: schema, agentSurface: true })
    expect(r.ok).toBe(true)
  }
  await migrate(`CREATE TABLE refunds (order_ref text, amount numeric(10,2), code varchar(12), noted_on date)`)
  await migrate(`ALTER TABLE refunds ADD COLUMN refunded_at timestamptz`)
}, 120_000)

afterAll(async () => {
  if (schema) await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (ownerId) {
    await prisma.schemaIntent.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

const driftOn = async (column: string) =>
  (await detectIntentDrift(projectId)).filter((f) => (f.details as Record<string, unknown>).columnName === column)

describe('a column whose declared type changed over a direct connection', () => {
  it('is reported when it was added with ALTER TABLE, as timestamptz became timestamp on production', async () => {
    expect(await driftOn('refunded_at')).toEqual([])
    await raw(`ALTER TABLE "${schema}".refunds ALTER COLUMN refunded_at TYPE timestamp`)

    const [finding] = await driftOn('refunded_at')
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('critical')
    expect(finding.details).toMatchObject({
      tableName: 'refunds',
      driftKind: 'type_drift',
      requested: 'timestamptz',
      actual: 'timestamp without time zone',
      migration:
        `ALTER TABLE "${schema}"."refunds" ALTER COLUMN "refunded_at" TYPE timestamptz USING "refunded_at"::timestamptz;`,
    })
    expect(String(finding.details.reason)).toContain(
      'A time written with an offset loses it: PostgreSQL keeps the clock reading and drops the offset.',
    )
  }, 60_000)

  it('is reported when a numeric loses its declared scale, and not when nothing changed', async () => {
    await raw(`ALTER TABLE "${schema}".refunds ALTER COLUMN amount TYPE numeric`)

    const [amount] = await driftOn('amount')
    expect(amount?.details).toMatchObject({ driftKind: 'type_drift', requested: 'numeric(10,2)', actual: 'numeric' })
    expect(String(amount.details.reason)).toContain('Values are kept as written instead of being rounded to 2 decimal places.')
    expect(await driftOn('code')).toEqual([])
    expect(await driftOn('noted_on')).toEqual([])
    expect(await driftOn('order_ref')).toEqual([])
  }, 60_000)
})

describe('a type from the typed tools', () => {
  it('is a kind, so timestamp is met by either timestamp type', async () => {
    await raw(`CREATE TABLE "${schema}".visits (started_at timestamptz, ended_at timestamp)`)
    await recordSchemaIntent(projectId, 'visits', [
      { name: 'started_at', type: 'timestamp' },
      { name: 'ended_at', type: 'timestamp' },
    ], 'create_table')
    expect(await driftOn('started_at')).toEqual([])
    expect(await driftOn('ended_at')).toEqual([])
  }, 60_000)
})
