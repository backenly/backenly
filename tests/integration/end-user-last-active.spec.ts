/**
 * AN END USER'S "LAST ACTIVE" FOLLOWS THEIR USE, NOT ONLY THEIR SIGN-INS
 * ======================================================================
 *
 * Production QA (2026-11-09), Auth & Users: "Active in 30 days: 1" while ten
 * users were using the app, and "Last active: Never" for users working through
 * their tokens. Both read users.last_login, which only a sign-in or a refresh
 * stamped: not a sign-up (which starts a session), not the Express runtime's
 * own sign-in, and not a request made with a still-valid seven-day token.
 *
 * trackEndUserActive, which every kind of use already calls, now stamps it too
 * (lib/services/end-user-auth-table.ts stampLastActive). Real database, both
 * servers' sign-up, and the activity note the data plane makes.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { POST as nextSignup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { noteEndUserActivity, trackEndUserActive } from '@/lib/quota/kernel'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

const PASSWORD = 'Correct-Horse-Battery-9!'
const tag = crypto.randomBytes(3).toString('hex')
let server: http.Server
let base: string
let ownerId: string
const projects: Record<'next' | 'express', string> = { next: '', express: '' }

const signup: Record<'next' | 'express', (projectId: string, email: string) => Promise<number>> = {
  // The Next handler, called directly (jest.setup.js stubs the global Request).
  next: async (projectId, email) => {
    const headers = new Map([['content-type', 'application/json'], ['x-forwarded-for', '198.18.7.1']])
    const res = await nextSignup(
      { headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null }, json: async () => ({ email, password: PASSWORD, name: 'x' }) } as unknown as NextRequest,
      { params: Promise.resolve({ projectId }) },
    )
    return res.status
  },
  express: async (projectId, email) => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.18.7.2' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'x' }),
    })
    await res.text()
    return res.status
  },
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `last-active-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Last Active Suite' },
    select: { id: true },
  })).id
  for (const name of ['next', 'express'] as const) {
    const id = (await prisma.project.create({
      data: { name: `last-active-${name}`, userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })).id
    projects[name] = id
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${id}"`)
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "workspace_${id}"."users" (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
         name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
         last_login timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
    )
  }
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  for (const id of Object.values(projects)) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}, 120_000)

const lastLogin = async (projectId: string, email: string): Promise<Date | null> =>
  (await prisma.$queryRawUnsafe<Array<{ last_login: Date | null }>>(
    `SELECT last_login FROM "workspace_${projectId}"."users" WHERE email = $1`, email,
  ))[0]?.last_login ?? null

/** The stamp is fire-and-forget at every call site: wait for it, briefly. */
async function eventually<T>(read: () => Promise<T | null>, ms = 3000): Promise<T | null> {
  const until = Date.now() + ms
  for (;;) {
    const v = await read()
    if (v !== null || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

const addUser = async (projectId: string, email: string) =>
  String((await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "workspace_${projectId}"."users" (email, password, name) VALUES ($1, 'x', 'y') RETURNING id`, email,
  ))[0].id)

it.each(['next', 'express'] as const)('counts a sign-up on the %s server as activity', async (runtime) => {
  const email = `shopper-${runtime}-${tag}@gmail.com`
  expect(await signup[runtime](projects[runtime], email)).toBe(201)
  expect(await eventually(() => lastLogin(projects[runtime], email))).toBeInstanceOf(Date)
})

it('counts a request made with their token, for a user who only ever signed up', async () => {
  const email = `token-user-${tag}@gmail.com`
  const id = await addUser(projects.next, email)
  expect(await lastLogin(projects.next, email)).toBeNull()
  noteEndUserActivity(projects.next, id, email)
  expect(await eventually(() => lastLogin(projects.next, email))).toBeInstanceOf(Date)
})

it('CONTROL: leaves a verifier account unstamped, as it is never counted as a user', async () => {
  const email = `probe-${tag}@contract.backenly.internal`
  const id = await addUser(projects.next, email)
  await trackEndUserActive(projects.next, id, email)
  expect(await lastLogin(projects.next, email)).toBeNull()
})
