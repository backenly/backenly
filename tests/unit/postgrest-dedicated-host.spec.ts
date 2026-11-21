/**
 * The runtime's side of serving a project from a database of its own.
 *
 *   tokens   the internal token gains `aud` and `db` only when a project
 *            database is named; every other token is byte for byte what the
 *            gateway minted before, so the region's shared PostgREST sees no
 *            change
 *   address  the region's PostgREST host, named like every per-region setting
 *            (PGRST_HOST_URL, PGRST_HOST_URL_<REGION>), never borrowed from
 *            another region
 */

import jwt from 'jsonwebtoken'

import { RegionNotConfiguredError } from '@/lib/data-plane/regional'
import {
  DEDICATED_DATABASE_NAME,
  INTERNAL_TOKEN_TTL_SECONDS,
  internalClaimsFor,
  mintInternalToken,
  upstreamUrl,
} from '@/lib/postgrest/gateway'
import { postgrestHostUrl, regionPostgrestHostUrl } from '@/lib/postgrest/host'
import { HOME_REGION } from '@/lib/regions'

const SECRET = 'a-region-postgrest-secret-of-at-least-32-chars'
const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const DB = `p_${'0123456789abcdef'.repeat(2)}`
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

describe('internal tokens', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW))
  afterEach(() => jest.useRealTimers())

  it('are byte for byte what they were for every project in a shared database', () => {
    const before = (claims: object) => jwt.sign(claims, SECRET, { algorithm: 'HS256', expiresIn: INTERNAL_TOKEN_TTL_SECONDS })
    expect(mintInternalToken(internalClaimsFor({ projectId: PROJECT }), SECRET)).toBe(
      before({ role: 'anon', project_id: PROJECT }),
    )
    expect(mintInternalToken(internalClaimsFor({ projectId: PROJECT, endUserId: 'user-1' }), SECRET)).toBe(
      before({ role: 'authenticated', sub: 'user-1', project_id: PROJECT }),
    )
    expect(mintInternalToken(internalClaimsFor({ projectId: PROJECT, serviceRole: true }), SECRET)).toBe(
      before({ role: 'service_role', project_id: PROJECT }),
    )
    expect(internalClaimsFor({ projectId: PROJECT, database: null })).toEqual({ role: 'anon', project_id: PROJECT })
    expect(Object.keys(jwt.decode(mintInternalToken(internalClaimsFor({ projectId: PROJECT }), SECRET)) as object)).toEqual([
      'role',
      'project_id',
      'iat',
      'exp',
    ])
  })

  it('name the project and its database when the project has a database of its own', () => {
    // The host's own suite (tests/unit/pgrst-host.spec.ts) verifies these tokens.
    for (const input of [{}, { endUserId: 'user-1' }, { serviceRole: true }]) {
      const claims = internalClaimsFor({ projectId: PROJECT, database: DB, ...input })
      expect(claims).toMatchObject({ project_id: PROJECT, aud: PROJECT, db: DB })
      const decoded = jwt.verify(mintInternalToken(claims, SECRET), SECRET, { algorithms: ['HS256'], audience: PROJECT }) as any
      expect(decoded).toMatchObject({ aud: PROJECT, db: DB, exp: decoded.iat + INTERNAL_TOKEN_TTL_SECONDS })
    }
  })

  it('refuse to name anything but a project database', () => {
    for (const bad of ['', 'postgres', 'workspace_x', `p_${'0'.repeat(31)}`, `p_${'A'.repeat(32)}`, `${DB} `]) {
      expect(() => internalClaimsFor({ projectId: PROJECT, database: bad })).toThrow('not a project database name')
    }
    expect(DEDICATED_DATABASE_NAME.test(DB)).toBe(true)
  })
})

describe('the PostgREST host address', () => {
  const env = {
    PGRST_HOST_URL: 'http://pgrst-host.home.internal.test:3200/',
    PGRST_HOST_URL_US_EAST_1: 'http://pgrst-host.virginia.internal.test:3200',
    PGRST_HOST_URL_US_WEST_2: '   ',
  }

  it('is PGRST_HOST_URL at home and PGRST_HOST_URL_<REGION> elsewhere', () => {
    expect(regionPostgrestHostUrl(HOME_REGION, env)).toBe('http://pgrst-host.home.internal.test:3200')
    expect(regionPostgrestHostUrl('us-east-1', env)).toBe('http://pgrst-host.virginia.internal.test:3200')
    expect(postgrestHostUrl(PROJECT, 'us-east-1', env)).toBe(`http://pgrst-host.virginia.internal.test:3200/p/${PROJECT}`)
  })

  it('is never another region’s', () => {
    expect(regionPostgrestHostUrl('us-west-2', env)).toBeNull()
    expect(postgrestHostUrl(PROJECT, 'eu-central-1', env)).toBeNull()
    expect(regionPostgrestHostUrl(HOME_REGION, {})).toBeNull()
  })

  it('serves every request path under the project', () => {
    const base = postgrestHostUrl(PROJECT, HOME_REGION, env)!
    expect(upstreamUrl(base, 'orders', '?select=*')).toBe(`http://pgrst-host.home.internal.test:3200/p/${PROJECT}/orders?select=*`)
  })

  it('refuses a value that is not a plain http(s) address, naming the variable', () => {
    for (const value of ['pgrst-host:3200', 'ftp://h/', 'http://u:p@h:3200', 'http://h:3200/?x=1']) {
      expect(() => regionPostgrestHostUrl(HOME_REGION, { PGRST_HOST_URL: value })).toThrow(RegionNotConfiguredError)
      expect(() => regionPostgrestHostUrl(HOME_REGION, { PGRST_HOST_URL: value })).toThrow('PGRST_HOST_URL')
    }
  })

  it('refuses a project id that could leave its path segment', () => {
    for (const bad of ['../other', 'a/b', 'a?b', '']) {
      expect(() => postgrestHostUrl(bad, HOME_REGION, env)).toThrow()
    }
  })
})
