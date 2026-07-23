/**
 * PROJECT FUNCTION AUTH
 * =====================
 * Per-project auth material for route-module AI functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The generated route-module templates authenticate two ways:
 *   1. Admin endpoints  — compare `x-admin-key` against process.env.ADMIN_API_KEY
 *   2. User endpoints   — verifyToken(x-user-token) via '@/lib/auth/jwt'
 *
 * Both were wired to PLATFORM-wide secrets (AI_EXECUTION_TOKEN, platform
 * JWT_SECRET), which meant:
 *   - admin endpoints were uncallable by every developer forever (403), because
 *     the gate was Backenly's own infra secret, and
 *   - user endpoints rejected every REAL end-user token, because end-user JWTs
 *     are signed with project.jwtSecret, not the platform JWT_SECRET.
 *
 * This module derives PER-PROJECT auth material from the project's jwtSecret,
 * so the route-module runner can present project-correct secrets inside the vm
 * (fixing every stored function without regeneration) and dashboard test runs
 * can authenticate as the project owner legitimately.
 *
 * The admin key is deterministic — HMAC(project jwtSecret) — so it needs no
 * schema change and rotates automatically if the project's jwtSecret rotates.
 */

import * as crypto from 'crypto'
import * as jsonwebtoken from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { resolveJwtSecret, JWTSecretManager } from '@/lib/services/jwtSecretManager'

const jwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken

export interface ProjectFnAuth {
  /** Resolved (plaintext) project JWT signing secret, or null if unavailable. */
  jwtSecret: string | null
  /** Per-project admin API key for x-admin-key gated endpoints, or null. */
  adminKey: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Synthetic end-user id used for dashboard test runs. A valid UUID so
 * `WHERE user_id = $1::uuid` comparisons return empty rows instead of a type
 * error — test runs read as "no matching records", never as a crash.
 */
export const TEST_RUN_USER_ID = '00000000-0000-4000-8000-000000000001'

/** Derive the per-project admin key from the resolved project jwtSecret. */
export function deriveProjectAdminKey(resolvedJwtSecret: string): string {
  const digest = crypto
    .createHmac('sha256', resolvedJwtSecret)
    .update('backenly:project-admin-key:v1')
    .digest('hex')
  return `bk_admin_${digest}`
}

/**
 * Load auth material for a project. Fail-soft: any miss (non-UUID id, project
 * not found, no jwtSecret yet, DB unavailable) returns nulls and the runner
 * falls back to fail-closed behaviour (empty secrets → auth gates reject).
 */
export async function loadProjectFnAuth(projectId: string): Promise<ProjectFnAuth> {
  if (!projectId || !UUID_RE.test(projectId)) return { jwtSecret: null, adminKey: null }
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    if (!project?.jwtSecret) return { jwtSecret: null, adminKey: null }
    const secret = resolveJwtSecret(project.jwtSecret)
    return { jwtSecret: secret, adminKey: deriveProjectAdminKey(secret) }
  } catch {
    return { jwtSecret: null, adminKey: null }
  }
}

/**
 * Guaranteed admin key for a project — creates the project jwtSecret if it
 * does not exist yet. Used by the dashboard "copy admin key" route.
 */
export async function getProjectAdminKey(projectId: string): Promise<string> {
  const secret = await JWTSecretManager.getOrCreateSecret(projectId)
  return deriveProjectAdminKey(secret)
}

/**
 * Mint a short-lived project-scoped end-user token with role=admin for a
 * dashboard test run. Signed with the project's own jwtSecret, so it passes
 * the exact same verification path a real end-user token does. Never returned
 * to the browser — it exists only inside the runner invocation.
 */
export function mintTestRunToken(projectId: string, resolvedJwtSecret: string): string {
  return jwt.sign(
    {
      userId: TEST_RUN_USER_ID,
      email: 'test-run@backenly.internal',
      role: 'admin',
      projectId,
      testRun: true,
    },
    resolvedJwtSecret,
    { algorithm: 'HS256', expiresIn: '10m' }
  )
}
