/**
 * Which runtime paths a branch-bound key may reach.
 *
 * The data plane and end-user sign-up, sign-in, refresh and logout are served
 * from a branch. The classifier is the line between "routed to the branch" and
 * "would have been served from production", so these pin both sides of it,
 * including the shapes that sit next to a branch-scoped surface without being
 * part of it (vector search under /db, /fn under the legacy no-project form,
 * the emailed auth flows and OAuth under /auth).
 */

import {
  BRANCH_SURFACE_UNAVAILABLE,
  branchSurfaceRefusal,
  isBranchScopedRuntimePath,
  presentedApiKey,
} from '@/lib/branches/key-scope'

const ID = '11111111-2222-4333-8444-555555555555'

function headers(values: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower[name.toLowerCase()] ?? null }
}

describe('isBranchScopedRuntimePath', () => {
  it.each([
    `/api/v1/${ID}/db/todos`,
    `/api/v1/${ID}/db/todos/42`,
    `/api/v1/${ID}/db/todos?select=id&limit=1`,
    `/api/v2/${ID}/todos`,
    `/api/v2/${ID}/todos?id=eq.1`,
    '/api/v1/todos',
    '/api/v1/todos/42',
    `/api/v1/${ID}`,
    // End-user auth's core, aliases included (lib/branches/auth-environment.ts).
    `/api/v1/${ID}/auth/signup`,
    `/api/v1/${ID}/auth/register`,
    `/api/v1/${ID}/auth/signin`,
    `/api/v1/${ID}/auth/login`,
    `/api/v1/${ID}/auth/refresh-token`,
    `/api/v1/${ID}/auth/refresh`,
    `/api/v1/${ID}/auth/logout`,
  ])('serves %s from the branch', (path) => {
    expect(isBranchScopedRuntimePath(path)).toBe(true)
  })

  it.each([
    // The emailed flows: their link is opened with no key, so it could not say
    // which branch it belongs to. OAuth returns through a provider the same way.
    `/api/v1/${ID}/auth/forgot-password`,
    `/api/v1/${ID}/auth/reset-password`,
    `/api/v1/${ID}/auth/verify-email`,
    `/api/v1/${ID}/auth/resend-verification`,
    `/api/v1/${ID}/auth/magic-link`,
    `/api/v1/${ID}/auth/magic-link/verify`,
    `/api/v1/${ID}/auth/magic`,
    `/api/v1/${ID}/auth/google`,
    `/api/v1/${ID}/auth/signup/extra`,
    `/api/v1/${ID}/auth`,
    `/api/v1/${ID}/fn/send-welcome`,
    `/api/v1/${ID}/functions/invoke`,
    `/api/v1/${ID}/storage/upload`,
    `/api/v1/${ID}/storage/files`,
    `/api/v1/${ID}/realtime`,
    `/api/v1/${ID}/realtime/ticket`,
    `/api/v1/${ID}/presence`,
    `/api/v1/${ID}/broadcast`,
    `/api/v1/${ID}/logs`,
    `/api/v1/${ID}/database/query`,
    `/api/v1/${ID}/database/insert`,
    `/api/v1/${ID}/triggers`,
    `/api/v1/${ID}/checkout`,
    `/api/v1/${ID}/webhooks/stripe`,
    `/api/v1/${ID}/db/documents/vector-search`,
    // /db with no table is not a data-plane request either.
    `/api/v1/${ID}/db`,
    // The legacy no-project form still runs a function under /fn.
    '/api/v1/fn/send-welcome',
  ])('keeps %s on main, so a branch key is refused there', (path) => {
    expect(isBranchScopedRuntimePath(path)).toBe(false)
  })

  it('treats a path it does not recognise as main-only', () => {
    expect(isBranchScopedRuntimePath('/api/v3/whatever')).toBe(false)
    expect(isBranchScopedRuntimePath('/health')).toBe(false)
    expect(isBranchScopedRuntimePath('')).toBe(false)
  })

  it('reads the section case-insensitively, as the routers do', () => {
    expect(isBranchScopedRuntimePath(`/api/v1/${ID}/DB/todos`)).toBe(true)
    expect(isBranchScopedRuntimePath(`/api/v1/${ID}/db/docs/Vector-Search`)).toBe(false)
    expect(isBranchScopedRuntimePath('/api/v1/FN/x')).toBe(false)
  })
})

describe('presentedApiKey', () => {
  it('reads every header the runtime accepts a key from', () => {
    expect(presentedApiKey(headers({ 'x-api-key': 'proj_live_a' }))).toBe('proj_live_a')
    expect(presentedApiKey(headers({ apikey: 'proj_live_b' }))).toBe('proj_live_b')
    expect(presentedApiKey(headers({ authorization: 'Bearer proj_live_c' }))).toBe('proj_live_c')
  })

  it('reads the query parameters EventSource has to use', () => {
    expect(presentedApiKey(headers({}), new URL('http://x/a?apiKey=proj_live_d'))).toBe('proj_live_d')
    expect(presentedApiKey(headers({}), new URL('http://x/a?api_key=proj_live_e'))).toBe('proj_live_e')
  })

  it('prefers the x-api-key header over a Bearer token', () => {
    expect(presentedApiKey(headers({ 'x-api-key': 'proj_live_a', authorization: 'Bearer other' }))).toBe('proj_live_a')
  })

  it('does not mistake a JWT bearer token for a key', () => {
    expect(presentedApiKey(headers({ authorization: 'Bearer aaa.bbb.ccc' }))).toBeNull()
  })

  it('answers null when no key is presented', () => {
    expect(presentedApiKey(headers({}))).toBeNull()
    expect(presentedApiKey(headers({ 'x-api-key': '   ' }))).toBeNull()
    expect(presentedApiKey(headers({ authorization: 'Basic abc' }))).toBeNull()
  })
})

describe('branchSurfaceRefusal', () => {
  it('names the branch and the surfaces that are branch-scoped', () => {
    const r = branchSurfaceRefusal({ id: 'b1', name: 'add-payments', status: 'active' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe(BRANCH_SURFACE_UNAVAILABLE)
    expect(r.body.branch).toBe('add-payments')
    expect(r.body.error).toContain('add-payments')
    expect(r.body.error).toMatch(/production/)
    expect(r.body.branchScoped).toEqual([
      '/api/v1/{projectId}/db/*',
      '/api/v2/{projectId}/*',
      '/api/v1/{projectId}/auth/{signup,signin,refresh-token,logout}',
    ])
  })
})
