/**
 * A CHANGE FROM NOTHING IS NOT "+100%"
 * ====================================
 * Production QA (2026-11-09): Auth & Users said "+100% vs previous period"
 * where the previous period had no sign-ups. A rise from zero has no
 * percentage; the route made one up. It now says there is nothing to compare
 * against (null), and the page shows no comparison. A real previous period
 * still gives a real one.
 *
 * Against a real database, through the route as the console calls it.
 */
import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { GET as statsGET } from '@/app/api/auth/users/stats/route'

let ownerId: string
let projectId: string
let schema: string
let token: string
const originalEdition = process.env.BACKENLY_EDITION

async function stats() {
  const res = await statsGET(
    new NextRequest('http://localhost:3000/api/auth/users/stats', {
      headers: { cookie: `auth-token=${token}`, 'x-project-id': projectId },
    }),
  )
  expect(res.status).toBe(200)
  return res.json()
}

/** An end user, created and last signed in that many hours ago. */
async function user(email: string, createdHoursAgo: number, lastLoginHoursAgo: number | null) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" ("email", "createdAt", "last_login")
     VALUES ($1, NOW() - make_interval(hours => $2::int), CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - make_interval(hours => $3::int) END)`,
    email,
    createdHoursAgo,
    lastLoginHoursAgo,
  )
}

beforeAll(async () => {
  // Many projects share the test database, as on Cloud.
  process.env.BACKENLY_EDITION = 'cloud'
  const email = `auth-stats-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  token = (await createSession(ownerId, email)).token
  projectId = (await prisma.project.create({ data: { name: 'auth-stats', userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  // The end-user table as auth provisions it (lib/services/end-user-auth-table.ts).
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."users" (
      "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "email"      TEXT UNIQUE NOT NULL,
      "password"   TEXT,
      "name"       TEXT,
      "role"       TEXT NOT NULL DEFAULT 'user',
      "is_blocked" BOOLEAN NOT NULL DEFAULT FALSE,
      "last_login" TIMESTAMP WITH TIME ZONE,
      "createdAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "updatedAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
})

it('says there is nothing to compare against when the previous period had nothing', async () => {
  await user('ada@example.com', 2, 1)
  await user('grace@example.com', 3, 2)
  const s = await stats()
  expect(s).toMatchObject({ activeUsers: 2, signups24h: 2, activeUsersDelta: null, signupsDelta: null })
})

it('compares with a previous period that had something', async () => {
  await user('linus@example.com', 30, null) // signed up in the 24 hours before the last 24
  await user('barbara@example.com', 50 * 24, 40 * 24) // last signed in 30 to 60 days ago
  const s = await stats()
  expect(s).toMatchObject({ activeUsers: 2, signups24h: 2, activeUsersDelta: 100, signupsDelta: 100 })
})
