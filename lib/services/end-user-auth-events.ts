/**
 * `auth.user.created`, emitted the same way by both servers that take end-user
 * sign-ups.
 *
 * The Next route (app/api/v1/[projectId]/auth/signup, where Backenly Cloud's
 * load balancer sends sign-ups) and the Express runtime (server/routes/auth.ts,
 * what a single-box install serves) each had their own copy of what follows a
 * sign-up. Only the Next route emitted this event, so a self-hosted project's
 * webhook for it never fired. And it emitted it for the contract sweep's
 * synthetic `…@*.internal` sign-ups too, so any customer who subscribed would
 * have received a fake sign-up every minute.
 *
 * The payload is built field by field from a fixed list, never by spreading the
 * inserted row: the users table holds the password hash, and any credential
 * column a future migration adds would otherwise ride along to whatever URL the
 * operator configured. The table deliberately has no row trigger for the same
 * reason.
 */
import { isReservedTestEmail } from '@/lib/services/end-user-auth-table'

export interface CreatedEndUser {
  id: unknown
  email: string
  name?: string | null
  role?: string | null
  created_at?: unknown
  createdAt?: unknown
}

/** The event payload: exactly these fields, whatever else the row carries. */
export function endUserCreatedPayload(user: CreatedEndUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: user.role ?? 'user',
    createdAt: user.created_at ?? user.createdAt ?? new Date().toISOString(),
  }
}

/**
 * Notify the project's `auth.user.created` subscribers. Never throws and never
 * delays the sign-up; reserved test accounts are skipped here, in the one
 * function both servers call, so neither can forget.
 */
export async function emitEndUserCreated(projectId: string, user: CreatedEndUser): Promise<void> {
  if (isReservedTestEmail(user.email)) return
  try {
    const { triggerWebhooks } = await import('@/lib/webhooks')
    await triggerWebhooks(projectId, 'auth.user.created', endUserCreatedPayload(user))
  } catch (err: any) {
    console.warn('[Webhooks] auth.user.created failed (non-fatal):', err?.message)
  }
}
