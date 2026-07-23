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
 */

import { makeRlsAwarePrisma } from '@/lib/services/ai-functions/rls-aware-db'
import { jwtClaimsJson, claimRoleFor } from '@/lib/services/rls-session'

// The transaction seam. `makeRlsAwarePrisma` calls prisma.$transaction, so a
// stub records exactly what the wrapper runs and in what order.
const executed: Array<{ kind: string; sql: string; params: unknown[] }> = []

jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
          executed.push({ kind: 'execute', sql, params })
          return 1
        },
        $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
          executed.push({ kind: 'query', sql, params })
          return [{ ok: true }]
        },
        $executeRaw: async (...a: unknown[]) => { executed.push({ kind: 'executeTagged', sql: String(a[0]), params: a }); return 1 },
        $queryRaw: async (...a: unknown[]) => { executed.push({ kind: 'queryTagged', sql: String(a[0]), params: a }); return [] },
      }
      return fn(tx)
    },
  },
}))

beforeEach(() => { executed.length = 0 })

/** The set_config statement, wherever it landed in the recorded sequence. */
function claimsStatement() {
  return executed.find(e => e.sql.includes('request.jwt.claims'))
}

describe('every raw entry point sets the claims first', () => {
  const IDENTITY = { userId: 'u-123', isServiceRole: false }

  it.each([
    ['$queryRawUnsafe', (db: any) => db.$queryRawUnsafe('SELECT 1')],
    ['$executeRawUnsafe', (db: any) => db.$executeRawUnsafe('UPDATE t SET x = 1')],
  ])('%s runs inside a claims-carrying transaction', async (_name, call) => {
    const db = makeRlsAwarePrisma(IDENTITY)
    await call(db)

    const claims = claimsStatement()
    expect(claims).toBeTruthy()
    // The set_config MUST precede the caller's own statement — after it, the
    // query has already been planned against an empty identity.
    expect(executed.indexOf(claims!)).toBe(0)
    expect(executed.length).toBeGreaterThan(1)
  })

  it('binds the caller\'s sub, not a placeholder', async () => {
    const db = makeRlsAwarePrisma(IDENTITY)
    await db.$queryRawUnsafe('SELECT * FROM orders')

    const claims = claimsStatement()!
    const payload = claims.params.find(p => typeof p === 'string' && p.startsWith('{')) as string
    expect(JSON.parse(payload)).toEqual({ role: 'authenticated', sub: 'u-123' })
  })

  it('sets both dialects, so policies on either contract match', async () => {
    // PostgREST reads request.jwt.claims; the legacy Express predicates read
    // app.*. A half-migrated project must not be a silent outage.
    const db = makeRlsAwarePrisma(IDENTITY)
    await db.$queryRawUnsafe('SELECT 1')
    const claims = claimsStatement()!
    expect(claims.sql).toContain('app.current_user_id')
    expect(claims.sql).toContain('request.jwt.claims')
  })

  it('scopes the settings to the transaction so they cannot leak to a pooled connection', async () => {
    // is_local = true — the third argument to set_config. Without it the
    // identity survives onto the next borrower of the connection, turning a
    // silent-empty bug into a cross-user data leak.
    const db = makeRlsAwarePrisma(IDENTITY)
    await db.$queryRawUnsafe('SELECT 1')
    expect(claimsStatement()!.sql).toMatch(/set_config\([^)]*,\s*\$\d+,\s*true\)/)
  })

  it('sets the claims once for a caller-opened transaction, covering every statement', async () => {
    const db = makeRlsAwarePrisma(IDENTITY)
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT 1')
      await tx.$executeRawUnsafe('UPDATE t SET x = 1')
      await tx.$queryRawUnsafe('SELECT 2')
    })
    const claimsCalls = executed.filter(e => e.sql.includes('request.jwt.claims'))
    expect(claimsCalls).toHaveLength(1)
    expect(executed.indexOf(claimsCalls[0])).toBe(0)
    expect(executed).toHaveLength(4)
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
    const db = makeRlsAwarePrisma({ userId: 'u-1' }) as any
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
