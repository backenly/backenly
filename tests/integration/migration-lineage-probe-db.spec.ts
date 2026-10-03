/**
 * The lineage probe against a real PostgreSQL.
 *
 * The parts that matter here cannot be unit tested: whether a whole migration
 * file survives as one submission, whether the capture reads the semantics the
 * comparison depends on, whether the RLS reads see a policy that exists, and
 * whether a scratch database is always dropped. The probe runs in local mode
 * against TEST_DATABASE_URL, which is loopback in CI and locally.
 */

import { buildChainInput } from '../../tools/migration-lineage/build-inputs'
import { capabilityStatus } from '../../tools/migration-lineage/probe/capabilities'
import { encodeInput } from '../../tools/migration-lineage/probe/input'
import { runProbe } from '../../tools/migration-lineage/probe/run'

const DATABASE_URL = process.env.TEST_DATABASE_URL as string

jest.setTimeout(180_000)

describe('migration lineage probe against PostgreSQL', () => {
  it('sees a policy it created, and leaves no scratch database behind', async () => {
    const r = await runProbe({ mode: 'tls-rls', databaseUrl: DATABASE_URL, local: true })

    expect({ verdict: r.verdict, failures: r.failures, inconclusive: r.inconclusive }).toEqual({
      verdict: 'LOCAL_ONLY',
      failures: [],
      inconclusive: [],
    })
    // The positive control: "zero policies" has to be a fact, not a bad read.
    expect(r.rlsControl?.failures).toEqual([])
    expect(r.rls?.consistent).toBe(true)
    expect(r.scratch.map(s => ({ created: s.created, dropped: s.dropped }))).toEqual([{ created: true, dropped: true }])
    expect(r.scratchDatabasesAfter).toEqual([])
  })

  it('reports platform capabilities as four separate facts', async () => {
    const r = await runProbe({ mode: 'capture-staging', databaseUrl: DATABASE_URL, local: true })

    const capabilities = r.capabilities!
    expect(capabilities.extensions.map(e => e.name)).toEqual(['pg_stat_statements', 'pgstattuple', 'vector'])
    // Deliberately not asserting which are present: that is an environment fact,
    // and pinning it here would make this test a statement about one machine.
    for (const e of capabilities.extensions) {
      expect(['operational', 'installed_not_operational', 'available_not_installed', 'preload_missing', 'unavailable'])
        .toContain(capabilityStatus(e))
      // Installed means an operational verdict was actually attempted.
      if (e.installedVersion) expect(e.operational).not.toBeNull()
    }

    const pgStatStatements = capabilities.extensions.find(e => e.name === 'pg_stat_statements')!
    expect(pgStatStatements.needsPreload).toBe(true)
    expect(typeof pgStatStatements.preloaded).toBe('boolean')
    // The server's own answer, not the parameter group's.
    expect(capabilities.sharedPreloadLibraries).toMatchObject({ source: expect.any(String), context: expect.any(String) })
  })

  it('replays the legacy chain intact and captures what it built', async () => {
    const r = await runProbe({
      mode: 'replay',
      databaseUrl: DATABASE_URL,
      local: true,
      inputB64: encodeInput(buildChainInput(process.cwd())),
    })

    expect(r.failures).toEqual([])
    expect(r.replay).toMatchObject({ status: 'complete', applied: 18, total: 18 })

    const snapshot = r.snapshot!
    // The chain builds a fraction of the current model. That is the finding, so
    // it is pinned: if this number moves, the evidence corpus moved with it.
    expect(snapshot.tables.filter(t => t.kind === 'r')).toHaveLength(50)
    expect(snapshot.tables.map(t => t.name)).toEqual(expect.arrayContaining(['Deployment', 'users', 'plans']))

    // Columns the current schema.prisma no longer has: this really is the
    // historical chain rather than a projection of today's model.
    expect(snapshot.columns.find(c => c.table === 'plans' && c.name === 'allowFullExport')).toBeTruthy()
    expect(snapshot.columns.find(c => c.table === 'backend_patterns' && c.name === 'failure_count')).toBeTruthy()

    // Semantics the attribution depends on, not just object names.
    const fk = snapshot.constraints.find(c => c.name === 'sessions_userId_fkey')
    expect(fk).toMatchObject({ type: 'f' })
    expect(String(fk?.definition)).toMatch(/ON DELETE CASCADE/)
    const notNull = snapshot.columns.find(c => c.table === 'users' && c.name === 'email')
    expect(notNull).toMatchObject({ not_null: true, type: 'text' })

    expect(r.scratchDatabasesAfter).toEqual([])
  })
})
