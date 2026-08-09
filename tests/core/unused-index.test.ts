/**
 * UNUSED INDEX — the evidence must be a measured window, not a counter
 * ---------------------------------------------------------------------
 * `idx_scan` is cumulative since the statistics were last reset. It carries no
 * notion of elapsed time, so a threshold on it alone reports:
 *
 *   • every index created in the last five minutes
 *   • every index on a table nobody touched since pg_stat_reset()
 *   • every index serving a job that runs monthly
 *
 * as "unused, safe to drop". The previous implementation
 * (infra-intelligence's detectIndexIssues, `idx_scan < 10`) had exactly that
 * evidence, which is one of two reasons its output was never surfaced.
 *
 * These run against a real PostgreSQL — the database is never mocked here,
 * because the whole question is what the catalog and the statistics views
 * actually say.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  detectUnusedIndexes,
  UNUSED_INDEX_MIN_OBSERVATION_DAYS,
} from '@/lib/autonomy/unused-index'
import { executeAction } from '@/lib/ai/minimal-executor'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction } from '@/lib/core/fix-actions'

const LEDGER_TYPE = 'index_usage'

let userId: string
let projectId: string
let schema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

const backdateLedger = async () => {
  const old = new Date(
    Date.now() - (UNUSED_INDEX_MIN_OBSERVATION_DAYS + 1) * 86_400_000,
  ).toISOString()
  const rows = await prisma.projectPreference.findMany({
    where: { projectId, type: LEDGER_TYPE },
    select: { key: true, value: true },
  })
  for (const r of rows) {
    const prior = JSON.parse(r.value)
    await prisma.projectPreference.update({
      where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key: r.key } },
      data: { value: JSON.stringify({ ...prior, firstSeenAt: old }) },
    })
  }
}

const names = (findings: Awaited<ReturnType<typeof detectUnusedIndexes>>) =>
  findings.map(f => (f.details as any).indexName).sort()

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `unused-idx-${Date.now()}@example.test`, password: 'x', name: 'unused idx' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'unused-index-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."posts" (
    id serial primary key, slug text UNIQUE, body text, tag text
  )`)
  // Enough rows that the indexes clear the size floor — a tiny index is
  // deliberately not worth a human's attention.
  await raw(`INSERT INTO "${schema}"."posts"(slug, body, tag)
    SELECT 'slug-'||i, repeat('x',40), 't'||(i%50) FROM generate_series(1,120000) i`)
  await raw(`CREATE INDEX idx_posts_slug ON "${schema}"."posts"(slug)`)
  await raw(`CREATE INDEX idx_posts_tag  ON "${schema}"."posts"(tag)`)
  await raw(`ANALYZE "${schema}"."posts"`)
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('detectUnusedIndexes — evidence gate', () => {
  test('first sight raises nothing and only records a baseline', async () => {
    const findings = await detectUnusedIndexes(projectId)
    expect(findings).toEqual([])

    const ledger = await prisma.projectPreference.findMany({
      where: { projectId, type: LEDGER_TYPE },
      select: { key: true },
    })
    expect(ledger.map(r => r.key).sort()).toEqual(['posts.idx_posts_slug', 'posts.idx_posts_tag'])
  })

  test('constraint-backed indexes never enter the ledger', async () => {
    // posts_pkey and posts_slug_key cannot be removed by DROP INDEX at all, so
    // a finding naming one would have no possible repair.
    const ledger = await prisma.projectPreference.findMany({
      where: { projectId, type: LEDGER_TYPE },
      select: { key: true },
    })
    const keys = ledger.map(r => r.key).join(',')
    expect(keys).not.toContain('posts_pkey')
    expect(keys).not.toContain('posts_slug_key')
  })

  test('a second pass inside the window still raises nothing', async () => {
    expect(await detectUnusedIndexes(projectId)).toEqual([])
  })

  test('after the window, only the genuinely unused index is reported', async () => {
    await backdateLedger()
    // Use ONE of the two so the "no scans at all" claim is falsifiable.
    await prisma.$queryRawUnsafe(`SELECT count(*) FROM "${schema}"."posts" WHERE tag = 't7'`)

    const findings = await detectUnusedIndexes(projectId)
    expect(names(findings)).toEqual(['idx_posts_slug'])

    const d = findings[0].details as any
    expect(findings[0].autoFixable).toBe(false)
    expect(d.observedDays).toBeGreaterThanOrEqual(UNUSED_INDEX_MIN_OBSERVATION_DAYS)
    expect(d.scansInWindow).toBe(0)
    // The measurement, stated. A recommendation without the window behind it is
    // the version of this detector that could never be trusted.
    expect(d.reason).toMatch(/never used it once/i)
    expect(d.reason).toContain(String(d.observedDays))
  })

  test('a counter that went backwards re-baselines instead of reporting', async () => {
    // Only pg_stat_reset() can lower idx_scan. Treating the resulting negative
    // delta as "zero usage" would report an index that may be heavily used.
    await prisma.projectPreference.update({
      where: {
        projectId_type_key: { projectId, type: LEDGER_TYPE, key: 'posts.idx_posts_slug' },
      },
      data: {
        value: JSON.stringify({
          firstSeenAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
          scansAtFirstSeen: 9_999_999,
        }),
      },
    })

    const findings = await detectUnusedIndexes(projectId)
    expect(names(findings)).not.toContain('idx_posts_slug')

    const row = await prisma.projectPreference.findFirst({
      where: { projectId, type: LEDGER_TYPE, key: 'posts.idx_posts_slug' },
      select: { value: true },
    })
    expect(JSON.parse(row!.value).scansAtFirstSeen).toBe(0)
  })

  test('dropping an index forgets its baseline', async () => {
    // Otherwise a recreated index under the same name inherits the old window
    // and can be reported as "never used in 40 days" on the day it is created.
    await raw(`DROP INDEX "${schema}"."idx_posts_slug"`)
    await detectUnusedIndexes(projectId)

    const ledger = await prisma.projectPreference.findMany({
      where: { projectId, type: LEDGER_TYPE },
      select: { key: true },
    })
    expect(ledger.map(r => r.key)).toEqual(['posts.idx_posts_tag'])
  })
})

describe('unused_index routing', () => {
  test('is approval-gated, never automatic', () => {
    const c = classifyFix('unused_index', { tableName: 'posts', indexName: 'idx_posts_slug' })
    expect(c.decision).toBe('approval')
    expect(c.riskNote).toBeTruthy()
  })

  test('the repair needs the index name and never derives one from the table', () => {
    expect(buildFixAction('unused_index', { tableName: 'posts' })).toBeNull()
    expect(buildFixAction('unused_index', { tableName: 'posts', indexName: 'idx_posts_tag' }))
      .toEqual({ action: 'DROP_INDEX', params: { tableName: 'posts', indexName: 'idx_posts_tag' } })
  })
})

describe('DROP_INDEX executor — refuses what DROP INDEX cannot do', () => {
  const run = (params: Record<string, unknown>) =>
    executeAction({ action: 'DROP_INDEX', params } as any, projectId, undefined, 0, undefined, false)

  test('refuses without an index name', async () => {
    const r = await run({ tableName: 'posts' })
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/indexName is required/i)
  })

  test('refuses an identifier that is not one', async () => {
    const r = await run({ indexName: 'a"; DROP TABLE posts; --' })
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/not a valid PostgreSQL identifier/i)
  })

  test('an already-absent index is success, not failure', async () => {
    // A finding can outlive the index it names. Erroring here would escalate a
    // change that has in fact been made.
    const r = await run({ indexName: 'idx_definitely_gone' })
    expect(r.success).toBe(true)
    expect(r.message).toMatch(/no longer exists/i)
  })

  test.each([
    ['posts_pkey', /primary key/i],
    ['posts_slug_key', /uniqueness/i],
  ])('refuses the constraint-backed index %s', async (indexName, expected) => {
    const r = await run({ indexName })
    expect(r.success).toBe(false)
    expect(r.message).toMatch(expected)
    // Still there afterwards.
    const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      schema, indexName,
    )
    expect(rows).toHaveLength(1)
  })

  test('refuses when the named table does not own the index', async () => {
    await raw(`CREATE TABLE IF NOT EXISTS "${schema}"."other" (id serial primary key)`)
    const r = await run({ indexName: 'idx_posts_tag', tableName: 'other' })
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/belongs to "posts"/i)
  })

  test('drops a plain index and leaves the constraint indexes alone', async () => {
    const r = await run({ indexName: 'idx_posts_tag', tableName: 'posts' })
    expect(r.success).toBe(true)

    const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'posts' ORDER BY 1`,
      schema,
    )
    expect(rows.map(x => x.indexname)).toEqual(['posts_pkey', 'posts_slug_key'])
  })
})
