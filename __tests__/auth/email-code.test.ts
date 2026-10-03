/**
 * THE EMAILED CODE, AGAINST A REAL DATABASE
 * =========================================
 * A six-digit code is only safe if it can be guessed online and only a few
 * times. Both halves of that are database properties: the attempt counter is
 * one conditional UPDATE, and single use is one conditional DELETE. So they are
 * asserted against Postgres, under real concurrency where concurrency is the
 * point, and each refusal sits beside the success it would otherwise hide.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  hashEmailCode,
  issueEmailCode,
  normalizeCode,
  reissueEmailCode,
  throttleEmailCodeSend,
  verifyEmailCode,
} from '@/lib/auth/email-code'

const DB_URL = process.env.TEST_DATABASE_URL

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL || !/test/i.test(DB_URL.split('/').pop() ?? '')) throw new Error('Refusing: not a test database')
})

const addresses: string[] = []
function address(): string {
  const a = `code-${randomUUID()}@example.test`
  addresses.push(a)
  return a
}

afterAll(async () => {
  await prisma.authEmailCode.deleteMany({ where: { email: { in: addresses } } })
})

/** A code that is certainly not the issued one. */
function wrong(code: string): string {
  return code === '000000' ? '111111' : '000000'
}

describe('issuing', () => {
  it('issues six digits and stores only a keyed hash of them', async () => {
    const email = address()
    const { code } = await issueEmailCode('signup', email, { note: 'x' })
    expect(code).toMatch(/^\d{6}$/)

    const row = await prisma.authEmailCode.findUnique({ where: { purpose_email: { purpose: 'signup', email } } })
    expect(row).not.toBeNull()
    expect(row!.codeHash).not.toContain(code)
    expect(row!.codeHash).toBe(hashEmailCode('signup', email, code))
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replaces the earlier code, so only the latest one works', async () => {
    const email = address()
    const first = await issueEmailCode('password_reset', email)
    const second = await issueEmailCode('password_reset', email)
    if (first.code === second.code) return // one in a million; nothing to distinguish

    expect((await verifyEmailCode('password_reset', email, first.code)).ok).toBe(false)
    expect((await verifyEmailCode('password_reset', email, second.code)).ok).toBe(true)
  })

  it('re-issues for a pending entry and keeps its payload', async () => {
    const email = address()
    await issueEmailCode('signup', email, { passwordHash: 'kept' })
    const again = await reissueEmailCode('signup', email)
    expect(again).not.toBeNull()

    const result = await verifyEmailCode('signup', email, again!.code)
    expect(result).toEqual({ ok: true, payload: { passwordHash: 'kept' } })
  })

  it('re-issues nothing when nothing is pending', async () => {
    await expect(reissueEmailCode('signup', address())).resolves.toBeNull()
  })
})

describe('verifying', () => {
  it('accepts the right code once, and never again', async () => {
    const email = address()
    const { code } = await issueEmailCode('signup', email, { n: 1 })

    expect(await verifyEmailCode('signup', email, code)).toEqual({ ok: true, payload: { n: 1 } })
    expect(await verifyEmailCode('signup', email, code)).toEqual({ ok: false, reason: 'invalid' })
    expect(await prisma.authEmailCode.count({ where: { email } })).toBe(0)
  })

  it('accepts a code pasted with spaces or a dash', async () => {
    const email = address()
    const { code } = await issueEmailCode('signup', email)
    const pasted = `${code.slice(0, 3)} - ${code.slice(3)}`
    expect(normalizeCode(pasted)).toBe(code)
    expect((await verifyEmailCode('signup', email, pasted)).ok).toBe(true)
  })

  it('kills the code after five wrong guesses, even for the right one after', async () => {
    const email = address()
    const { code } = await issueEmailCode('password_reset', email)

    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const r = await verifyEmailCode('password_reset', email, wrong(code))
      expect(r.ok).toBe(false)
    }
    expect(await verifyEmailCode('password_reset', email, code)).toEqual({ ok: false, reason: 'too_many_attempts' })
  })

  it('cannot be out-guessed by firing attempts in parallel', async () => {
    // The counter is spent before the comparison in one conditional UPDATE. A
    // read-then-write counter lets twenty parallel guesses all see "0 used".
    const email = address()
    const { code } = await issueEmailCode('password_reset', email)

    await Promise.all(Array.from({ length: 20 }, () => verifyEmailCode('password_reset', email, wrong(code))))

    const row = await prisma.authEmailCode.findUnique({ where: { purpose_email: { purpose: 'password_reset', email } } })
    expect(row!.attempts).toBe(EMAIL_CODE_MAX_ATTEMPTS)
    expect((await verifyEmailCode('password_reset', email, code)).ok).toBe(false)
  })

  it('lets exactly one of two racing requests with the right code succeed', async () => {
    const email = address()
    const { code } = await issueEmailCode('signup', email, { once: true })

    const results = await Promise.all([
      verifyEmailCode('signup', email, code),
      verifyEmailCode('signup', email, code),
      verifyEmailCode('signup', email, code),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
  })

  it('refuses an expired code, and accepts the same code before expiry', async () => {
    const email = address()
    const { code } = await issueEmailCode('signup', email)
    await prisma.authEmailCode.update({
      where: { purpose_email: { purpose: 'signup', email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await verifyEmailCode('signup', email, code)).toEqual({ ok: false, reason: 'expired' })

    const fresh = await issueEmailCode('signup', email)
    expect((await verifyEmailCode('signup', email, fresh.code)).ok).toBe(true)
  })

  it('binds a code to its purpose and its address', async () => {
    const email = address()
    const other = address()
    const { code } = await issueEmailCode('password_reset', email)
    await issueEmailCode('signup', email)
    await issueEmailCode('password_reset', other)

    expect((await verifyEmailCode('signup', email, code)).ok).toBe(false)
    expect((await verifyEmailCode('password_reset', other, code)).ok).toBe(false)
    expect((await verifyEmailCode('password_reset', email, code)).ok).toBe(true)
  })

  it('refuses a malformed code without spending an attempt', async () => {
    const email = address()
    await issueEmailCode('signup', email)
    expect(await verifyEmailCode('signup', email, '12ab56')).toEqual({ ok: false, reason: 'invalid' })
    const row = await prisma.authEmailCode.findUnique({ where: { purpose_email: { purpose: 'signup', email } } })
    expect(row!.attempts).toBe(0)
  })
})

describe('throttling sends', () => {
  it('allows one send a minute per address, and does not share budgets between addresses', async () => {
    const a = address()
    const b = address()
    expect((await throttleEmailCodeSend('password_reset', a)).allowed).toBe(true)
    expect((await throttleEmailCodeSend('password_reset', a)).allowed).toBe(false)
    expect((await throttleEmailCodeSend('password_reset', b)).allowed).toBe(true)
    // Separate purposes do not spend each other's budget either.
    expect((await throttleEmailCodeSend('signup', a)).allowed).toBe(true)
  })
})
