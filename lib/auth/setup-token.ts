/**
 * THE ONE-TIME CLAIM THAT BINDS THE FIRST ADMINISTRATOR TO THIS DEPLOYMENT
 * =======================================================================
 *
 * The problem
 * -----------
 * `npm run selfhost` finishes and says the deployment is ready. It is not: the
 * project bootstrap created has no owner, because no account existed when the
 * installer ran. The first person to sign up could not use the dashboard —
 * `GET /api/projects` returned nothing to the only account there was — until
 * somebody ran `npm run bootstrap` a second time to adopt them.
 *
 * A one-command install that needs a second, undocumented-at-that-moment
 * command before it works has not delivered what it promised.
 *
 * Why not "first signup wins"
 * ---------------------------
 * Because a deployment is often reachable before its operator gets to it. A
 * VPS with port 3000 open, a preview environment, a colleague's browser
 * pointed at the wrong host: any of them could take the single administrator
 * slot of somebody else's install, and the real operator would have no way
 * back short of deleting rows by hand.
 *
 * So possession of the machine is what grants the claim, not speed. The
 * installer prints a token that only somebody who can read the install output
 * or the `.env` on that box has.
 *
 * What makes it single-use
 * ------------------------
 * Not the token — it stays in `.env`, and a file cannot be un-read. The slot
 * is single-use: `createUserClaimingSignupSlot` counts accounts inside the
 * transaction that inserts, behind an advisory lock, so exactly one first
 * account can ever exist. Once it does, `deploymentIsClaimed()` is true and
 * this module refuses the token regardless of what it is.
 *
 * That ordering matters. A token checked against a value in a file, with no
 * "has this already happened" test, would be replayable forever by anyone who
 * later read the file.
 */

import { timingSafeEqual } from 'crypto'
import { currentEdition } from '@/lib/edition'
import { prisma } from '@/lib/db'

/** Long enough that guessing is not a strategy; hex so it survives any shell. */
export const SETUP_TOKEN_BYTES = 32

export class SetupTokenError extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'SetupTokenError'
  }
}

/** The configured token, or null when the operator never set one. */
export function configuredSetupToken(): string | null {
  const raw = process.env.BACKENLY_SETUP_TOKEN?.trim()
  return raw ? raw : null
}

/**
 * Whether this deployment gates its first signup behind a setup token.
 *
 * Only self-hosted, and only when a token was configured. An install that
 * predates this feature has no token and keeps working exactly as before,
 * rather than locking its operator out on upgrade — which would be a far worse
 * failure than the one being fixed.
 */
export function setupTokenRequired(): boolean {
  return currentEdition() === 'single-tenant' && configuredSetupToken() !== null
}

/** Whether somebody has already claimed this deployment. */
export async function deploymentIsClaimed(): Promise<boolean> {
  return (await prisma.user.count()) > 0
}

/**
 * Whether a signup made right now must present the token.
 *
 * The signup page asks this before it renders, so its token field appears
 * exactly when the register route would refuse a signup without one. The gate
 * shipped without that question: the route demanded a token that no page could
 * send, so every browser signup on a fresh install was refused and only a
 * hand-written request could claim the deployment the README said to claim
 * "at signup".
 *
 * Answers yes or no and nothing else. The token itself never leaves `.env`, and
 * that a claim is pending is already what the register route tells anyone who
 * tries without one.
 */
export async function claimAwaitsToken(): Promise<boolean> {
  if (!setupTokenRequired()) return false
  return !(await deploymentIsClaimed())
}

/**
 * Compare without leaking where two values start to differ.
 *
 * Lengths are compared first and separately, because timingSafeEqual throws on
 * a length mismatch rather than returning false.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Admit or refuse a first-account signup.
 *
 * Throws with a message that tells an operator standing at the machine what to
 * do, and tells anybody else nothing they can use.
 */
export async function assertSetupTokenAdmits(presented: string | undefined): Promise<void> {
  if (!setupTokenRequired()) return

  // Checked BEFORE the token, so a replay is refused even when the value is
  // right. The slot is what is single-use; the token only decides who may take
  // it while it is open.
  if (await deploymentIsClaimed()) {
    throw new SetupTokenError(
      'This deployment has already been claimed. Registration is closed.'
    )
  }

  if (!setupTokenMatches(presented)) {
    throw new SetupTokenError(
      'A setup token is required to claim this self-hosted deployment. ' +
      'It was printed by `npm run selfhost` and is stored as BACKENLY_SETUP_TOKEN in .env on the server.'
    )
  }
}

/**
 * Whether a presented value matches the configured token.
 *
 * Separate from `assertSetupTokenAdmits`, and pure, because the two questions
 * fail for different reasons and only one of them depends on global state.
 * Asking "does this token match" through the assert meant the answer could be
 * pre-empted by "this deployment is already claimed" — true of any database
 * that already has an account — so the comparison itself was untestable
 * wherever it mattered.
 */
export function setupTokenMatches(presented: string | undefined): boolean {
  const expected = configuredSetupToken()
  // No token configured means no token gate. The caller decides whether that
  // is allowed; this only answers whether the value matches.
  if (!expected) return true
  if (!presented) return false
  return constantTimeEquals(presented.trim(), expected)
}
