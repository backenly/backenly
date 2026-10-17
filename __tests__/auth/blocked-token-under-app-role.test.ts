/**
 * A BLOCKED END USER'S TOKEN IS REFUSED AT REQUEST TIME, UNDER THE APP ROLE
 * =========================================================================
 * Both request-time checks, the runtime's resolveEndUserFromToken and Next's
 * v1ApiMiddleware, read users.is_blocked. The users table is FORCE row-level
 * security with an own-rows policy, and production's app role is NOSUPERUSER
 * NOBYPASSRLS, so the read they made, with no claims, matched no row: a
 * blocked user's token was accepted until it expired. On a superuser
 * connection, as in CI, the same read saw the flag, which is why
 * tests/integration/blocked-end-user-tokens.spec.ts passed.
 *
 * Here every statement on the project's database client runs as a
 * non-superuser, non-bypassing role whenever the suite's connection is a
 * superuser, over a users table provisioned by the real pipeline
 * (ensureAuthUsersTable, which installs the policy):
 *
 *   premise   a claimless read of the blocked row matches nothing
 *   runtime   resolveEndUserFromToken answers 'blocked' for the blocked user
 *             and resolves the other as that user
 *   next      v1ApiMiddleware refuses the blocked user's token 403 and admits
 *             the other's as that end user
 */
import '@/tests/helpers/real-web-standard'

import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'

/** The role the project's client runs as; set in beforeAll on a superuser connection. */
const mockPremise = { role: '' }
jest.mock('@/lib/data-plane/regional', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional')
  // Each call is a transaction that first takes the role, as every statement
  // runs as the app role in production. Nothing else is changed.
  const asRole = (db: any) => {
    const scoped = (run: (tx: any) => Promise<unknown>) =>
      db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        return run(tx)
      })
    return {
      $queryRaw: (...args: any[]) => scoped((tx) => tx.$queryRaw(...args)),
      $queryRawUnsafe: (...args: any[]) => scoped((tx) => tx.$queryRawUnsafe(...args)),
      $executeRaw: (...args: any[]) => scoped((tx) => tx.$executeRaw(...args)),
      $executeRawUnsafe: (...args: any[]) => scoped((tx) => tx.$executeRawUnsafe(...args)),
      $transaction: (run: (tx: any) => Promise<unknown>) => scoped(run),
    }
  }
  return {
    ...actual,
    workspaceRawClient: async (projectId: string) => {
      const db = await actual.workspaceRawClient(projectId)
      return mockPremise.role ? asRole(db) : db
    },
  }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const BROWSER: Record<string, string> = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://app.example.test',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

const BLOCKED = `blocked-${randomUUID().slice(0, 8)}@test.invalid`
const ALLOWED = `allowed-${randomUUID().slice(0, 8)}@test.invalid`
let ownerId = ''
let projectId = ''
let schemaName = ''
let jwtSecret = ''
let clientKey = ''
let blockedId = ''
let allowedId = ''

const tokenFor = (userId: string, email: string) =>
  jwt.sign({ userId, email, projectId, role: 'user', jti: randomUUID() }, jwtSecret, { algorithm: 'HS256', expiresIn: '1h' })

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `blocked-check-${randomUUID()}@test.invalid`, name: 'Blocked Check' },
      select: { id: true },
    })
  ).id
  jwtSecret = randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({
      data: { name: `blocked-check-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret },
      select: { id: true },
    })
  ).id
  schemaName = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await ensureAuthUsersTable(projectId, { email: BLOCKED })
  const [rls] = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'users'`,
    schemaName,
  )
  expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })

  const insert = async (email: string, blocked: boolean) =>
    (
      await executeWithUserContext<{ id: string }>(
        projectId,
        '',
        true,
        `INSERT INTO "${schemaName}"."users" (email, password, is_blocked) VALUES ($1, 'x', $2) RETURNING id::text AS id`,
        [email, blocked],
      )
    )[0].id
  blockedId = await insert(BLOCKED, true)
  allowedId = await insert(ALLOWED, false)

  clientKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'blocked-check', keyPrefix: clientKey.slice(0, 16), keyHash: hashApiKey(clientKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
    },
  })

  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
          CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    mockPremise.role = 'backenly_rls_premise'
  }
}, 60_000)

afterAll(async () => {
  mockPremise.role = ''
  if (schemaName) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('the premise', () => {
  it('a claimless read of the blocked row, on the client both checks use, matches nothing', async () => {
    const db = await workspaceRawClient(projectId)
    const rows = await db.$queryRawUnsafe<unknown[]>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE id::text = $1`,
      blockedId,
    )
    expect(rows).toHaveLength(0)
  })
})

describe('the runtime: resolveEndUserFromToken', () => {
  it("answers 'blocked' for a blocked user's token", async () => {
    expect(await resolveEndUserFromToken(projectId, tokenFor(blockedId, BLOCKED))).toBe('blocked')
  })

  it('resolves an unblocked user as that user', async () => {
    expect(await resolveEndUserFromToken(projectId, tokenFor(allowedId, ALLOWED))).toMatchObject({ userId: allowedId })
  })
})

describe("Next: v1ApiMiddleware", () => {
  const nextReq = (token: string) =>
    new NextRequest(`https://backenly.test/api/v1/${projectId}/storage/files`, {
      headers: { ...BROWSER, 'x-api-key': clientKey, 'x-user-token': token },
    })

  it("refuses a blocked user's token 403", async () => {
    const { response } = await v1ApiMiddleware(nextReq(tokenFor(blockedId, BLOCKED)), { projectId })
    expect(response?.status).toBe(403)
    expect((await response!.json()).error.message).toMatch(/blocked/i)
  })

  it('admits an unblocked user as that end user', async () => {
    const { response, context } = await v1ApiMiddleware(nextReq(tokenFor(allowedId, ALLOWED)), { projectId })
    expect(response).toBeUndefined()
    expect(context.endUserId).toBe(allowedId)
  })
})
