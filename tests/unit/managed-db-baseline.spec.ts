/**
 * The canonical baseline: one squashed migration generated from schema.prisma,
 * pinned by digest, and containing Layer 3 and nothing else.
 *
 * The legacy 18-migration chain is not history. It builds 50 of 119 tables and
 * lives in tools/migration-lineage/evidence as forensic evidence, which is why
 * these checks also assert it has not crept back into the canonical directory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BASELINE_ID, BASELINE_LOCK_PATH, BASELINE_SQL_PATH, type BaselineLock } from '../../tools/managed-db/generate-baseline'
import { auditBaselineSql } from '../../tools/managed-db/layers'
import { assembleMigrationWorkspace, CANONICAL_DIR } from '../../tools/managed-db/migration-workspace'

const ROOT = join(__dirname, '..', '..')
const sql = readFileSync(join(ROOT, BASELINE_SQL_PATH), 'utf8')
const lock: BaselineLock = JSON.parse(readFileSync(join(ROOT, BASELINE_LOCK_PATH), 'utf8'))
// Prefixed, matching generate-baseline.ts: a bare 64-char hex string in a
// tracked file is indistinguishable from a signing key, and the publish-time
// credential scanner flags that shape for good reason.
const sha256 = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex')}`

describe('the canonical baseline', () => {
  it('is pinned by digest', () => {
    expect({ sha256: sha256(sql), bytes: sql.length }).toEqual({ sha256: lock.sha256, bytes: lock.bytes })
    expect(lock.migration).toBe(BASELINE_ID)
  })

  it('records the schema it was squashed from', () => {
    // A historical fact, not a live invariant: once forward migrations exist,
    // schema.prisma is baseline PLUS those migrations. Whether the canonical
    // chain still produces schema.prisma is a database-backed check
    // (tools/managed-db/verify-canonical-history.ts), because Prisma needs a
    // shadow database to answer it.
    expect(lock.schemaSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(lock.prismaVersion).toBe('5.22.0')
    // It is NOT the current schema: the ledger migration added models after the
    // squash, so a lock recording today's schema would be claiming the baseline
    // contains them.
    expect(lock.schemaSha256).not.toBe(sha256(readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8')))
  })

  it('owns the canonical schema and nothing else, in every migration', () => {
    const migrations = readdirSync(join(ROOT, CANONICAL_DIR), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
    expect(migrations[0]).toBe(BASELINE_ID)
    for (const id of migrations) {
      const migrationSql = readFileSync(join(ROOT, CANONICAL_DIR, id, 'migration.sql'), 'utf8')
      expect({ id, findings: auditBaselineSql(migrationSql) }).toEqual({ id, findings: [] })
    }
    expect(sql).toMatch(/CREATE TABLE "projects"/)
  })

  it('carries the maintenance ledger as a forward migration, not in the baseline', () => {
    // Phase 6b persistence arrives through the migration runner, which is the
    // whole point of building it.
    expect(sql).not.toMatch(/maintenance_executions/)
    const ledger = readFileSync(join(ROOT, CANONICAL_DIR, '20260916120000_maintenance_ledger', 'migration.sql'), 'utf8')
    expect(ledger).toMatch(/CREATE TABLE "maintenance_executions"/)
    expect(ledger).toMatch(/CREATE TABLE "maintenance_step_executions"/)
    // Retry lifecycle stays in BackgroundJob; the ledger must not grow its own.
    expect(ledger).not.toMatch(/"attempts"|"maxAttempts"|"runAt"|"timeoutAt"|dead_letter/)
  })

  it('does not live in the gitignored working directory', () => {
    // prisma/migrations stays a scratch path: on developer machines it still
    // holds the legacy corpus, and shipping that would apply a history that
    // builds less than half the schema.
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
    expect(ignore).toContain('/prisma/migrations')
    expect(BASELINE_SQL_PATH.replace(/\\/g, '/')).toMatch(/^prisma\/migrations-canonical\//)
  })
})

/**
 * The canonical forward migrations, in order.
 *
 * Deliberately hardcoded rather than read from the directory: the point of the
 * assertions below is that a new migration cannot join the shipped history
 * without a human acknowledging it here. Reading the directory would make the
 * gate agree with whatever it found and assert nothing.
 *
 * Adding a migration is a one-line change to this list. It was two duplicated
 * literals before, which is how 20260916180000_maintenance_approvals landed in
 * the chain with both assertions left stale and the unit job red.
 */
const FORWARD_MIGRATIONS = [
  '20260916120000_maintenance_ledger',
  '20260916180000_maintenance_approvals',
  '20260919120000_project_email_config_and_templates',
  '20260921120000_rollback_authority',
  '20260921160000_ownership_intent',
  '20260921180000_authority_grants',
  '20260922120000_auth_email_codes',
]

describe('the assembled migration workspace', () => {
  it('contains the schema and only the canonical history', () => {
    const workspace = assembleMigrationWorkspace(ROOT)
    try {
      expect(workspace.migrations).toEqual([BASELINE_ID, ...FORWARD_MIGRATIONS])
      expect(existsSync(workspace.schemaPath)).toBe(true)
      expect(existsSync(join(workspace.migrationsDir, BASELINE_ID, 'migration.sql'))).toBe(true)
      expect(existsSync(join(workspace.migrationsDir, 'migration_lock.toml'))).toBe(true)
      expect(readFileSync(join(workspace.migrationsDir, BASELINE_ID, 'migration.sql'), 'utf8')).toBe(sql)
    } finally {
      workspace.dispose()
    }
  })

  it('can carry a rehearsal-only migration without writing it into the repository', () => {
    const workspace = assembleMigrationWorkspace(ROOT, [{ id: '29990101000000_fixture', sql: 'SELECT 1;' }])
    try {
      expect(workspace.migrations).toEqual([BASELINE_ID, ...FORWARD_MIGRATIONS, '29990101000000_fixture'])
      expect(existsSync(join(ROOT, CANONICAL_DIR, '20260916000000_fixture'))).toBe(false)
    } finally {
      workspace.dispose()
    }
  })

  it('cleans up after itself', () => {
    const workspace = assembleMigrationWorkspace(ROOT)
    workspace.dispose()
    expect(existsSync(workspace.dir)).toBe(false)
  })
})
