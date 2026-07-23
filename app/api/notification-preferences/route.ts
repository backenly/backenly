export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { authenticateRequest } from '@/lib/auth/middleware'
import { ALL_NOTIFICATION_TYPES, PlatformNotificationType } from '@/lib/notifications/platform'

/**
 * GET /api/notification-preferences
 * Return the current notification preferences for the authenticated user.
 * For types with no stored row, returns the defaults (both channels enabled).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  const stored = await prisma.notificationPreference.findMany({
    where: { userId: auth.userId },
    select: { type: true, emailEnabled: true, inAppEnabled: true, updatedAt: true },
  })

  const storedByType = Object.fromEntries(stored.map(p => [p.type, p]))

  // Return a full list for all known types, filling defaults for any missing row
  const preferences = ALL_NOTIFICATION_TYPES.map(type => ({
    type,
    emailEnabled: storedByType[type]?.emailEnabled ?? true,
    inAppEnabled: storedByType[type]?.inAppEnabled ?? true,
    updatedAt: storedByType[type]?.updatedAt ?? null,
  }))

  return NextResponse.json({ preferences })
}

/**
 * PATCH /api/notification-preferences
 * Update one or more notification type preferences.
 * Body: { preferences: Array<{ type: string, emailEnabled?: boolean, inAppEnabled?: boolean }> }
 *
 * Uses upsert so you can update a single channel without touching the other.
 */
export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.preferences) || body.preferences.length === 0) {
    return NextResponse.json({ error: 'preferences array is required' }, { status: 400 })
  }

  const validTypes = new Set<string>(ALL_NOTIFICATION_TYPES)
  const updates: Array<{ type: PlatformNotificationType; emailEnabled?: boolean; inAppEnabled?: boolean }> = []

  for (const item of body.preferences) {
    if (typeof item.type !== 'string' || !validTypes.has(item.type)) {
      return NextResponse.json(
        { error: `Invalid notification type: "${item.type}". Valid types: ${ALL_NOTIFICATION_TYPES.join(', ')}` },
        { status: 400 }
      )
    }
    if (item.emailEnabled === undefined && item.inAppEnabled === undefined) {
      continue  // nothing to update for this entry
    }
    updates.push({
      type: item.type as PlatformNotificationType,
      ...(item.emailEnabled !== undefined ? { emailEnabled: Boolean(item.emailEnabled) } : {}),
      ...(item.inAppEnabled !== undefined ? { inAppEnabled: Boolean(item.inAppEnabled) } : {}),
    })
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Upsert each preference. For partial updates (only email or only inApp),
  // we need to read the existing row first to preserve the untouched channel.
  const existing = await prisma.notificationPreference.findMany({
    where: { userId: auth.userId, type: { in: updates.map(u => u.type) } },
    select: { type: true, emailEnabled: true, inAppEnabled: true },
  })
  const existingMap = Object.fromEntries(existing.map(e => [e.type, e]))

  const upserts = updates.map(u => {
    const current = existingMap[u.type]
    const emailEnabled = u.emailEnabled ?? current?.emailEnabled ?? true
    const inAppEnabled = u.inAppEnabled ?? current?.inAppEnabled ?? true

    return prisma.notificationPreference.upsert({
      where: { userId_type: { userId: auth.userId!, type: u.type } },
      create: { userId: auth.userId!, type: u.type, emailEnabled, inAppEnabled },
      update: { emailEnabled, inAppEnabled },
      select: { type: true, emailEnabled: true, inAppEnabled: true, updatedAt: true },
    })
  })

  const results = await Promise.all(upserts)

  return NextResponse.json({ preferences: results })
}
