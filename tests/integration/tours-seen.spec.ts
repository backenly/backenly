/**
 * The one-time tour record (lib/tours/seen.ts), against a real database.
 *
 * A tour is shown at most once per user: marking is idempotent, scoped to the
 * user, and cascades with them. And reads fail CLOSED: with the table missing
 * (a release ahead of its migration) the answer is "unavailable", never "not
 * seen", because "not seen" would show the tour on every visit.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { isTourId, markTourSeen, readToursSeen } from '@/lib/tours/seen'

const RUN = crypto.randomBytes(4).toString('hex')
const users: string[] = []

async function makeUser(label: string) {
  const u = await prisma.user.create({
    data: { email: `tour-${label}-${RUN}@probe.local`, name: label, updatedAt: new Date() },
  })
  users.push(u.id)
  return u
}

afterAll(async () => {
  await prisma.userTourSeen.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('tours seen', () => {
  it('starts unseen, is marked once, and stays marked', async () => {
    const u = await makeUser('once')
    expect(await readToursSeen(u.id)).toEqual({ available: true, seen: [] })
    const both = await Promise.all([markTourSeen(u.id, 'console'), markTourSeen(u.id, 'console')])
    expect(both).toEqual([true, true])
    expect(await readToursSeen(u.id)).toEqual({ available: true, seen: ['console'] })
    expect(await prisma.userTourSeen.count({ where: { userId: u.id } })).toBe(1)
  })

  it("is one user's record, not another's", async () => {
    const a = await makeUser('a')
    const b = await makeUser('b')
    await markTourSeen(a.id, 'console')
    expect((await readToursSeen(b.id)).seen).toEqual([])
  })

  it('goes with the user when the account is deleted', async () => {
    const u = await makeUser('deleted')
    await markTourSeen(u.id, 'console')
    await prisma.user.delete({ where: { id: u.id } })
    expect(await prisma.userTourSeen.count({ where: { userId: u.id } })).toBe(0)
  })

  it('only accepts tours the console knows', () => {
    expect(isTourId('console')).toBe(true)
    expect(isTourId('anything-else')).toBe(false)
    expect(isTourId(undefined)).toBe(false)
  })

  it('fails closed without the table, so the tour does not run on every visit', async () => {
    const u = await makeUser('premigration')
    await prisma.$executeRawUnsafe('ALTER TABLE "user_tours_seen" RENAME TO "user_tours_seen_hidden_by_test"')
    try {
      expect(await readToursSeen(u.id)).toEqual({ available: false, seen: [] })
      expect(await markTourSeen(u.id, 'console')).toBe(false)
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "user_tours_seen_hidden_by_test" RENAME TO "user_tours_seen"')
    }
  })
})
