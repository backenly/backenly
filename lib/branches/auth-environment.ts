/**
 * Which environment an end-user auth request runs in: production, or the
 * preview branch its API key is bound to.
 *
 * End-user auth is keyless by design, because it is how a customer's own users
 * sign up. So it used to answer every request from production, and a preview
 * app signing up a test user created a real account, fired the production
 * signup functions and webhooks, and counted toward the month's active users.
 * Phase 0 refused branch keys here (lib/branches/key-scope.ts). This makes the
 * core of auth branch-scoped instead: sign-up, sign-in, refresh and logout run
 * against the branch's own `users` table when the request presents a key bound
 * to that branch.
 *
 * The environment comes from the presented KEY, exactly as on the data plane,
 * and never from anything else in the request: a hostname, header or parameter
 * that picked a schema would let a caller choose production or another branch.
 * A request with no key, or with a main key, runs on production as it always
 * did.
 *
 * ── A branch token cannot be used on production, by construction ───────────
 *
 * An end-user token issued on a branch is signed with a secret derived from the
 * project's secret and the branch id, not with the project's secret itself.
 * Every place that verifies an end-user token for production (the data plane,
 * functions, storage, realtime, refresh, logout) checks the signature against
 * the project's secret, so a branch token fails there without any of them
 * having to know branches exist. The reverse holds too: a production token does
 * not verify against a branch secret. The `br` claim is carried as well, so a
 * token says which branch issued it and the mismatch can be explained.
 */

import { createHash, createHmac } from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/prisma'
import { profileForBranchSchema, profileForProject } from '@/lib/postgrest/gateway'
import { presentedApiKey } from './key-scope'

export interface AuthEnvironment {
  /** Schema holding the `users` table and auth's own side tables. */
  schemaName: string
  /** The preview branch, or null for production. */
  branch: { id: string; name: string } | null
}

export function mainAuthEnvironment(projectId: string): AuthEnvironment {
  return { schemaName: profileForProject(projectId), branch: null }
}

export interface AuthEnvironmentRefusal {
  status: 401 | 403
  body: { error: string; code: string; hint?: string }
}

/** Exactly one of the two is set. */
export interface AuthEnvironmentResult {
  env: AuthEnvironment | null
  refusal: AuthEnvironmentRefusal | null
}

interface HeaderSource {
  get(name: string): string | null | undefined
}

/**
 * The environment for this request, or the reason it is refused.
 *
 * Not cached, unlike the Phase 0 check: a branch merged or discarded a second
 * ago must stop creating users at once, and the lookup is one indexed read on a
 * route that already reads the project.
 *
 * A key bound to a branch that is no longer active, that has expired, or that
 * belongs to another project is refused. Falling back to production for any of
 * them would be the one outcome a preview credential must never have.
 */
export async function resolveAuthEnvironment(
  projectId: string,
  headers: HeaderSource,
  url?: URL | null,
): Promise<AuthEnvironmentResult> {
  const main: AuthEnvironmentResult = { env: mainAuthEnvironment(projectId), refusal: null }
  const key = presentedApiKey(headers, url)
  if (!key) return main

  const row = await prisma.apiKey.findFirst({
    where: { keyHash: createHash('sha256').update(key).digest('hex') },
    select: {
      projectId: true,
      expiresAt: true,
      branch: { select: { id: true, name: true, status: true, schemaName: true, projectId: true } },
    },
  })
  // A main key, or a value that is not a key at all: auth never required one,
  // and neither changes where the request runs.
  if (!row?.branch) return main

  const branch = row.branch
  if (row.projectId !== projectId || branch.projectId !== projectId) {
    return refuse(403, 'API_KEY_PROJECT_MISMATCH',
      `This key is bound to the preview branch "${branch.name}" of another project.`)
  }
  if (row.expiresAt && row.expiresAt < new Date()) {
    return refuse(401, 'API_KEY_EXPIRED',
      `This preview key for branch "${branch.name}" has expired.`,
      'Mint another with branch { action: "connect", branchId } or from the Branches page.')
  }
  if (branch.status !== 'active') {
    return refuse(401, 'BRANCH_INACTIVE',
      'This key is bound to a branch that is no longer active. Issue a key for another ' +
      'branch, or a main key, rather than letting it fall back to production data.')
  }
  return {
    env: {
      // Re-validated against the project at the point of use, as the gateway does.
      schemaName: profileForBranchSchema(projectId, branch.schemaName),
      branch: { id: branch.id, name: branch.name },
    },
    refusal: null,
  }
}

