/**
 * The account's profile photo (lib/auth/avatar.ts), against a real database.
 *
 * Recorded per user, replaced by the next Google sign-in, forgotten when the
 * Google account no longer has a photo of its own, and gone with the account.
 * And both directions fail quiet: with the table missing (a release ahead of
 * its migration) the console shows initials and nothing throws, because a
 * throw here would fail a sign-in or the profile request.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { readAvatarUrl, recordAvatar } from '@/lib/auth/avatar'

const RUN = crypto.randomBytes(4).toString('hex')
const users: string[] = []
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocFirstPhoto=s100'
const NEWER = 'https://lh3.googleusercontent.com/a/ACg8ocNewerPhoto=s100'

async function makeUser(label: string) {
  const u = await prisma.user.create({
    data: { email: `avatar-${label}-${RUN}@probe.local`, name: label, updatedAt: new Date() },
  })
  users.push(u.id)
  return u
}

afterAll(async () => {
  await prisma.userAvatar.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('user avatar', () => {
  it('starts with none, records a photo, and the next sign-in replaces it', async () => {
    const u = await makeUser('record')
    expect(await readAvatarUrl(u.id)).toBeNull()
    expect(await recordAvatar(u.id, PHOTO)).toBe(true)
    expect(await readAvatarUrl(u.id)).toBe(PHOTO)
    expect(await recordAvatar(u.id, NEWER)).toBe(true)
    expect(await readAvatarUrl(u.id)).toBe(NEWER)
    expect(await prisma.userAvatar.count({ where: { userId: u.id } })).toBe(1)
  })

  it('is forgotten when the Google account no longer has a photo of its own', async () => {
    const u = await makeUser('removed')
    await recordAvatar(u.id, PHOTO)
    expect(await recordAvatar(u.id, null)).toBe(true)
    expect(await readAvatarUrl(u.id)).toBeNull()
    // Forgetting a photo that was never recorded is not an error.
    expect(await recordAvatar(u.id, null)).toBe(true)
  })

  it("is one user's photo, not another's", async () => {
    const a = await makeUser('a')
    const b = await makeUser('b')
    await recordAvatar(a.id, PHOTO)
    expect(await readAvatarUrl(b.id)).toBeNull()
  })

  it('goes with the user when the account is deleted', async () => {
    const u = await makeUser('deleted')
    await recordAvatar(u.id, PHOTO)
    await prisma.user.delete({ where: { id: u.id } })
    expect(await prisma.userAvatar.count({ where: { userId: u.id } })).toBe(0)
  })

  it('fails quiet without the table, so sign-in and the profile still work', async () => {
    const u = await makeUser('premigration')
    await prisma.$executeRawUnsafe('ALTER TABLE "user_avatars" RENAME TO "user_avatars_hidden_by_test"')
    try {
      expect(await readAvatarUrl(u.id)).toBeNull()
      expect(await recordAvatar(u.id, PHOTO)).toBe(false)
      expect(await recordAvatar(u.id, null)).toBe(false)
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "user_avatars_hidden_by_test" RENAME TO "user_avatars"')
    }
  })
})
