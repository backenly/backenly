/**
 * The RLS session contract.
 *
 * A project whose policies were migrated to the PostgREST form while the legacy
 * Express engine still served it had `/auth/signup` returning 500 for two
 * months and every end-user read coming back empty. Nobody noticed, because an
 * empty list and a broken backend are indistinguishable from outside.
 *
 * These tests pin the property that prevents a repeat: every session setter
 * emits BOTH dialects, so a policy on either contract is satisfied.
 */

import {
  jwtClaimsJson,
  claimRoleFor,
  rlsSessionSql,
  rlsSessionParams,
} from '@/lib/services/rls-session'

describe('claim role', () => {
  it('service role wins over a present user id', () => {
    expect(claimRoleFor({ userId: 'u1', isServiceRole: true })).toBe('service_role')
  })
  it('a user id without service role is authenticated', () => {
    expect(claimRoleFor({ userId: 'u1' })).toBe('authenticated')
  })
  it('no user and no service role is anon, not an absence', () => {
    expect(claimRoleFor({})).toBe('anon')
    expect(claimRoleFor({ userId: '' })).toBe('anon')
  })
})

describe('jwt claims payload', () => {
  it('carries sub for an end user — own-rows policies compare against it', () => {
    expect(JSON.parse(jwtClaimsJson({ userId: 'u1' }))).toEqual({
      role: 'authenticated',
      sub: 'u1',
    })
  })

  it('OMITS sub when there is no user rather than sending an empty string', () => {
    // '' would make owner::text = claim('sub') a defined-FALSE instead of NULL,
    // diverging from what PostgREST produces for an anonymous request.
    const claims = JSON.parse(jwtClaimsJson({}))
    expect(claims).not.toHaveProperty('sub')
    expect(claims.role).toBe('anon')
  })

  it('marks the service role, which is the escape clause in every policy', () => {
    expect(JSON.parse(jwtClaimsJson({ isServiceRole: true })).role).toBe('service_role')
  })

  it('passes user_role through for admin_read_all policies', () => {
    expect(JSON.parse(jwtClaimsJson({ userId: 'u1', userRole: 'admin' })).user_role).toBe('admin')
  })

  it('is valid JSON — the claim reader casts it with ::json and would raise 22P02', () => {
    expect(() => JSON.parse(jwtClaimsJson({ userId: "o'brien" }))).not.toThrow()
    expect(JSON.parse(jwtClaimsJson({ userId: "o'brien" })).sub).toBe("o'brien")
  })
})

describe('session SQL — BOTH dialects, or a migrated project breaks silently', () => {
  const sql = rlsSessionSql()

  it('sets the legacy GUCs', () => {
    expect(sql).toMatch(/app\.current_user_id/)
    expect(sql).toMatch(/app\.is_service_role/)
    expect(sql).toMatch(/app\.user_role/)
  })

  it('ALSO sets request.jwt.claims — the whole point of this module', () => {
    expect(sql).toMatch(/request\.jwt\.claims/)
  })

  it('is transaction-local everywhere, so nothing leaks onto a pooled connection', () => {
    const setCalls = sql.match(/set_config\([^)]*\)/g) ?? []
    expect(setCalls).toHaveLength(4)
    for (const c of setCalls) expect(c).toMatch(/true\s*\)$/)
  })

  it('placeholders line up with the params, in order', () => {
    const params = rlsSessionParams({ userId: 'u1', isServiceRole: false, userRole: 'admin' })
    expect(params).toHaveLength(4)
    // $1..$4 each appear exactly once.
    for (let i = 1; i <= 4; i++) {
      expect(sql.match(new RegExp(`\\$${i}\\b`, 'g'))).toHaveLength(1)
    }
    expect(params[0]).toBe('u1')
    expect(params[1]).toBe('false')
    expect(params[2]).toBe('admin')
    expect(JSON.parse(params[3]).sub).toBe('u1')
  })

  it('supports an offset for callers that already bound parameters', () => {
    expect(rlsSessionSql(5)).toMatch(/\$5\b/)
    expect(rlsSessionSql(5)).toMatch(/\$8\b/)
    expect(rlsSessionSql(5)).not.toMatch(/\$1\b/)
  })
})
