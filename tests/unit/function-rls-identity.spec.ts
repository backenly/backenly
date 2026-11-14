/**
 * Generated functions query with the caller's identity attached.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * Route-module functions were handed the raw Prisma client. Its pooled
 * connection never sets `request.jwt.claims`, so `backenly_jwt_claim('sub')`
 * evaluates to NULL inside every policy their queries touch. Workspace tables
 * are RLS-FORCED, so the owner role is subject to policies too. Against the
 * standard own-rows policy:
 *
 *   backenly_jwt_claim('role') = 'service_role'
 *     OR user_id::text = backenly_jwt_claim('sub')
 *
 *   READS   → matches nothing → HTTP 200 {"orders":[]}
 *   WRITES  → 42501 new row violates row-level security policy
 *
 * The write failure is loud. The read failure is not, and that is the dangerous
 * one — "you have no orders" is a plausible answer. Reported by a user who
 * caught it only because they had just placed the order themselves.
 *
 * It affected EVERY generated route module that read an RLS-protected table:
 * lib/ai/function-generator.ts instructs the model to write
 * `prisma.$queryRawUnsafe` against the workspace schema directly.
 *
 * ── Why the fix is tested here rather than in the prompt ────────────────────
 *
 * The claims are attached to the CONNECTION, so generated code cannot opt out
 * or forget. These tests assert that property: every raw entry point sets the
 * session first, and the identity comes only from verified request material.
 *
 * The handle lives in the function's runner process
 * (lib/services/ai-functions/isolation/function-runner.cjs, makeDatabase); the
 * claims and the statement that sets them are the app's
 * (lib/services/ai-functions/rls-aware-db.ts). Both halves are exercised here,
 * with the runner's login and pool replaced by recording stand-ins.
 */

import { FUNCTION_DB_SESSION_SQL, SERVICE_DB_CLAIMS, functionDbClaims, functionSearchPath } from '@/lib/services/ai-functions/rls-aware-db'
import { jwtClaimsJson, claimRoleFor, type RlsIdentity } from '@/lib/services/rls-session'

const runner = require('../../lib/services/ai-functions/isolation/function-runner.cjs') as {
  makeDatabase: (inv: unknown, logs: string[], deps: unknown) => { prisma: any; asService: (fn: (db: any) => Promise<any>) => Promise<any> }
}

// The transaction seam: every statement the handle runs, in order, on a
// stand-in for the project's own login.
const executed: Array<{ sql: string; params: unknown[] }> = []
const SCHEMA = 'workspace_11111111-2222-4333-8444-555555555555'

function recordingPool(fail?: { onConnect?: unknown; onQuery?: unknown }) {
  return {
    connect: async () => {
      if (fail?.onConnect) throw fail.onConnect
      return {
        query: async (sql: string, params: unknown[] = []) => {
          if (fail?.onQuery && !/^(BEGIN|ROLLBACK)$/.test(sql) && sql !== FUNCTION_DB_SESSION_SQL) throw fail.onQuery
          executed.push({ sql, params })
          return { rows: [{ ok: true }], rowCount: 1 }
        },
        release: () => {},
      }
    },
    end: async () => {},
  }
}

/** Each time the handle asked for the login: whether it asked for a fresh one. */
const logins: boolean[] = []
const login = async (refresh: boolean) => {
  logins.push(refresh)
  return { connectionString: 'postgresql://stand-in/db', searchPath: functionSearchPath(SCHEMA) }
}

function dbFor(identity: RlsIdentity, deps: Record<string, unknown> = {}, logs: string[] = []) {
  return runner.makeDatabase(
    {
      db: { sessionSql: FUNCTION_DB_SESSION_SQL, claims: functionDbClaims(identity), serviceClaims: [...SERVICE_DB_CLAIMS], streamLabel: null },
      text: { asServiceNote: 'ran as the service role' },
    },
    logs,
    { connection: login, createPool: () => recordingPool(), ...deps },
  )
}

/** What the function itself ran, without the transaction around it. */
const statements = () => executed.filter((e) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(e.sql))
const claimsStatement = () => executed.find((e) => e.sql.includes('request.jwt.claims'))

beforeEach(() => {
  executed.length = 0
  logins.length = 0
})

