/**
 * The login a function's SQL runs as: how it is named, keyed and reached, and
 * that every way of not having one refuses to run rather than falling back to
 * the app's own connection. The database side is proven against a real
 * PostgreSQL in __tests__/database/function-sql-isolation.test.ts.
 */

const mockQueryRaw = jest.fn()
jest.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => mockQueryRaw(...a) } }))
jest.mock('@/lib/services/workspace-pool', () => ({
  resolveWorkspaceSchema: async (id: string) => (id === 'bad' ? 'public' : `workspace_${id}`),
}))

import {
  functionRoleName,
  functionRolePassword,
  functionDatabaseUrl,
  functionDbClient,
  FunctionDbRoleUnavailableError,
} from '@/lib/services/ai-functions/function-db-role'

const PID = '11111111-2222-4333-8444-555555555555'
const SCHEMA = `workspace_${PID}`
const env = { ...process.env }

beforeEach(() => {
  mockQueryRaw.mockReset()
  process.env = { ...env, JWT_SECRET: 'unit-secret', DATABASE_URL: 'postgresql://app:apppw@db.internal:5432/backenly?sslmode=require' }
  delete process.env.ENV_VAR_ENCRYPTION_KEY
})
afterAll(() => { process.env = env })

describe('naming', () => {
  it('derives an opaque per-schema name, the same one the SQL helper derives', () => {
    // public.backenly_fn_role_name(): 'bkn_fn_' || left(encode(sha256(schema), 'hex'), 12)
    expect(functionRoleName(SCHEMA)).toMatch(/^bkn_fn_[0-9a-f]{12}$/)
    expect(functionRoleName(SCHEMA)).not.toBe(functionRoleName(`workspace_${'2'.repeat(8)}-2222-4333-8444-555555555555`))
  })
})

describe('the password', () => {
  it('is derived, deterministic per schema, and long enough for the helper', () => {
    const a = functionRolePassword(SCHEMA)
    expect(a).toBe(functionRolePassword(SCHEMA))
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(a).not.toBe(functionRolePassword('workspace_other'))
  })

  it('prefers the env-var cipher key, as projectEnvCrypto does', () => {
    const fromJwt = functionRolePassword(SCHEMA)
    process.env.ENV_VAR_ENCRYPTION_KEY = 'cipher-key'
    expect(functionRolePassword(SCHEMA)).not.toBe(fromJwt)
  })

  it('refuses without any secret to derive it from', () => {
    delete process.env.JWT_SECRET
    expect(() => functionRolePassword(SCHEMA)).toThrow(FunctionDbRoleUnavailableError)
  })
})

describe('the connection string', () => {
  it('is the app’s own, with the login swapped in and a small pool', () => {
    const url = new URL(functionDatabaseUrl('bkn_fn_0123456789ab', 'pw'))
    expect(url.username).toBe('bkn_fn_0123456789ab')
    expect(url.password).toBe('pw')
    expect(url.host).toBe('db.internal:5432')
    expect(url.pathname).toBe('/backenly')
    expect(url.searchParams.get('sslmode')).toBe('require')
    expect(url.searchParams.get('connection_limit')).toBe('2')
  })
})

describe('never falling back to the app connection', () => {
  it('refuses a project whose schema is not a workspace schema', async () => {
    await expect(functionDbClient('bad')).rejects.toThrow(FunctionDbRoleUnavailableError)
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  it('says the helper is missing when it is not installed', async () => {
    mockQueryRaw.mockRejectedValue(new Error('function public.backenly_fn_role_sync(text, text) does not exist'))
    const err = await functionDbClient(PID).catch((e) => e)
    expect(err).toBeInstanceOf(FunctionDbRoleUnavailableError)
    expect(err.code).toBe('FUNCTION_DB_ROLE_UNAVAILABLE')
    expect(err.message).toMatch(/not installed/)
    expect(err.message).toMatch(/postgrest-install\.sh/)
  })

  it('refuses a role name the helper should never have returned', async () => {
    mockQueryRaw.mockResolvedValue([{ role: 'backenly_app' }])
    await expect(functionDbClient(PID)).rejects.toThrow(/unexpected role/)
  })
})
