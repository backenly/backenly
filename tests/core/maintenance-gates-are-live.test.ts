/**
 * THE MAINTENANCE GATES ARE WIRED, NOT JUST WRITTEN
 * =================================================
 *
 * Every safety property in the Phase 6b stack was implemented correctly and
 * three of the most load-bearing ones were not reachable. That is a worse
 * failure than a missing check, because reading the code proves the check
 * exists and reading it again proves it is enforced — and those were different
 * questions with different answers:
 *
 *   `isPlanStale`          correct function, and every production caller
 *                          handed it the plan's OWN fingerprint, so it compared
 *                          a value to itself and returned false unconditionally.
 *   `MaintenanceApproval`  correct model, correct unique constraint, and no
 *                          writer anywhere in the tree. The sweep read it every
 *                          pass and could only ever find nothing.
 *   `maxTier`              stored on every approval, read by no code, so
 *                          consent recorded as "up to tier 1" authorised tier 2.
 *   `sweepProjectMaintenance`
 *                          one call site, in a route nothing schedules.
 *
 * These are source-level assertions on purpose. A behavioural test proves the
 * gate works on the path the test drives; these prove there is no OTHER path,
 * which is the property that actually failed. They are cheap, they are exact,
 * and each one names the regression it exists to catch.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * Callers that reach the executor or the dry run in production.
 *
 * Unit tests are deliberately NOT here: `currentCatalogFingerprint` survives as
 * a test seam so a spec can simulate a moved catalog without a database, and
 * pinning the seam shut everywhere would delete that coverage.
 */
const PRODUCTION_CALLERS = [
  'lib/autonomy/maintenance/sweep.ts',
  'scripts/run-maintenance-plan.ts',
]

describe('the catalog staleness gate reads the catalog', () => {
  it.each(PRODUCTION_CALLERS)('%s does not hand the executor its own fingerprint', file => {
    const src = read(file)
    // The exact regression: `currentCatalogFingerprint: catalogFingerprint`,
    // where the right-hand side came from the same resolve() that built the
    // plan. Any assignment of this key from a production caller reintroduces
    // the tautology, so none is permitted rather than only that spelling.
    expect(src).not.toMatch(/currentCatalogFingerprint\s*:/)
  })

  it('the executor recomputes it when the caller supplies none', () => {
    const src = read('lib/autonomy/maintenance/execute.ts')
    expect(src).toContain('computeCatalogFingerprint(input.projectId)')
    expect(src).toContain('isPlanStale(plan, liveFingerprint)')
  })

  it('the dry run recomputes it too', () => {
    const src = read('lib/autonomy/maintenance/dry-run.ts')
    expect(src).toContain('computeCatalogFingerprint(projectId)')
    expect(src).toContain('isPlanStale(plan, liveFingerprint)')
  })
})