function refuse(status: 401 | 403, code: string, error: string, hint?: string): AuthEnvironmentResult {
  return { env: null, refusal: { status, body: { error, code, ...(hint ? { hint } : {}) } } }
}

/**
 * The secret end-user tokens are signed and verified with in this environment.
 *
 * `projectSecret` is the resolved (decrypted) project secret. Production uses it
 * unchanged, so no existing token is affected. A branch derives its own from it,
 * which is what keeps the two environments' tokens apart (see the header).
 */
export function endUserTokenSecret(projectSecret: string, branch: { id: string } | null | undefined): string {
  if (!branch) return projectSecret
  return createHmac('sha256', projectSecret).update(`backenly-branch-session:${branch.id}`).digest('hex')
}

/** Claims added to an end-user token issued in this environment. */
export function endUserTokenClaims(branch: { id: string } | null | undefined): { br?: string } {
  return branch ? { br: branch.id } : {}
}

/**
 * Why a token that did not verify here belongs to the other environment, or
 * null when it is simply not a valid token.
 *
 * Only ever explains a refusal; it never lets a token through. A production
 * token sent with a preview key used to read the branch as that production
 * user, and now fails, and "invalid token" would send someone looking for an
 * expired session instead of the wrong key. A production token is named as one
 * only once it verifies against the project's secret, so the message cannot be
 * produced by a forged claim. A branch claim on production is read unverified,
 * which can only turn the sender's own request into a refusal.
 */
export function crossEnvironmentToken(
  rawToken: string,
  projectSecret: string,
  branch: { id: string; name: string } | null | undefined,
): { code: string; error: string } | null {
  const claims = jwt.decode(rawToken)
  if (!claims || typeof claims !== 'object') return null
  const issuedOn = typeof claims.br === 'string' ? claims.br : null

  if (!branch) {
    return issuedOn
      ? {
          code: 'BRANCH_TOKEN_ON_MAIN',
          error:
            'This end-user token was issued on a preview branch, so it is not valid on production. ' +
            "Send it with that branch's preview key, or sign the user in on production.",
        }
      : null
  }
  if (issuedOn && issuedOn !== branch.id) {
    return {
      code: 'BRANCH_TOKEN_MISMATCH',
      error: `This end-user token was issued on a different preview branch, not "${branch.name}".`,
    }
  }
  if (!issuedOn) {
    try {
      jwt.verify(rawToken, projectSecret, { algorithms: ['HS256'], ignoreExpiration: true })
    } catch {
      return null
    }
    return {
      code: 'PRODUCTION_TOKEN_ON_BRANCH',
      error:
        `This end-user token was issued by production, so it is not valid on the preview branch "${branch.name}". ` +
        'Sign the user up or in through the preview endpoint (with this preview key) to get a branch token.',
    }
  }
  return null
}

/**
 * What a branch sign-up does not do, reported in its response.
 *
 * These belong to production: functions and webhooks run production code and
 * reach production endpoints, the active-user count is the bill, and email
 * verification sends real mail whose link has no key to say which branch it
 * belongs to. A test that expects one of them can read this list instead of
 * concluding the backend is broken.
 */
export const SKIPPED_ON_BRANCH_SIGNUP = [
  'ai_functions.on_signup',
  'webhooks.auth.user.created',
  'usage.monthly_active_users',
  'email_verification',
] as const
