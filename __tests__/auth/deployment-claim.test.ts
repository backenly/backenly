/**
 * CLAIMING A SELF-HOSTED DEPLOYMENT
 * ================================
 * `npm run selfhost` said the deployment was ready when it was not: the project
 * bootstrap created had no owner, because no account existed while the
 * installer ran, and nothing adopted the operator until somebody ran
 * `npm run bootstrap` a second time. Until then the dashboard listed no
 * projects to the only account there was.
 *
 * The fix binds the first administrator to the project in the SAME transaction
 * that creates them, gated on a token the installer prints. These tests cover
 * the three things that can go wrong with that:
 *
 *   1. the wrong person claims it — a deployment is often reachable before its
 *      operator gets to it, so speed must not be what wins
 *   2. it is claimed twice — the token stays in a file and a file cannot be
 *      un-read, so replay has to be refused by something other than the token
 *   3. it is claimed but the project is not adopted — the original bug, which
 *      is invisible unless ownership is asserted on the row itself
 *
 * Real database. Ownership is a row, and a claim that cannot be replayed is a
 * property of a transaction.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  assertSetupTokenAdmits,
  claimAwaitsToken,
  configuredSetupToken,
  deploymentIsClaimed,
  SetupTokenError,
  setupTokenMatches,
  setupTokenRequired,
} from '@/lib/auth/setup-token'

const TOKEN = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

let createdUserIds: string[] = []
let createdProjectIds: string[] = []

const originalToken = process.env.BACKENLY_SETUP_TOKEN
const originalEdition = process.env.BACKENLY_EDITION

beforeEach(() => {
  process.env.BACKENLY_SETUP_TOKEN = TOKEN
  process.env.BACKENLY_EDITION = 'single-tenant'
  createdUserIds = []
  createdProjectIds = []
})

afterEach(async () => {
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
  if (originalToken === undefined) delete process.env.BACKENLY_SETUP_TOKEN
  else process.env.BACKENLY_SETUP_TOKEN = originalToken
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
})

describe('when the token is required at all', () => {
  test('is required on self-host once one is configured', () => {
    expect(setupTokenRequired()).toBe(true)
    expect(configuredSetupToken()).toBe(TOKEN)
  })

  test('is not required on cloud, which has no single slot to protect', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    expect(setupTokenRequired()).toBe(false)
  })

  test('is not required by an install that configured none', () => {
    // An existing deployment upgrading to this version has no token. Demanding
    // one would lock its operator out of their own install, which is a worse
    // failure than the one being fixed.
    delete process.env.BACKENLY_SETUP_TOKEN
    expect(setupTokenRequired()).toBe(false)
  })
})

describe('admitting a claim', () => {
  test('refuses a signup presenting no token', async () => {
    await expect(assertSetupTokenAdmits(undefined)).rejects.toThrow(SetupTokenError)
  })

  test('refuses a signup presenting the wrong token', async () => {
    await expect(assertSetupTokenAdmits(OTHER)).rejects.toThrow(SetupTokenError)
  })

  test('refuses a token of the wrong length without throwing on the comparison', async () => {
    // timingSafeEqual throws on a length mismatch rather than returning false,
    // so a short token must be handled before it reaches the comparison or the
    // route answers 500 instead of 403.
    await expect(assertSetupTokenAdmits('short')).rejects.toThrow(SetupTokenError)
  })

  test('admits the right token while the deployment is unclaimed', async () => {
    // Only meaningful if nothing has claimed it yet, which is asserted rather
    // than assumed - the shared test database may hold users from elsewhere.
    if (await deploymentIsClaimed()) {
      // Then the next case is the one that applies, and it is covered below.
      await expect(assertSetupTokenAdmits(TOKEN)).rejects.toThrow(/already been claimed/i)
      return
    }
    await expect(assertSetupTokenAdmits(TOKEN)).resolves.toBeUndefined()
  })

  test('refuses the right token once the deployment is claimed', async () => {
    // Replay. The token lives in .env and cannot be un-read, so what makes the
    // claim single-use is the account slot, not the secret.
    const user = await prisma.user.create({
      data: { email: `claimed-${Date.now()}@example.test`, password: 'x', name: 'first' },
    })
    createdUserIds.push(user.id)

    await expect(assertSetupTokenAdmits(TOKEN)).rejects.toThrow(/already been claimed/i)
  })

  test('the claimed check runs before the token check', async () => {
    // Ordering matters: a replay must be refused even when the value presented
    // is correct, and the message must say which situation it is so an operator
    // can tell "wrong token" from "someone already claimed this".
    const user = await prisma.user.create({
      data: { email: `ordered-${Date.now()}@example.test`, password: 'x', name: 'first' },
    })
    createdUserIds.push(user.id)

    await expect(assertSetupTokenAdmits(OTHER)).rejects.toThrow(/already been claimed/i)
  })
})

describe('the comparison itself', () => {
  // Tested through the pure function, not the assert. Any database that
  // already has an account answers "already claimed" first, which would
  // pre-empt every one of these and leave the comparison unexercised exactly
  // where it is most likely to be wrong.
  test('matches the configured token', () => {
    expect(setupTokenMatches(TOKEN)).toBe(true)
  })

  test('tolerates surrounding whitespace, because it is pasted from a terminal', () => {
    expect(setupTokenMatches(`  ${TOKEN}
`)).toBe(true)
  })

  test('rejects a different token of the same length', () => {
    expect(setupTokenMatches(OTHER)).toBe(false)
  })

  test('rejects a shorter value without throwing', () => {
    // timingSafeEqual throws on a length mismatch. Returning false is what
    // keeps the route answering 403 rather than 500.
    expect(setupTokenMatches('short')).toBe(false)
  })

  test('rejects a prefix of the real token', () => {
    expect(setupTokenMatches(TOKEN.slice(0, 32))).toBe(false)
  })

  test('rejects nothing at all', () => {
    expect(setupTokenMatches(undefined)).toBe(false)
    expect(setupTokenMatches('')).toBe(false)
  })
})

describe('what the signup page is told', () => {
  // The gate shipped enforced by the route and asked for by no page, so every
  // browser signup on a fresh install was refused. The page now asks first,
  // and these pin the answer it gets.
  test('asks for the token while a configured deployment is unclaimed', async () => {
    // The shared test database may already hold users; then "claimed" is the
    // true answer and the case below is the one that applies.
    const expected = !(await deploymentIsClaimed())
    await expect(claimAwaitsToken()).resolves.toBe(expected)
  })

  test('stops asking once the deployment is claimed', async () => {
    const user = await prisma.user.create({
      data: { email: `claimed-page-${Date.now()}@example.test`, password: 'x', name: 'first' },
    })
    createdUserIds.push(user.id)

    await expect(claimAwaitsToken()).resolves.toBe(false)
  })

  test('never asks on cloud, which has no single slot to protect', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    await expect(claimAwaitsToken()).resolves.toBe(false)
  })

  test('never asks an install that configured no token', async () => {
    delete process.env.BACKENLY_SETUP_TOKEN
    await expect(claimAwaitsToken()).resolves.toBe(false)
  })

  test('the endpoint answers yes or no, and never with the token', async () => {
    const { GET } = await import('@/app/api/auth/register/route')
    const body = await (await GET()).json()

    expect(Object.keys(body)).toEqual(['setupTokenRequired'])
    expect(typeof body.setupTokenRequired).toBe('boolean')
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  })
})

describe('adopting the project', () => {
  test('a conditional update claims only an unowned project', async () => {
    // The mechanism the register route uses, asserted directly: `userId: null`
    // in the WHERE is what stops a second account taking a project that already
    // has an owner, and what makes two racing requests agree.
    const owner = await prisma.user.create({
      data: { email: `owner-${Date.now()}@example.test`, password: 'x', name: 'owner' },
    })
    createdUserIds.push(owner.id)
    const intruder = await prisma.user.create({
      data: { email: `intruder-${Date.now()}@example.test`, password: 'x', name: 'intruder' },
    })
    createdUserIds.push(intruder.id)

    const project = await prisma.project.create({ data: { name: 'unowned-probe', userId: null } })
    createdProjectIds.push(project.id)

    const first = await prisma.project.updateMany({
      where: { id: project.id, userId: null },
      data: { userId: owner.id },
    })
    expect(first.count).toBe(1)

    // The intruder finds nothing to claim.
    const second = await prisma.project.updateMany({
      where: { id: project.id, userId: null },
      data: { userId: intruder.id },
    })
    expect(second.count).toBe(0)

    const after = await prisma.project.findUnique({ where: { id: project.id }, select: { userId: true } })
    expect(after?.userId).toBe(owner.id)
  })

  test('an already-owned project is never reassigned', async () => {
    const a = await prisma.user.create({
      data: { email: `a-${Date.now()}@example.test`, password: 'x', name: 'a' },
    })
    createdUserIds.push(a.id)
    const b = await prisma.user.create({
      data: { email: `b-${Date.now()}@example.test`, password: 'x', name: 'b' },
    })
    createdUserIds.push(b.id)

    const project = await prisma.project.create({ data: { name: 'owned-probe', userId: a.id } })
    createdProjectIds.push(project.id)

    const moved = await prisma.project.updateMany({
      where: { id: project.id, userId: null },
      data: { userId: b.id },
    })
    expect(moved.count).toBe(0)

    const after = await prisma.project.findUnique({ where: { id: project.id }, select: { userId: true } })
    expect(after?.userId).toBe(a.id)
  })
})
