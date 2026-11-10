/**
 * A platform user's profile as the console reads it.
 *
 * One builder for GET /api/auth/me and GET /api/auth/session, so the session
 * hook (lib/hooks/useUserSession.ts) holds the same user whichever it asked.
 */

import { prisma } from '@/lib/db/postgres'
import { readAvatarUrl } from '@/lib/auth/avatar'

export async function platformProfile(userId: string) {
  const userDetails = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      provider: true,
      emailVerified: true,
      // Drives the verification wall in the app shell. Only accounts flagged
      // untrusted at signup are walled, so the 21 pre-existing unverified
      // accounts (all trusted) are untouched.
      trustLevel: true,
      twoFactorEnabled: true,
      // Read only to say whether one is set; the hash never leaves this module.
      password: true,
      createdAt: true,
      lastLogin: true,
      tier: true,
      projects: {
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
    },
  })
  if (!userDetails) return null

  const profile = {
    id: userDetails.id,
    email: userDetails.email,
    name: userDetails.name,
    provider: userDetails.provider,
    emailVerified: userDetails.emailVerified,
    trustLevel: userDetails.trustLevel,
    twoFactorEnabled: userDetails.twoFactorEnabled,
    // An account can have no password: Google and GitHub signups, and an
    // account Backenly Cloud's founders created for an enterprise customer,
    // which signs in with an emailed code until it chooses one.
    hasPassword: !!userDetails.password,
    createdAt: userDetails.createdAt,
    lastLogin: userDetails.lastLogin,
    tier: userDetails.tier,
    projectsCount: userDetails.projects.length,
    // The Google account's own photo, or null: the console shows initials.
    // Read apart from the user so a missing table cannot fail this request.
    avatarUrl: await readAvatarUrl(userDetails.id),
  }
  return { profile, projects: userDetails.projects }
}
