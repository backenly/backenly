/**
 * `read_backend_state` must not make an RLS gap look like an absence.
 *
 * The old report had two independent lies in one block:
 *
 *   1. The count came from the PermissionPolicy METADATA table — one row per
 *      applied template — while the database holds four policies per template.
 *      A project with 6 live policies on a single table read "7 policies ·
 *      across 6 tables".
 *   2. It listed only tables that HAD policies. A table with zero read as
 *      absent, which an agent skims as "not mentioned, therefore fine". The two
 *      states that actually matter — RLS on with no policies (denies everyone)
 *      and RLS off (open to everyone) — were both invisible.
 *
 * `formatProof` is pure, so both are assertable without a database.
 */

import { formatProof, type ProofBlock } from '@/lib/ai/proof-system'
import { RLS_COMMANDS } from '@/lib/services/workspace-rls'

function proof(over: Partial<ProofBlock>): ProofBlock {
  return {
    tables: ['profiles', 'connections'],
    apis: [],
    authEnabled: true,
    authProviders: ['email'],
    rlsPolicies: [],
    rlsByTable: [],
    integrations: [],
    buckets: [],
    realtimeTables: [],
    nothingBuilt: false,
    ...over,
  }
}

const HEALTHY = {
  table: 'profiles',
  rlsEnabled: true,
  forced: true,
  policyCount: 4,
  commands: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
}

describe('P1-7: the RLS section counts LIVE policies', () => {
  it('reports the real policy total, not one row per template', () => {
    const out = formatProof(proof({ rlsByTable: [HEALTHY] }))
    expect(out).toMatch(/4 live policies/)
    expect(out).toMatch(/from pg_policies/)
  })

  it('reports per-table counts rather than one project-wide number', () => {
    const out = formatProof(
      proof({
        rlsByTable: [HEALTHY, { ...HEALTHY, table: 'posts', policyCount: 2, commands: ['SELECT', 'INSERT'] }],
      }),
    )
    expect(out).toMatch(/profiles — 4 policies/)
    expect(out).toMatch(/posts — 2 policies/)
  })

  it('names the commands a table has NO policy for, since those are denied', () => {
    const out = formatProof(
      proof({ rlsByTable: [{ ...HEALTHY, policyCount: 2, commands: ['SELECT', 'INSERT'] }] }),
    )
    expect(out).toMatch(/no policy for UPDATE\/DELETE \(denied to end-users\)/)
  })

  it('says "on N of M tables" so an unmentioned table is not implied healthy', () => {
    const out = formatProof(
      proof({
        rlsByTable: [HEALTHY, { table: 'connections', rlsEnabled: true, forced: true, policyCount: 0, commands: [] }],
      }),
    )
    expect(out).toMatch(/on 1 of 2 tables/)
  })
})

describe('P0-4 / P1-7: the two dangerous states are stated, not omitted', () => {
  // The exact reported case: a FORCE-RLS table with zero policies that survived
  // a failed approval and an entire release without one surface mentioning it.
  it('warns loudly about RLS enabled with zero policies', () => {
    const out = formatProof(
      proof({
        rlsByTable: [{ table: 'connections', rlsEnabled: true, forced: true, policyCount: 0, commands: [] }],
      }),
    )
    expect(out).toMatch(/⚠ connections/)
    expect(out).toMatch(/ZERO policies/)
    expect(out).toMatch(/FORCED/)
    // The consequence must be named. "0 policies" alone reads as a tidy state.
    expect(out).toMatch(/DEAD to your app, not protected/)
    expect(out).toMatch(/add_rls/)
  })

  it('warns about a table with no row-level security at all', () => {
    const out = formatProof(
      proof({ rlsByTable: [{ table: 'posts', rlsEnabled: false, forced: false, policyCount: 0, commands: [] }] }),
    )
    expect(out).toMatch(/⚠ posts — no row-level security/)
    expect(out).toMatch(/reachable by any caller holding an API key/)
  })

  it('a zero-policy table is never silently omitted', () => {
    const out = formatProof(
      proof({
        rlsByTable: [HEALTHY, { table: 'connections', rlsEnabled: true, forced: true, policyCount: 0, commands: [] }],
      }),
    )
    expect(out).toContain('connections')
  })
})

describe('the RLS section stays quiet when there is nothing to say', () => {
  it('omits the block entirely for a project with no tables', () => {
    expect(formatProof(proof({ tables: [], rlsByTable: [] }))).not.toMatch(/Row-Level Security/)
  })
})

describe('the command vocabulary is shared, not re-declared', () => {
  // Two lists of "the four commands" drifting apart is exactly how a per-command
  // feature ends up handling three of them.
  it('workspace-rls exports the same four commands the report names', () => {
    expect(RLS_COMMANDS.map((c) => c.toUpperCase())).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  })
})
