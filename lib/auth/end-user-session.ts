/**
 * AN END USER'S SESSION, ISSUED BY THE PLATFORM
 * =============================================
 *
 * Sign-in (app/api/v1/[projectId]/auth/signin) issues an end user a session
 * token: a JWT of their id, email, project and role, signed with the project's
 * secret, valid for seven days. signEndUserToken is that one token, so every
 * path that signs an end user in issues exactly what sign-in does.
 *
 * A function signs a user in through issueEndUserSession, never by signing a
 * token itself: function code does not get the project's signing secret
 * (lib/services/ai-functions/route-module-runner.ts withholds it), as Supabase
 * Edge Functions and Appwrite Functions do not get theirs. A function that
 * checks its own proof of who the user is (a code sent by SMS, an external
 * identity) asks the platform for the session once it is satisfied:
 *
 *   route module:  import { createSession } from '@/lib/auth/session'
 *                  const { token, user } = await createSession(userId)
 *   ctx function:  const { token, user } = await ctx.auth.createSession(userId)
 *
 * which is Appwrite's users.createSession: a server-side call that returns an
 * immediately usable session, signed by the platform. The function decides
 * whom to sign in, as a service key does; the user must exist in the project's
 * users table and not be suspended, and the email-verification gate of
 * password sign-in does not apply (the function proved who the user is its
 * own way).
 */

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { authorizingProject } from '@/lib/auth-projection/read'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { endUserTokenClaims, endUserTokenSecret, mainAuthEnvironment } from '@/lib/branches/auth-environment'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { stampLastLogin } from '@/lib/services/end-user-auth-table'
import { trackEndUserActive } from '@/lib/quota/kernel'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

/** How long an end user's session token lasts, wherever it is issued. */
export const END_USER_TOKEN_LIFETIME = '7d'

export interface EndUserSessionUser {
  /** As the users table holds it, and as sign-in answers it: a uuid string, or a number for an integer key. */
  id: string | number
  email: string | null
  name: string | null
  role: string
}

/** The session token sign-in issues: the same claims, secret and lifetime on every path. */
export function signEndUserToken(
  projectSecret: string,
  projectId: string,
  user: { id: string | number; email: string | null; role?: string | null },
  branch: { id: string } | null,
): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      projectId,
      role: user.role ?? 'user',
      jti: crypto.randomUUID(),
      ...endUserTokenClaims(branch),
    },
    endUserTokenSecret(resolveJwtSecret(projectSecret), branch),
    { expiresIn: END_USER_TOKEN_LIFETIME },
  )
}

/** Why a session could not be issued, in words a function may show its caller. */
export class EndUserSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EndUserSessionError'
  }
}

/**
 * A session for the end user `userId` of `projectId`, issued by the platform
 * (see above). Refuses an id that is not one of the project's users, and a
 * suspended user, as sign-in does.
 */
export async function issueEndUserSession(
  projectId: string,
  userId: unknown,
): Promise<{ user: EndUserSessionUser; token: string }> {
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new EndUserSessionError("createSession needs the user's id")
  }
  const id = String(userId).trim()
  if (!id || id.length > 200) throw new EndUserSessionError("createSession needs the user's id")
  try {
    return await sessionFor(projectId, id)
  } catch (err) {
    if (err instanceof EndUserSessionError) throw err
    // Function code may return what it is told to anyone, so an unexpected
    // failure reaches it as sign-in reports one: the cause, never a host or a statement.
    throw new EndUserSessionError(`Could not create the session: ${sanitizeDiagnostic(err)}`)
  }
}

async function sessionFor(projectId: string, id: string): Promise<{ user: EndUserSessionUser; token: string }> {
  const project = await authorizingProject(projectId)
  if (!project) throw new EndUserSessionError('Project not found')
  if (!project.jwtSecret || project.jwtSecret.length < 32) {
    throw new EndUserSessionError('This project cannot sign users in yet: it has no signing secret')
  }

  const env = mainAuthEnvironment(projectId)
  const schemaName = env.schemaName
  // The users table is in the project's database, in its region (as sign-in reads it).
  const db = await workspaceRawClient(projectId)
  const tableCheck = await db.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'users') AS exists`,
    schemaName,
  )
  if (!tableCheck[0]?.exists) throw new EndUserSessionError('Authentication is not enabled for this project')
  // The same optional columns sign-in reads; a users table without them still works.
  const optColRows = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users' AND column_name IN ('name', 'role', 'is_blocked')`,
    schemaName,
  )
  const optCols = new Set(optColRows.map((r) => r.column_name))
  const selectCols = [
    'id',
    'email',
    ...(optCols.has('name') ? ['"name"'] : []),
    ...(optCols.has('role') ? ['"role"'] : []),
    ...(optCols.has('is_blocked') ? ['"is_blocked"'] : []),
  ].join(', ')
  // As the service role: this is the platform signing a user in, which sees past row-level security as sign-in does.
  const rows = await executeWithUserContext<any>(
    projectId,
    '',
    true,
    `SELECT ${selectCols} FROM "${schemaName}"."users" WHERE id::text = $1 LIMIT 1`,
    [id],
  )
  const user = rows[0]
  if (!user) throw new EndUserSessionError("No user with that id in this project's users table")
  if (user.is_blocked) throw new EndUserSessionError('This account has been suspended.')

  const token = signEndUserToken(project.jwtSecret, projectId, { id: user.id, email: user.email ?? null, role: user.role }, env.branch)

  // As sign-in does: the month's active users, and the Auth page's last sign-in.
  trackEndUserActive(projectId, String(user.id), user.email).catch(() => {})
  stampLastLogin(projectId, user.id, schemaName).catch(() => {})

  return {
    user: { id: user.id, email: user.email ?? null, name: user.name ?? null, role: user.role ?? 'user' },
    token,
  }
}