describe('every raw entry point sets the claims first', () => {
  const IDENTITY = { userId: 'u-123', isServiceRole: false }

  it.each([
    ['$queryRawUnsafe', (db: any) => db.$queryRawUnsafe('SELECT 1')],
    ['$executeRawUnsafe', (db: any) => db.$executeRawUnsafe('UPDATE t SET x = 1')],
    ['$queryRaw', (db: any) => db.$queryRaw(Object.assign(['SELECT ', ''], { raw: ['SELECT ', ''] }), 1)],
  ])('%s runs inside a claims-carrying transaction', async (_name, call) => {
    await call(dbFor(IDENTITY).prisma)
    expect(executed[0].sql).toBe('BEGIN')
    // The set_config MUST precede the caller's own statement — after it, the
    // query has already been planned against an empty identity.
    expect(statements().indexOf(claimsStatement()!)).toBe(0)
    expect(statements().length).toBe(2)
    expect(executed[executed.length - 1].sql).toBe('COMMIT')
  })

  it('binds the caller\'s sub, not a placeholder', async () => {
    await dbFor(IDENTITY).prisma.$queryRawUnsafe('SELECT * FROM orders')
    const payload = claimsStatement()!.params.find((p) => typeof p === 'string' && p.startsWith('{')) as string
    expect(JSON.parse(payload)).toEqual({ role: 'authenticated', sub: 'u-123' })
  })

  it('sets both dialects, so policies on either contract match', async () => {
    // PostgREST reads request.jwt.claims; the legacy Express predicates read
    // app.*. A half-migrated project must not be a silent outage.
    await dbFor(IDENTITY).prisma.$queryRawUnsafe('SELECT 1')
    expect(claimsStatement()!.sql).toContain('app.current_user_id')
    expect(claimsStatement()!.sql).toContain('request.jwt.claims')
  })

  it('scopes the settings to the transaction so they cannot leak to a pooled connection', async () => {
    // is_local = true — the third argument to set_config. Without it the
    // identity survives onto the next borrower of the connection, turning a
    // silent-empty bug into a cross-user data leak.
    await dbFor(IDENTITY).prisma.$queryRawUnsafe('SELECT 1')
    expect(claimsStatement()!.sql).toMatch(/set_config\([^)]*,\s*\$\d+,\s*true\)/)
  })

  it('sets the claims once for a caller-opened transaction, covering every statement', async () => {
    await dbFor(IDENTITY).prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT 1')
      await tx.$executeRawUnsafe('UPDATE t SET x = 1')
      await tx.$queryRawUnsafe('SELECT 2')
    })
    const claimsCalls = executed.filter((e) => e.sql.includes('request.jwt.claims'))
    expect(claimsCalls).toHaveLength(1)
    expect(statements().indexOf(claimsCalls[0])).toBe(0)
    expect(statements()).toHaveLength(4)
  })

  it('runs an asService block as the service role, and says so in the run\'s logs', async () => {
    const logs: string[] = []
    await dbFor(IDENTITY, {}, logs).asService((db: any) => db.$queryRawUnsafe('SELECT 1'))
    const payload = claimsStatement()!.params.find((p) => typeof p === 'string' && p.startsWith('{')) as string
    expect(JSON.parse(payload)).toEqual({ role: 'service_role' })
    expect(logs).toEqual(['ran as the service role'])
  })
})

describe('the connection function SQL runs on', () => {
  const IDENTITY = { userId: 'u-123', isServiceRole: false }

  it('asks for the login on the first query, so a handler that never queries opens nothing', async () => {
    const db = dbFor(IDENTITY).prisma
    expect(logins).toHaveLength(0)
    await db.$queryRawUnsafe('SELECT 1')
    await db.$queryRawUnsafe('SELECT 2')
    expect(logins).toEqual([false])
  })

  it('pins search_path to the project schema in the statement that sets the claims', async () => {
    // The role's default cannot be relied on; an unqualified name must mean the
    // project's table, never a platform one.
    await dbFor(IDENTITY).prisma.$queryRawUnsafe('SELECT * FROM orders')
    const first = statements()[0]
    expect(first.sql).toMatch(/set_config\('search_path', \$1, true\)/)
    expect(first.params[0]).toBe(`"${SCHEMA}", public`)
    expect(first.sql).toContain('request.jwt.claims')
  })

  it('asks for a fresh login once when the server refuses it, before any statement ran', async () => {
    let refusals = 1
    const createPool = () => (refusals-- > 0 ? recordingPool({ onConnect: Object.assign(new Error('auth'), { code: '28P01' }) }) : recordingPool())
    await expect(dbFor(IDENTITY, { createPool }).prisma.$queryRawUnsafe('SELECT 1')).resolves.toEqual([{ ok: true }])
    expect(logins).toEqual([false, true])
  })

  it('retries nothing else: a statement that failed may already have run', async () => {
    const createPool = () => recordingPool({ onQuery: Object.assign(new Error('boom'), { code: '42P01' }) })
    const failure = await dbFor(IDENTITY, { createPool }).prisma.$queryRawUnsafe('INSERT INTO t VALUES (1)').then(() => null, (e: any) => e)
    expect(failure.message).toBe('boom')
    // Prisma's raw-query shape beside pg's own, for code written against either.
    expect(failure.meta).toEqual({ code: '42P01', message: 'boom' })
    expect(logins).toEqual([false])
  })

  it('fails every query with the login error when no login can be established', async () => {
    const connection = async () => { throw new Error('login unavailable') }
    const db = dbFor(IDENTITY, { connection }).prisma
    await expect(db.$queryRawUnsafe('SELECT 1')).rejects.toThrow('login unavailable')
    await expect(db.$executeRawUnsafe('SELECT 1')).rejects.toThrow('login unavailable')
    expect(executed).toHaveLength(0)
  })
})

