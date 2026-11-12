/**
 * `auth.user.created` and `on_signup` AI functions, emitted the same way by
 * every path that creates an end user (#147, #599).
 *
 * The Next route (app/api/v1/[projectId]/auth/signup, where Backenly Cloud's
 * load balancer sends sign-ups), the Express runtime (server/routes/auth.ts,
 * what a single-box install serves), the OAuth callback (server/routes/oauth.ts),
 * and magic-link sign-in (lib/services/end-user-auth-flows.ts) all create
 * end users.
 *
 * Both the external webhook (`auth.user.created`) and internal serverless
 * AI functions (`on_signup`) are dispatched from this single helper so the
 * two cannot drift apart (#599).
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
 * Notify the project's `auth.user.created` subscribers and trigger any
 * `on_signup` AI functions. Never throws and never delays the sign-up;
 * reserved test accounts are skipped here, in the one function every
 * creation path calls, so none can forget (#599).
 */
export async function emitEndUserCreated(projectId: string, user: CreatedEndUser): Promise<void> {
  if (isReservedTestEmail(user.email)) return

  await Promise.allSettled([
    (async () => {
      try {
        const { triggerWebhooks } = await import('@/lib/webhooks')
        await triggerWebhooks(projectId, 'auth.user.created', endUserCreatedPayload(user))
      } catch (err: any) {
        console.warn('[Webhooks] auth.user.created failed (non-fatal):', err?.message)
      }
    })(),
    (async () => {
      try {
        const { fireAiFunctionsOnSignup } = await import('@/lib/services/ai-functions/executor')
        await fireAiFunctionsOnSignup(projectId, { id: user.id, email: user.email, name: user.name })
      } catch (err: any) {
        console.warn('[AiFunctions] on_signup failed (non-fatal):', err?.message)
      }
    })(),
  ])
}
