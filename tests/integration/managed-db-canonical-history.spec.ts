/**
 * Does the canonical migration chain still produce schema.prisma?
 *
 * Once a forward migration exists, "the baseline equals the model" stops being
 * true and stops being checkable in the unit suite. The live invariant is that
 * baseline PLUS every migration after it equals the model, and only Prisma can
 * answer that: it replays the chain into a shadow database and diffs the result.
 * So this needs a real engine, twice over, for the shadow database and for the
 * scratch database that contains it.
 *
 * This is the gate that catches a schema.prisma edit shipped without a
 * migration, which is exactly how the managed database lost its history the
 * first time.
 */

import { verifyCanonicalHistory } from '../../tools/managed-db/verify-canonical-history'
import { listScratchDatabases } from '../../tools/managed-db/scratch-database'
import { clientConfig, connect, parseDatabaseUrl } from '../../tools/migration-lineage/probe/connect'
import { join } from 'node:path'

const DATABASE_URL = process.env.TEST_DATABASE_URL as string
const ROOT = join(__dirname, '..', '..')

jest.setTimeout(300_000)

describe('the canonical migration chain', () => {
  it('replays to exactly schema.prisma, and leaves no scratch database behind', async () => {
    const check = await verifyCanonicalHistory(ROOT, DATABASE_URL)

    // Non-vacuity: a chain of one migration would pass this trivially, and the
    // whole point of the runner is that forward migrations exist.
    expect(check.migrations.length).toBeGreaterThan(1)
    expect(check.migrations[0]).toBe('00000000000000_baseline')

    // An empty diff is either nothing at all or Prisma's "empty migration"
    // comment, so the reconciling SQL is asserted directly too: no statement of
    // any kind is the property, and it names the drift when there is some.
    expect({ inSync: check.inSync, drift: check.drift }).toMatchObject({ inSync: true })
    expect(check.drift.replace(/^\s*--.*$/gm, '').trim()).toBe('')

    const { target } = parseDatabaseUrl(DATABASE_URL)
    const admin = await connect(clientConfig(target, { mode: 'loopback-plaintext' }))
    try {
      expect(await listScratchDatabases(admin)).toEqual([])
    } finally {
      await admin.end().catch(() => {})
    }
  })
})
