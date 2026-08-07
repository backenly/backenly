/**
 * Branch routing, at the point where it becomes a schema selector.
 *
 * `Accept-Profile` chooses which PostgreSQL schema PostgREST reads. The gateway's
 * whole isolation argument is that this header is derived server-side and any
 * client copy is stripped, because a client that can influence it can address
 * another tenant's data.
 *
 * Branches put pressure on exactly that argument: something now has to say WHICH
 * schema, and the tempting design — an `X-Backenly-Branch` request header — is
 * the same bypass rebuilt one layer up. The answer here is that the branch is
 * bound to the API KEY and re-validated at the point of use. These tests pin the
 * validation, and pin that request headers still cannot reach the decision.
 */

import {
  buildUpstreamHeaders,
  profileForBranchSchema,
  profileForProject,
} from '@/lib/postgrest/gateway'

const PROJECT = 'abc123'
const MAIN = 'workspace_abc123'
const BRANCH = 'workspace_abc123_br_add_payments'

describe('profileForBranchSchema', () => {
  it('falls back to main when no branch is bound', () => {
    expect(profileForBranchSchema(PROJECT, null)).toBe(MAIN)
    expect(profileForBranchSchema(PROJECT, undefined)).toBe(MAIN)
    expect(profileForBranchSchema(PROJECT, '')).toBe(MAIN)
  })

  it('serves a branch that belongs to this project', () => {
    expect(profileForBranchSchema(PROJECT, BRANCH)).toBe(BRANCH)
  })

  it('refuses a branch belonging to another project', () => {
    // The isolation property. A mis-scoped or tampered key row naming another
    // tenant's branch must fail loudly rather than be served.
    expect(() =>
      profileForBranchSchema(PROJECT, 'workspace_someoneelse_br_main'),
    ).toThrow(/does not belong to project/)
  })

  it('refuses another project whose id merely starts with ours', () => {
    // `workspace_abc123` is a prefix of `workspace_abc1234`. A naive startsWith
    // on the bare project schema would let a neighbouring tenant through; the
    // check includes the `_br_` separator for exactly this reason.
    expect(() =>
      profileForBranchSchema(PROJECT, 'workspace_abc1234_br_x'),
    ).toThrow(/does not belong to project/)
  })

  it('refuses the main schema dressed as a branch', () => {
    expect(() => profileForBranchSchema(PROJECT, `${MAIN}_br_`)).toThrow(/invalid branch identifier|does not belong/)
  })

  it('refuses an identifier that could break out of the header', () => {
    expect(() =>
      profileForBranchSchema(PROJECT, `${MAIN}_br_x", "y`),
    ).toThrow(/invalid branch identifier/)
  })

  it('refuses a branch suffix with a hyphen, which is not a valid schema ident', () => {
    // branchSchemaName() converts hyphens to underscores; anything still
    // carrying one did not come from there.
    expect(() => profileForBranchSchema(PROJECT, `${MAIN}_br_add-payments`)).toThrow()
  })

  it('still refuses an invalid projectId', () => {
    expect(() => profileForBranchSchema('../etc', BRANCH)).toThrow(/invalid projectId/)
  })
})

describe('buildUpstreamHeaders — the client cannot choose the schema', () => {
  const token = 'internal.jwt.token'

  it('sets both profile headers to main by default', () => {
    const h = buildUpstreamHeaders({}, { projectId: PROJECT, internalToken: token, method: 'POST' })
    expect(h['accept-profile']).toBe(MAIN)
    // Writes read Content-Profile, not Accept-Profile. A gateway that set only
    // the former would point mutations at the default schema.
    expect(h['content-profile']).toBe(MAIN)
  })

  it('routes both profile headers to the branch when the key is bound to one', () => {
    const h = buildUpstreamHeaders(
      {},
      { projectId: PROJECT, internalToken: token, method: 'PATCH', branchSchema: BRANCH },
    )
    expect(h['accept-profile']).toBe(BRANCH)
    expect(h['content-profile']).toBe(BRANCH)
  })

  it('omits Content-Profile on reads, as before', () => {
    const h = buildUpstreamHeaders(
      {},
      { projectId: PROJECT, internalToken: token, method: 'GET', branchSchema: BRANCH },
    )
    expect(h['accept-profile']).toBe(BRANCH)
    expect(h['content-profile']).toBeUndefined()
  })

  it('strips a client-supplied Accept-Profile even when a branch is in play', () => {
    // The original bypass, re-checked on the new code path.
    const h = buildUpstreamHeaders(
      { 'accept-profile': 'workspace_victim', 'content-profile': 'workspace_victim' },
      { projectId: PROJECT, internalToken: token, method: 'POST', branchSchema: BRANCH },
    )
    expect(h['accept-profile']).toBe(BRANCH)
    expect(h['content-profile']).toBe(BRANCH)
  })

  it('ignores a branch header the client invents', () => {
    // There is deliberately no header that selects a branch. If one is ever
    // added, this test fails and the isolation argument gets re-examined.
    const h = buildUpstreamHeaders(
      { 'x-backenly-branch': 'add_payments', 'x-branch': 'add_payments' },
      { projectId: PROJECT, internalToken: token, method: 'GET' },
    )
    expect(h['accept-profile']).toBe(MAIN)
  })

  it('refuses to build headers for another project branch', () => {
    expect(() =>
      buildUpstreamHeaders(
        {},
        {
          projectId: PROJECT,
          internalToken: token,
          method: 'GET',
          branchSchema: 'workspace_victim_br_main',
        },
      ),
    ).toThrow(/does not belong to project/)
  })

  it('still strips the caller credentials it always stripped', () => {
    const h = buildUpstreamHeaders(
      { 'x-api-key': 'secret', 'x-user-token': 'jwt', authorization: 'Bearer caller' },
      { projectId: PROJECT, internalToken: token, method: 'GET', branchSchema: BRANCH },
    )
    expect(h['x-api-key']).toBeUndefined()
    expect(h['x-user-token']).toBeUndefined()
    expect(h['authorization']).toBe(`Bearer ${token}`)
  })
})

describe('branch routing is not served yet, and says so', () => {
  it('registerSchemaByName refuses a branch schema with the measured reason', async () => {
    const { registerSchemaByName } = await import('@/lib/postgrest/registration')
    const res = await registerSchemaByName(BRANCH)
    expect(res.registered).toBe(false)
    // The refusal must name row security, because the next person to try this
    // will otherwise "fix" it by widening the registry regex and ship an
    // unprotected copy of a tenant's data.
    expect(res.error).toMatch(/row/i)
  })

  it('still registers an ordinary workspace schema unchanged', async () => {
    // The guard must key on the branch marker, not on anything that could catch
    // a normal schema and take the whole data plane down.
    const { registerSchemaByName } = await import('@/lib/postgrest/registration')
    const res = await registerSchemaByName(MAIN)
    // Reaches the SQL path (which fails without a database here) rather than
    // being short-circuited by the branch guard.
    expect(res.error ?? '').not.toMatch(/row-level security/i)
  })
})

describe('profileForProject is unchanged', () => {
  it('still returns the main schema and still validates', () => {
    expect(profileForProject(PROJECT)).toBe(MAIN)
    expect(() => profileForProject('bad/id')).toThrow()
  })
})