describe('the identity itself', () => {
  it('anon is a real value, not an absence — own-rows matches nothing', () => {
    const anon = { userId: null, isServiceRole: false }
    expect(claimRoleFor(anon)).toBe('anon')
    // `sub` is omitted rather than '' — the claim reader returns NULL for a
    // missing key, which is the semantics PostgREST itself produces.
    expect(JSON.parse(jwtClaimsJson(anon))).toEqual({ role: 'anon' })
  })

  it('service_role is representable only from a server-side decision', () => {
    expect(claimRoleFor({ userId: 'u-1', isServiceRole: true })).toBe('service_role')
    expect(JSON.parse(jwtClaimsJson({ userId: null, isServiceRole: true }))).toEqual({
      role: 'service_role',
    })
  })

  it('a user id makes the caller authenticated', () => {
    expect(claimRoleFor({ userId: 'u-1' })).toBe('authenticated')
  })
})

describe('the platform schema stays out of reach', () => {
  it('exposes no Prisma model accessors', () => {
    // `prisma.user` / `prisma.project` / `prisma.apiKey` address the PLATFORM's
    // public schema. They were reachable from generated functions before. The
    // generator already told the model they do not exist; this makes it true.
    const db = dbFor({ userId: 'u-1' }).prisma
    expect(db.user).toBeUndefined()
    expect(db.project).toBeUndefined()
    expect(db.apiKey).toBeUndefined()
    expect(Object.keys(db).sort()).toEqual([
      '$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$transaction',
    ])
  })
})

/**
 * The two spellings of "here is my token" must be equivalent.
 *
 * Generated route modules auth-gate with the single line the generator's
 * runtime contract shows them:
 *
 *     verifyToken(request.headers.get('x-user-token')?.replace(/^Bearer /,''))
 *
 * So a client sending the idiomatic `Authorization: Bearer <token>` got a 401
 * from `/fn/*` — while `/auth/*` on the SAME project accepted it. One backend,
 * two contradictory answers to "how do I authenticate", and the working one was
 * the non-obvious one. Reported from a real build: "place-order invented a 401
 * auth check I never specified; Authorization: Bearer was rejected, only
 * X-User-Token worked".
 *
 * Normalising in the runner rather than the prompt fixes every ALREADY-DEPLOYED
 * function without regenerating any of them.
 */
describe('authorization and x-user-token are interchangeable', () => {
  // The mirroring logic, extracted exactly as the runner applies it.
  const mirror = (h: Record<string, string>) => {
    const out = { ...h }
    if (out['authorization'] && !out['x-user-token']) out['x-user-token'] = out['authorization']
    else if (out['x-user-token'] && !out['authorization']) out['authorization'] = out['x-user-token']
    return out
  }

  it('a client sending only Authorization reaches a function reading x-user-token', () => {
    const h = mirror({ authorization: 'Bearer abc' })
    expect(h['x-user-token']).toBe('Bearer abc')
  })

  it('a client sending only x-user-token reaches a function reading Authorization', () => {
    const h = mirror({ 'x-user-token': 'Bearer abc' })
    expect(h['authorization']).toBe('Bearer abc')
  })

  it('never overwrites a header the caller set deliberately', () => {
    // If both are present the caller meant both — an admin key alongside a user
    // token is a real combination, and clobbering one would break it.
    const h = mirror({ authorization: 'Bearer admin', 'x-user-token': 'Bearer user' })
    expect(h['authorization']).toBe('Bearer admin')
    expect(h['x-user-token']).toBe('Bearer user')
  })

  it('adds nothing when the caller sent neither', () => {
    const h = mirror({ 'content-type': 'application/json' })
    expect(h['authorization']).toBeUndefined()
    expect(h['x-user-token']).toBeUndefined()
  })
})
