/**
 * A TABLE DECLARED IN SQL GETS THE INDEXES ITS SQL DECLARES, AND NO OTHERS
 * =======================================================================
 * Production QA (2026-11-16): a test table of 7 columns came out of its merge
 * with 7 btree indexes nobody asked for ("createdAt", "updatedAt", deleted_at,
 * session_id, email, status, ext_id), one beside its own unique index on
 * ext_id; products.slug and admins.user_id were each indexed twice, a UNIQUE
 * the SQL declared plus Backenly's guess. #654 made such a table "as written"
 * for its columns, keys and checks; the index pass kept guessing from names.
 *
 * Now a table or column declared in SQL gets the indexes its SQL declares, and
 * the four columns every table has (id, "createdAt", "updatedAt", deleted_at)
 * get none beyond id's key. A foreign key it declares is indexed after the
 * migration by the guarantee that every relationship is indexed
 * (relationships_are_indexed), which sees the indexes the migration made, so a
 * composite one that leads with the key counts. That guarantee stops guessing
 * at columns merely named like keys on a table declared in SQL.
 *
 * A table Backenly designs from a description keeps its guessed indexes, but
 * never gets a second index on a column an index already leads with.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { executeAction } from '@/lib/ai/minimal-executor'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { markDeclaredInSql } from '@/lib/db/declared-tables'
import { detectMissingFkIndexes } from '@/lib/core/drift-detector'

let ownerId: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }),
  )
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

/** Every index on `table` but its primary key, as "name (columns)". */
async function indexesOn(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; cols: string }>>(
    `SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS cols
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
      ORDER BY 1`,
    schema, table,
  )
  return rows.map((r) => `${r.name} ${r.cols.replace(/^.* USING btree /, '')}`)
}

/** What the relationships guarantee asks to index, as "table.column (basis)". */
async function unindexed(table: string): Promise<string[]> {
  return (await detectMissingFkIndexes(projectId))
    .filter((f) => f.details.tableName === table)
    .map((f) => `${f.details.tableName}.${f.details.columnName} (${f.details.basis})`)
    .sort()
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `declared-idx-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'sql-tables-only-declared-indexes', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await migrated('CREATE TABLE products (name text NOT NULL, slug text UNIQUE)')
}, 240_000)

afterAll(async () => {
  const vaults = await prisma
    .$queryRawUnsafe<Array<{ nspname: string }>>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`)
    .catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('a table declared in SQL', () => {
  it('gets the unique indexes its SQL declares and nothing its column names suggest', async () => {
    await migrated(
      "CREATE TABLE qa_probe (session_id text NOT NULL, email text, status text NOT NULL DEFAULT 'new', ext_id text, sku text UNIQUE, user_id uuid);\n" +
      'CREATE UNIQUE INDEX qa_probe_ext_uq ON qa_probe (ext_id) WHERE true',
    )
    expect(await indexesOn('qa_probe')).toEqual(['qa_probe_ext_uq (ext_id)', 'qa_probe_sku_key (sku)'])
    // A UNIQUE the SQL declares is one index, not two.
    expect(await indexesOn('products')).toEqual(['products_slug_key (slug)'])
  }, 120_000)

  it('a column added in SQL gets no index its name suggests, and a key it declares none yet', async () => {
    await migrated('ALTER TABLE qa_probe ADD COLUMN order_id uuid')
    await migrated('ALTER TABLE qa_probe ADD COLUMN product_id uuid REFERENCES products(id)')
    expect(await indexesOn('qa_probe')).toEqual(['qa_probe_ext_uq (ext_id)', 'qa_probe_sku_key (sku)'])
  }, 120_000)

  it('the relationships guarantee asks for an index on the key it declares, and on no column only named like one', async () => {
    expect(await unindexed('qa_probe')).toEqual(['qa_probe.product_id (foreign_key)'])
  })

  it('a composite index the migration declares covers its key, so no other index is made or asked for', async () => {
    await migrated(
      'CREATE TABLE product_views (product_id uuid NOT NULL REFERENCES products(id), session_id text NOT NULL, referrer text);\n' +
      'CREATE INDEX product_views_product_created_idx ON product_views (product_id, "createdAt")',
    )
    expect(await indexesOn('product_views')).toEqual(['product_views_product_created_idx (product_id, "createdAt")'])
    expect(await unindexed('product_views')).toEqual([])
  }, 120_000)

  it('a table marked as declared in SQL is not asked about columns only named like keys', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}".imported (id uuid PRIMARY KEY, external_id text)`)
    await markDeclaredInSql(projectId, 'imported')
    expect(await unindexed('imported')).toEqual([])
  })
})

describe('a table the brain designs from a description', () => {
  it('keeps its guessed indexes but never gets a second index on a column one already leads with', async () => {
    const res = await executeAction(
      { action: 'CREATE_TABLE', params: { tableName: 'contacts', columns: [{ name: 'email', type: 'TEXT' }, { name: 'status', type: 'TEXT' }] } },
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    const indexes = await indexesOn('contacts')
    expect(indexes.filter((i) => i.endsWith('(email)'))).toHaveLength(1)
    expect(indexes).toEqual(expect.arrayContaining(['idx_contacts_status (status)', 'idx_contacts_createdat ("createdAt")']))
  }, 120_000)
})
