/**
 * Forgot-password and resend-verification answer before doing anything that
 * depends on whether the account exists, so the answer's timing says nothing
 * about which addresses have accounts.
 *
 * On production (2026-11-09) the reset for an existing account stored a token
 * and sent an email before answering, 2.9-3.2 s, while an unknown address was
 * answered in 0.24 s: the words were generic, the time was not.
 *
 * Only the email sender is replaced, with one that holds each send until the
 * test lets it go: a route that waits for the email cannot answer first. The
 * database is real.
 */

const sends: Array<{ kind: 'reset' | 'verify'; email: string }> = []
let gate: Promise<void> = Promise.resolve()
let release: () => void = () => {}

jest.mock('@/lib/services/end-user-auth-email', () => ({
  getAuthEmailContext: async () => ({ magicLinksEnabled: true }),
  sendEndUserPasswordResetEmail: async (_p: string, email: string) => {
    await gate
    sends.push({ kind: 'reset', email })
    return true
  },
  sendEndUserVerificationEmail: async (_p: string, email: string) => {
    await gate
    sends.push({ kind: 'verify', email })
    return true
  },
}))

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { forgotEndUserPassword, requestEmailVerification } from '@/lib/services/end-user-auth-flows'

const KNOWN = 'known@example.test'
const UNKNOWN = 'nobody@example.test'

let ownerId = ''
let projectId = ''
let schema = ''

const hold = () => { gate = new Promise<void>((resolve) => { release = resolve }) }
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'answered' as const), new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])
async function eventually(check: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}
const tokensFor = async (table: string, email: string) =>
  (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE email = $1`, email))[0].n

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `oracle-${randomUUID()}@example.test`, name: 'oracle' }, select: { id: true } })).id
  projectId = (await prisma.project.create({
    data: { name: `oracle-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: 'o'.repeat(48) },
    select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, email_verified boolean NOT NULL DEFAULT false)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".users (email) VALUES ($1)`, KNOWN)
}, 60_000)

afterAll(async () => {
  release()
  await new Promise((r) => setTimeout(r, 200))
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('forgot-password', () => {
  it('answers for an existing account before its email is sent, then sends it', async () => {
    hold()
    const answer = forgotEndUserPassword(projectId, KNOWN)
    expect(await within(answer, 2000)).toBe('answered')
    expect((await answer).body).toEqual({ data: { message: 'If an account with that email exists, a password reset link has been sent.' } })
    expect(sends).toEqual([])
    release()
    expect(await eventually(async () => sends.some((s) => s.kind === 'reset' && s.email === KNOWN))).toBe(true)
    expect(await tokensFor('_password_resets', KNOWN)).toBe(1)
  })

  it('answers an unknown address with the same words, and sends nothing', async () => {
    sends.length = 0
    const answer = await forgotEndUserPassword(projectId, UNKNOWN)
    expect(answer.body).toEqual({ data: { message: 'If an account with that email exists, a password reset link has been sent.' } })
    await new Promise((r) => setTimeout(r, 300))
    expect(sends).toEqual([])
  })
})

describe('resend verification', () => {
  it('answers for an unverified account before its email is sent, then sends it', async () => {
    sends.length = 0
    hold()
    const answer = requestEmailVerification(projectId, KNOWN)
    expect(await within(answer, 2000)).toBe('answered')
    expect(sends).toEqual([])
    release()
    expect(await eventually(async () => sends.some((s) => s.kind === 'verify' && s.email === KNOWN))).toBe(true)
    expect(await tokensFor('_email_verifications', KNOWN)).toBe(1)
  })
})
