import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Anything that reads workspace ROWS on the operator's behalf must carry a
 * service-role RLS context.
 *
 * Every workspace table is FORCE ROW LEVEL SECURITY, and FORCE binds the
 * table's owner too. A query issued with no RLS session variables therefore has
 * a null `backenly_jwt_claim('sub')` and a false service-role clause, so every
 * owner-scoped policy matches nothing. The dashboard reported a table holding
 * real rows as empty — while the customer's own app read those same rows back
 * with an end-user JWT, and MCP's run_query reported them correctly in the same
 * second, because that path already elevated.
 *
 * The failure scaled with security: each table that gained a policy became
 * another table the inspector could not see.
 */
describe('the dashboard reads workspace rows as the owner, not as nobody (P1)', () => {
  it('getTableRows runs its COUNT through the RLS-aware executor', () => {
    const hybrid = read('lib/db/hybrid.ts')
    const fn = hybrid.slice(hybrid.indexOf('static async getTableRows'))
    const body = fn.slice(0, fn.indexOf('\n  static ', 10))
    expect(body).toContain('executeWithUserContext')
    expect(body).not.toMatch(/const countResult = await prisma\.\$queryRaw/)
  })

  it('getTableRows fetches its DATA through the same path', () => {
    const hybrid = read('lib/db/hybrid.ts')
    const fn = hybrid.slice(hybrid.indexOf('static async getTableRows'))
    const body = fn.slice(0, fn.indexOf('\n  static ', 10))
    expect(body).toContain('runAsOwner<any>(dataQuery)')
    expect(body).not.toMatch(/const data = await prisma\.\$queryRaw<any\[\]>\(dataQuery\)/)
  })

  it('the sidebar row count uses the owner-context pool helper', () => {
    const stats = read('lib/services/workspace-table-stats.ts')
    expect(stats).toContain('queryWorkspaceAsOwner')
    // The COUNT specifically — not merely imported somewhere.
    const idx = stats.indexOf('SELECT COUNT(*)::text AS count')
    expect(stats.slice(Math.max(0, idx - 400), idx)).toContain('queryWorkspaceAsOwner')
  })

  it('elevation is transaction-local so it cannot leak to the next pool borrower', () => {
    const pool = read('lib/services/workspace-pool.ts')
    const fn = pool.slice(pool.indexOf('export async function queryWorkspaceAsOwner'))
    const body = fn.slice(0, 2200)
    expect(body).toContain("client.query('BEGIN')")
    expect(body).toContain("client.query('COMMIT')")
    expect(body).toContain('ROLLBACK')
    expect(body).toContain('isServiceRole: true')
  })

  it('the generic queryWorkspace is NOT silently elevated', () => {
    // Elevating the shared helper would turn a display bug into an exposure.
    const pool = read('lib/services/workspace-pool.ts')
    const generic = pool.slice(
      pool.indexOf('export async function queryWorkspace<'),
      pool.indexOf('export async function queryWorkspaceAsOwner'),
    )
    expect(generic).not.toContain('isServiceRole: true')
  })
})

describe('bootstrap answers the verb callers actually use (P1)', () => {
  it('the Express route serves GET and POST from one handler', () => {
    const s = read('server/routes/bootstrap.ts')
    expect(s).toContain("router.get('/:projectId/bootstrap', handleBootstrap)")
    expect(s).toContain("router.post('/:projectId/bootstrap', handleBootstrap)")
  })

  it('the Next twin exposes POST too', () => {
    const s = read('app/api/v1/[projectId]/bootstrap/route.ts')
    expect(s).toMatch(/export async function POST/)
  })

  it('both preflights advertise POST', () => {
    expect(read('server/routes/bootstrap.ts')).toContain("'GET, POST, OPTIONS'")
    expect(read('app/api/v1/[projectId]/bootstrap/route.ts')).toContain("'GET, POST, OPTIONS'")
  })
})

describe('publish refusal names its blockers (P1)', () => {
  it('the go-live route lists the failing checks in the error itself', () => {
    const s = read('app/api/projects/[id]/go-live/route.ts')
    expect(s).toContain('Blocking:')
    expect(s).not.toContain('Details are in the readiness panel.')
  })

  it('the readiness panel sorts failures above passes before capping', () => {
    const s = read('app/app/projects/[id]/deploy/page.tsx')
    expect(s).toContain('const orderedChecks')
    expect(s).toContain('visibleChecks.map')
    // The unsorted crop is what hid the blocker.
    expect(s).not.toContain('readinessChecks.slice(0, 8).map')
  })
})
