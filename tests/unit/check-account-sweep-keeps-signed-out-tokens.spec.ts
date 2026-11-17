/**
 * The hourly check-account sweep (purgeSyntheticAuthArtifacts, run for every
 * project by the contract verifier) prunes only expired token revocations.
 *
 * A signed-out token stays valid until it expires, and the runtime does not
 * check that its user still exists, so the `_token_blacklist` row is what keeps
 * it refused. The sweep used to empty the whole list once a project had no user
 * left, which let every signed-out token of a deleted user work again until it
 * expired.
 *
 * Database-free: the RLS layer is stubbed and the statements it receives are read.
 */

const statements: string[] = []
let users = 0
jest.mock('@/lib/services/workspace-rls', () => ({
  executeWithUserContext: jest.fn(async (_p: string, _u: string, _s: boolean, sql: string) => {
    statements.push(sql)
    if (/information_schema\.tables/.test(sql)) {
      return ['users', '_email_verifications', '_magic_links', '_password_resets', '_token_blacklist'].map((table_name) => ({ table_name }))
    }
    if (/count\(\*\)/i.test(sql)) return [{ n: BigInt(users) }]
    return /RETURNING/.test(sql) ? [{ x: 1 }] : []
  }),
}))
jest.mock('@/lib/db', () => ({ prisma: {} }))
jest.mock('@/lib/data-plane/regional', () => ({ workspaceRawClient: jest.fn() }))

import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'

const blacklistDeletes = () => statements.filter((sql) => /DELETE FROM "[^"]+"\."_token_blacklist"/.test(sql))

beforeEach(() => {
  statements.length = 0
})

it.each([0, 3])('with %i users left, prunes only expired revocations', async (n) => {
  users = n
  await purgeSyntheticAuthArtifacts('6c1f0a8e-0d4e-4c55-9a3e-2f7b0c9d1e2a')
  expect(blacklistDeletes()).toEqual([expect.stringMatching(/WHERE expires_at < NOW\(\) RETURNING/)])
  expect(statements.join('\n')).not.toMatch(/"_token_blacklist" WHERE TRUE/)
})

it('a targeted purge of one address leaves the revocation list alone', async () => {
  users = 0
  await purgeSyntheticAuthArtifacts('6c1f0a8e-0d4e-4c55-9a3e-2f7b0c9d1e2a', { email: 'check@backenly.internal' })
  expect(blacklistDeletes()).toEqual([])
})