describe('consent has a writer', () => {
  const approval = read('lib/autonomy/maintenance/approval.ts')

  it('something in the product can create an approval', () => {
    // The whole defect in one assertion. Before this module existed the only
    // way to authorise a ladder was an INSERT typed into psql by an operator.
    expect(approval).toMatch(/prisma\.maintenanceApproval\.(upsert|create)\(/)
  })

  it('something in the product can withdraw one', () => {
    expect(approval).toContain('revokedAt: new Date()')
  })

  it('the grant path rebuilds the plan before trusting the version it was given', () => {
    // Without the rebuild, a stale browser tab or a replayed agent tool call
    // could authorise a ladder nobody has seen and the sweep would honour it.
    expect(approval).toContain('describePendingLadder')
    expect(approval).toContain('pending.planVersion !== planVersion')
  })

  it('tier 3 cannot be approved, whatever the request body says', () => {
    expect(approval).toContain('MAX_APPROVABLE_TIER = 2')
    expect(approval).toMatch(/Math\.min\(MAX_APPROVABLE_TIER,\s*requested\)/)
  })

  it('the HTTP surface exists and delegates rather than writing its own rules', () => {
    const route = read('app/api/projects/[id]/maintenance/route.ts')
    expect(route).toContain('grantMaintenanceApproval')
    expect(route).toContain('revokeMaintenanceApproval')
    expect(route).toContain('describePendingLadder')
    // A second implementation of the rebuild-and-compare rule is a second
    // opinion about what consent means.
    expect(route).not.toContain('prisma.maintenanceApproval')
  })
})

describe('consent is re-read and its ceiling is enforced', () => {
  const execute = read('lib/autonomy/maintenance/execute.ts')
  const sweep = read('lib/autonomy/maintenance/sweep.ts')

  it('the executor re-reads consent rather than trusting the string it was handed', () => {
    // A ladder can run for minutes across ticks. A revocation that lands
    // mid-flight has to stop the next rung, not be noticed next pass.
    expect(execute).toContain('readLiveApproval(input.plan.planId)')
    expect(execute).toContain('has been withdrawn since it started')
  })

  it('the executor enforces the approval ceiling', () => {
    expect(execute).toMatch(/tier > live\.maxTier/)
  })

  it('the sweep enforces the approval ceiling too', () => {
    // Both, deliberately. The sweep decides whole-ladder eligibility before
    // rung 0 so an unattended run never half-expands a schema; the executor
    // decides again per rung because the row can change in between.
    expect(sweep).toMatch(/c\.tier > approval\.maxTier/)
  })

  it('the sweep reads consent through the one authority', () => {
    expect(sweep).toContain('readLiveApproval')
    expect(sweep).not.toContain('prisma.maintenanceApproval')
  })
})

describe('one process runs a ladder on a project at a time', () => {
  const execute = read('lib/autonomy/maintenance/execute.ts')

  it('guards the executor, not just the scheduler', () => {
    // The scheduler is not the only caller. scripts/run-maintenance-plan.ts
    // reaches executeMaintenancePlan directly from the operator CLI and from
    // the Fargate runner image, so a lock on the sweep alone would leave an
    // operator running one plan by hand while the scheduler ran another.
    expect(execute).toContain('withMaintenanceSingleFlight(input.projectId')
    expect(execute).toContain("status: 'in_flight_elsewhere'")
  })

  it('does not take the lock in the sweep as well', () => {
    // Nested acquisition of the same key would read as contention with itself:
    // advisory locks are re-entrant per session and the guard deliberately
    // treats a second acquire on a held key as "somebody is already running".
    const sweep = read('lib/autonomy/maintenance/sweep.ts')
    expect(sweep).not.toContain('withMaintenanceSingleFlight')
  })

  it('releases on the connection that took it', () => {
    // pg_advisory_lock is SESSION-scoped and prisma.$queryRaw draws an
    // arbitrary pooled connection, so lock-on-A / unlock-on-B silently leaves
    // the lock held until the connection cycles.
    const guard = read('lib/autonomy/maintenance/single-flight.ts')
    expect(guard).toContain('held.set(key, client)')
    expect(guard).toContain('const client = held.get(key)')
    // The property, stated as the thing that actually enforces it: this module
    // owns its own pool and never borrows Prisma's. Asserting the absence of
    // the string `prisma.$queryRaw` would instead match the comment explaining
    // why it is not used.
    expect(guard).not.toMatch(/^import .*'@\/lib\/db'/m)
  })

  it('fails closed when the database cannot be reached', () => {
    // The build lock fails OPEN because blocking a user's build on a lock
    // outage is worse than a rare double build. This one fails closed: it
    // mutates schema unattended, and coordination it cannot confirm is
    // coordination it does not have.
    const guard = read('lib/autonomy/maintenance/single-flight.ts')
    const connectFailure = guard.slice(guard.indexOf('await lockPool.connect()'))
    expect(connectFailure).toMatch(/catch \{[\s\S]{0,400}?return false/)
  })
})

describe('the maintenance sweep is actually scheduled', () => {
  const instrumentation = read('instrumentation.ts')

  it('runs from the in-process scheduler, not only from the unscheduled route', () => {
    // GET /api/cron/autonomy is invoked by nothing on a self-hosted box: no
    // crontab entry, no systemd timer, and Vercel cron declarations do not
    // fire there. It was the sweep's only caller.
    expect(instrumentation).toContain('sweepProjectMaintenance')
  })

  it('is gated by the scheduler flag before it imports anything', () => {
    const block = instrumentation.slice(instrumentation.indexOf('Tier C'))
    expect(block).toContain('ENABLE_MAINTENANCE_SCHEDULER')
    // The flag check must precede the import, so a deployment with the feature
    // off does not pay to load the whole structural-diagnosis engine.
    expect(block.indexOf('ENABLE_MAINTENANCE_SCHEDULER')).toBeLessThan(
      block.indexOf("import('./lib/autonomy/maintenance/sweep')"),
    )
  })
})
