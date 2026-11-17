/**
 * DELETING NEEDS A RECENT SIGN-IN
 * ===============================
 * Deleting a project or an account cannot be undone, so an open session is not
 * enough on its own: the person must have signed in within the last ten
 * minutes. A session that has been open longer (a shared or unattended
 * computer, a browser someone else is using, a token that leaked) is asked to
 * sign in again first. GitHub asks for the same before its high-impact actions,
 * deleting an account among them ("sudo mode", which lasts two hours there);
 * here it is ten minutes, and only for the two deletions.
 *
 * "Signed in" is when the session was created. Refreshing a session keeps its
 * creation time (lib/auth/session.ts refreshAccessToken), so only a real
 * sign-in counts.
 *
 * A password account signs in again in place: the console sends the password
 * to the sign-in route (/api/auth/login), so that route's per-address limit,
 * account lockout and second factor apply exactly as they do at sign-in, and no
 * second route checks a password. A Google or GitHub account goes through its
 * provider again and comes back to the page it left.
 */
import { NextResponse } from 'next/server'

/** How recent a sign-in a deletion needs. */
export const RECENT_SIGN_IN_MINUTES = 10
const RECENT_SIGN_IN_MS = RECENT_SIGN_IN_MINUTES * 60 * 1000

/** The code a refusal carries, so the console can ask the person to sign in again. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED'

/** Whether a session created at `signedInAt` is recent enough to delete with. */
export function signedInRecently(signedInAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!signedInAt) return false
  const at = new Date(signedInAt).getTime()
  if (!Number.isFinite(at)) return false
  return now.getTime() - at <= RECENT_SIGN_IN_MS
}

/** How this account can sign in again: in place with its password, or through its provider. */
export interface Reauthentication {
  email: string | null
  /** The account has a password: the console can ask for it in place. */
  password: boolean
  /** The account signs in with Google or GitHub. */
  provider: 'google' | 'github' | null
}

export function reauthenticationFor(account: { email?: string | null; password?: string | null; provider?: string | null } | null | undefined): Reauthentication {
  const provider = account?.provider === 'google' || account?.provider === 'github' ? account.provider : null
  return { email: account?.email ?? null, password: !!account?.password, provider }
}

/**
 * The 403 for a deletion asked for on a session older than ten minutes.
 * `what` completes "Deleting …": "this project", "your account".
 */
export function reauthRefusal(what: string, account: Parameters<typeof reauthenticationFor>[0]): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: `Deleting ${what} needs a sign-in from the last ${RECENT_SIGN_IN_MINUTES} minutes. Sign in again, then delete it.`,
      code: REAUTH_REQUIRED,
      reauth: reauthenticationFor(account),
    },
    { status: 403 },
  )
}

/** The code a deletion without its typed confirmation is refused with. */
export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED'

/**
 * The request body's `confirm`, or null. A deletion is a DELETE with a JSON
 * body; a body that is missing or not JSON simply has no confirmation.
 */
export async function confirmationOf(request: { json: () => Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await request.json()) as { confirm?: unknown } | null
    return typeof body?.confirm === 'string' ? body.confirm : null
  } catch {
    return null
  }
}
