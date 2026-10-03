/**
 * LAYER 3: generate the one canonical baseline from schema.prisma.
 *
 *   npx tsx tools/managed-db/generate-baseline.ts [--check]
 *
 * The legacy 18-migration chain is NOT the history: it builds 50 of 119 tables
 * and is kept as forensic evidence under tools/migration-lineage/evidence. The
 * canonical history starts here, with a single squashed baseline generated from
 * the current model — never hand-written.
 *
 * Generation refuses unless the SQL is Layer 3 and only Layer 3. The audit in
 * tools/managed-db/layers.ts rejects extensions, roles, grants, event triggers,
 * default privileges, provisioning objects and tenant schemas, so a baseline
 * that reached another layer cannot be written to disk.
 *
 * `--check` regenerates into memory and compares against what is committed,
 * which is how CI notices a schema.prisma change that nobody baselined.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertBaselineOwnsOnlyCanonicalSchema } from './layers'
import { CANONICAL_DIR, MIGRATION_LOCK } from './migration-workspace'

export const BASELINE_ID = '00000000000000_baseline'
// Not prisma/migrations: that path is gitignored and still holds the legacy
// corpus on developer machines. See tools/managed-db/migration-workspace.ts.
export const BASELINE_SQL_PATH = join(CANONICAL_DIR, BASELINE_ID, 'migration.sql')
export const BASELINE_LOCK_PATH = join('tools', 'managed-db', 'baseline.lock.json')

export interface BaselineLock {
  migration: string
  /** Prefixed `sha256:`. See the note on `sha256()` below. */
  sha256: string
  bytes: number
  prismaVersion: string
  /** Prefixed `sha256:`. */
  schemaSha256: string
  generatedAt: string
  command: string
}

/**
 * A digest, written the way OCI image digests, SRI hashes and Go checksums
 * write one: labelled with the algorithm that produced it.
 *
 * Not decoration. A bare 64-character hex string in a tracked JSON file is
 * indistinguishable from a signing key, both to a reader and to the
 * publish-time credential scanner, which flags exactly that shape because a
 * live JWT_SECRET once sat in two tracked files and every prefix-shaped rule
 * missed it. The prefix says what the value is instead of asking the scanner to
 * make an exception for this file — an exception being the mechanism by which a
 * scanner stops catching things.
 */
const sha256 = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

export function generateBaselineSql(root: string): { sql: string; prismaVersion: string; schemaSha256: string } {
  const schemaPath = join(root, 'prisma', 'schema.prisma')
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  const sql = execFileSync(
    process.execPath,
    [cli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    },
  )
  if (!/CREATE TABLE/.test(sql)) throw new Error('prisma migrate diff produced no CREATE TABLE')

  // The gate: a baseline that reaches another layer is never written.
  assertBaselineOwnsOnlyCanonicalSchema(sql)

  return {
    sql,
    prismaVersion: JSON.parse(readFileSync(join(root, 'node_modules', 'prisma', 'package.json'), 'utf8')).version,
    schemaSha256: sha256(readFileSync(schemaPath)),
  }
}

function main(): void {
  const root = process.cwd()
  const check = process.argv.includes('--check')
  const { sql, prismaVersion, schemaSha256 } = generateBaselineSql(root)
  const digest = sha256(sql)

  if (check) {
    const committed = existsSync(join(root, BASELINE_SQL_PATH)) ? readFileSync(join(root, BASELINE_SQL_PATH), 'utf8') : null
    const lock: BaselineLock | null = existsSync(join(root, BASELINE_LOCK_PATH))
      ? JSON.parse(readFileSync(join(root, BASELINE_LOCK_PATH), 'utf8'))
      : null
    const problems: string[] = []
    if (!committed) problems.push(`${BASELINE_SQL_PATH} is missing`)
    else if (sha256(committed) !== digest) problems.push('the committed baseline does not match schema.prisma')
    if (!lock) problems.push(`${BASELINE_LOCK_PATH} is missing`)
    else if (lock.sha256 !== digest) problems.push('baseline.lock.json does not match the generated baseline')
    else if (lock.schemaSha256 !== schemaSha256) problems.push('baseline.lock.json records a different schema.prisma')

    if (problems.length) {
      console.error(`baseline check failed:\n${problems.map(p => `  ${p}`).join('\n')}`)
      process.exitCode = 1
      return
    }
    console.log(`baseline matches schema.prisma (${digest.slice(0, 12)}…, ${sql.length} bytes)`)
    return
  }

  mkdirSync(join(root, CANONICAL_DIR, BASELINE_ID), { recursive: true })
  writeFileSync(join(root, BASELINE_SQL_PATH), sql)

  const lock: BaselineLock = {
    migration: BASELINE_ID,
    sha256: digest,
    bytes: sql.length,
    prismaVersion,
    schemaSha256,
    generatedAt: new Date().toISOString(),
    command: 'prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script',
  }
  writeFileSync(join(root, BASELINE_LOCK_PATH), JSON.stringify(lock, null, 2) + '\n')

  const lockToml = join(root, CANONICAL_DIR, 'migration_lock.toml')
  if (!existsSync(lockToml)) writeFileSync(lockToml, MIGRATION_LOCK)

  console.log(`  wrote ${BASELINE_SQL_PATH} (${sql.length} bytes, sha256 ${digest.slice(0, 12)}…)`)
  console.log(`  wrote ${BASELINE_LOCK_PATH}`)
  console.log('  audit: canonical schema only')
}

if (require.main === module) main()
