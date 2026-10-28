/**
 * The account's profile photo (the `user_avatars` table), shown as its avatar
 * in the console.
 *
 * Only a Google sign-in records one, and only when Google says the account has
 * a photo of its own (lib/auth/oauth/google-photo.ts). Every other account,
 * every email-and-password account included, has no row and shows its
 * initials.
 *
 * Both directions FAIL QUIET: the photo is decoration, so a missing table (a
 * release ahead of its migration) or a failed query leaves the console on
 * initials. It must never fail a sign-in or the profile request.
 */

import { prisma } from '@/lib/db/prisma'

function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null
  return e?.code === 'P2021' || e?.meta?.code === '42P01'
}

export async function readAvatarUrl(userId: string): Promise<string | null> {
  try {
    const row = await prisma.userAvatar.findUnique({ where: { userId }, select: { url: true } })
    return row?.url ?? null
  } catch (err) {
    if (!isMissingTable(err)) console.error('[avatar] read failed:', (err as Error)?.name || 'Error')
    return null
  }
}

/**
 * Records the account's photo, or forgets it when `url` is null. True when the
 * record now says so; false when it could not be written.
 */
export async function recordAvatar(userId: string, url: string | null): Promise<boolean> {
  try {
    if (url) {
      await prisma.userAvatar.upsert({ where: { userId }, create: { userId, url }, update: { url } })
    } else {
      await prisma.userAvatar.deleteMany({ where: { userId } })
    }
    return true
  } catch (err) {
    if (!isMissingTable(err)) console.error('[avatar] write failed:', (err as Error)?.name || 'Error')
    return false
  }
}
