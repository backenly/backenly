/**
 * END-USER EMAIL VERIFICATION IS THE PROJECT'S CHOICE
 * ===================================================
 *
 * `ProjectAuthConfig.requireEmailVerification` (off by default) is the one
 * switch. Before it was honoured end to end, the two signup implementations
 * disagreed: the runtime mailed every new user of every project and added an
 * `email_verified` column to every users table, while the Next route, which
 * serves Backenly Cloud, never mailed and never checked, so the switch did
 * nothing there.
 *
 * Pinned here, against a real workspace schema and the real route handlers:
 *
 *  1. A project that never opted in is left exactly as it was: signup adds no
 *     column and issues no token, and sign-in admits an unverified row.
 *  2. A project that opted in gets the column before the new row is written,
 *     so the new account starts unverified and sign-in refuses it.
 *  3. Adding the column never locks out the users who already exist. The
 *     column used to arrive as NOT NULL DEFAULT FALSE, which marked a project's
 *     entire existing user base unverified the first time any flow touched it.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import { POST as signin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { POST as signup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { hashPassword } from '@/lib/auth/password'
import { ensureEmailVerifiedColumn } from '@/lib/services/end-user-auth-flows'

const prisma = new PrismaClient()
const PASSWORD = 'Correct-Horse-Battery-9'

let ownerId: string
const projects: string[] = []

/** The two members the routes read; see signin-enumeration.spec.ts for why. */
let ipCounter = 0
function request(body: Record<string, unknown>): NextRequest {
  ipCounter += 1
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-forwarded-for', `198.51.100.${ipCounter % 250}`],
  ])
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as NextRequest
}

async function call(handler: typeof signin, projectId: string, body: Record<string, unknown>) {
  const res = await handler(request(body), { params: Promise.resolve({ projectId }) })
  return { status: res.status, body: await res.json() }
}

/** A project whose users table predates verification: two existing accounts, no column. */
async function legacyProject(requireEmailVerification: boolean | null): Promise<{ id: string; schema: string }> {
  const project = await prisma.project.create({
    data: {
      name: 'email-verification-opt-in',
      userId: ownerId,
      description: 'email verification opt-in suite',
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  projects.push(project.id)
  const schema = `workspace_${project.id}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."users" (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email      text UNIQUE NOT NULL,
       password   text NOT NULL,
       name       text,
       role       text DEFAULT 'user',
       is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  const hash = await hashPassword(PASSWORD)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, password, name)
     VALUES ('existing-a@example.test', $1, 'A'), ('existing-b@example.test', $1, 'B')`,
    hash,
  )
  if (requireEmailVerification !== null) {
    await prisma.projectAuthConfig.create({ data: { projectId: project.id, requireEmailVerification } })
  }
  return { id: project.id, schema }
}

async function hasColumn(schema: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email_verified'`,
    schema,
  )
  return rows.length > 0
}

async function hasTable(schema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schema, table,
  )
  return rows.length > 0
}

async function verifiedByEmail(schema: string): Promise<Record<string, boolean>> {
  const rows = await prisma.$queryRawUnsafe<{ email: string; email_verified: boolean }[]>(
    `SELECT email, email_verified FROM "${schema}"."users" ORDER BY email`,
  )
  return Object.fromEntries(rows.map((r) => [r.email, r.email_verified]))
}

/** The verification email is sent without blocking signup; wait for its token row. */
async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `email-verify-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Email Verification Opt-in Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id
}, 60_000)

afterAll(async () => {
  for (const id of projects) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.projectAuthConfig.deleteMany({ where: { projectId: { in: projects } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('adding the column grandfathers the users who already exist', () => {
  it('records existing rows as verified and new rows as unverified', async () => {
    const { schema } = await legacyProject(null)

    await ensureEmailVerifiedColumn(schema)

    expect(await verifiedByEmail(schema)).toEqual({
      'existing-a@example.test': true,
      'existing-b@example.test': true,
    })
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."users" (email, password) VALUES ('later@example.test', 'x')`,
    )
    expect((await verifiedByEmail(schema))['later@example.test']).toBe(false)
  })

  it('never touches the rows again once the column exists', async () => {
    const { schema } = await legacyProject(null)
    await ensureEmailVerifiedColumn(schema)
    await prisma.$executeRawUnsafe(
      `UPDATE "${schema}"."users" SET email_verified = false WHERE email = 'existing-a@example.test'`,
    )

    await ensureEmailVerifiedColumn(schema)

    expect(await verifiedByEmail(schema)).toEqual({
      'existing-a@example.test': false,
      'existing-b@example.test': true,
    })
  })
})

describe('a project that never opted in is left exactly as it was', () => {
  for (const config of [null, false] as const) {
    it(`signup adds no column and sends nothing (config: ${config === null ? 'none' : 'off'})`, async () => {
      const { id, schema } = await legacyProject(config)

      const res = await call(signup, id, { email: 'new@example.test', password: PASSWORD })

      expect(res.status).toBe(201)
      expect(res.body.data.token).toBeTruthy()
      // Give a stray non-blocking send the time it would need, then look.
      await new Promise((r) => setTimeout(r, 500))
      expect(await hasColumn(schema)).toBe(false)
      expect(await hasTable(schema, '_email_verifications')).toBe(false)
    }, 60_000)
  }

  it('sign-in admits a row recorded as unverified', async () => {
    const { id, schema } = await legacyProject(false)
    await ensureEmailVerifiedColumn(schema)
    await prisma.$executeRawUnsafe(
      `UPDATE "${schema}"."users" SET email_verified = false WHERE email = 'existing-a@example.test'`,
    )

    const res = await call(signin, id, { email: 'existing-a@example.test', password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTruthy()
  }, 60_000)
})

describe('a project that opted in', () => {
  it('starts the new account unverified, keeps existing users signed in, and sends the email', async () => {
    const { id, schema } = await legacyProject(true)

    const res = await call(signup, id, { email: 'new@example.test', password: PASSWORD })
    expect(res.status).toBe(201)

    expect(await verifiedByEmail(schema)).toEqual({
      'existing-a@example.test': true,
      'existing-b@example.test': true,
      'new@example.test': false,
    })
    expect(await eventually(async () => {
      if (!(await hasTable(schema, '_email_verifications'))) return false
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM "${schema}"."_email_verifications" WHERE email = 'new@example.test'`,
      )
      return rows.length === 1
    })).toBe(true)

    const existing = await call(signin, id, { email: 'existing-a@example.test', password: PASSWORD })
    expect(existing.status).toBe(200)

    const fresh = await call(signin, id, { email: 'new@example.test', password: PASSWORD })
    expect(fresh.status).toBe(403)
    expect(JSON.stringify(fresh.body)).toContain('EMAIL_NOT_VERIFIED')
  }, 60_000)
})
