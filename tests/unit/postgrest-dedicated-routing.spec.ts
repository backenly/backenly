/**
 * A PROJECT WITH A DATABASE OF ITS OWN IS SERVED BY ITS OWN POSTGREST, OR NONE
 * ===========================================================================
 * projectPostgrest (lib/data-plane/regional.ts) answers, for such a project,
 * the region's PostgREST host at the project's path, with the region's
 * PostgREST secret, and the database the token must name. Without the host
 * address or the secret it is refused, naming the variable: never null, which
 * would let a caller fall back to the region's shared PostgREST, and never that
 * PostgREST's address.
 *
 * The routing for a shared project is the region's, unchanged
 * (tests/unit/data-plane-regional.spec.ts). With real rows, both are exercised
 * in tests/integration/regional-bootstrap.spec.ts.
 */

import { ownDatabasePostgrest, RegionNotConfiguredError } from '@/lib/data-plane/regional'
import { HOME_REGION } from '@/lib/regions'

const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const DB = `p_${'0123456789abcdef'.repeat(2)}`
const SECRET = 'a-region-postgrest-secret-of-at-least-32-chars'

describe('a project with a database of its own', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  it('is served at its path on the region’s PostgREST host, with the region’s secret and its database', async () => {
    const env = {
      PGRST_HOST_URL_US_EAST_1: 'http://pgrst-host.virginia.internal.test:3200/',
      POSTGREST_JWT_SECRET_US_EAST_1: SECRET,
      POSTGREST_URL_US_EAST_1: 'http://postgrest.virginia.internal.test:3000',
    }
    expect(await ownDatabasePostgrest(PROJECT, 'us-east-1', DB, env)).toEqual({
      url: `http://pgrst-host.virginia.internal.test:3200/p/${PROJECT}`,
      jwtSecret: SECRET,
      database: DB,
    })
  })

  it('is refused, naming the host variable, when the region has none, and never sent to the shared PostgREST', async () => {
    const env = { POSTGREST_URL_US_EAST_1: 'http://postgrest.virginia.internal.test:3000', POSTGREST_JWT_SECRET_US_EAST_1: SECRET }
    const attempt = ownDatabasePostgrest(PROJECT, 'us-east-1', DB, env)
    await expect(attempt).rejects.toBeInstanceOf(RegionNotConfiguredError)
    await expect(attempt).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED', variable: 'PGRST_HOST_URL_US_EAST_1' })
    await expect(attempt).rejects.toThrow(/PGRST_HOST_URL_US_EAST_1 is not set/)
  })

  it('is refused, naming the secret variable, when the region has no secret for the host', async () => {
    const env = { PGRST_HOST_URL: 'http://pgrst-host.home.internal.test:3200' }
    await expect(ownDatabasePostgrest(PROJECT, HOME_REGION, DB, env)).rejects.toMatchObject({ variable: 'POSTGREST_JWT_SECRET' })
  })

  it('never borrows the home host for another region', async () => {
    const env = { PGRST_HOST_URL: 'http://pgrst-host.home.internal.test:3200', POSTGREST_JWT_SECRET: SECRET, POSTGREST_JWT_SECRET_EU_CENTRAL_1: SECRET }
    await expect(ownDatabasePostgrest(PROJECT, 'eu-central-1', DB, env)).rejects.toMatchObject({ variable: 'PGRST_HOST_URL_EU_CENTRAL_1' })
  })

  it('refuses a database that is not a project database', async () => {
    const env = { PGRST_HOST_URL: 'http://pgrst-host.home.internal.test:3200', POSTGREST_JWT_SECRET: SECRET }
    await expect(ownDatabasePostgrest(PROJECT, HOME_REGION, 'backenly', env)).rejects.toThrow(/not the name of a project's own database/)
  })
})
