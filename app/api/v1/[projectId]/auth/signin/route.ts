export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { signInSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/auth/password'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { stampLastLogin } from '@/lib/services/end-user-auth-table'
import { trackEndUserActive } from '@/lib/quota/kernel'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import jwt from 'jsonwebtoken'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'

/**
 * POST /v1/{projectId}/auth/signin
 *
 * Authenticates an END USER of the project — NOT a Backenly platform developer.
 * Reads from workspace_{projectId}.users — isolated from the platform User table.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.projectId

    // Validate project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'Project not found', 404)
    }

    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'Authentication is not configured for this project.',
        503
      )
    }

    // Validate request body
    const validation = await validateRequestBody(signInSchema, request)
    if (!validation.success) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, (validation as { success: false; error: string }).error, 400)
    }

    const { email, password } = validation.data
    const schemaName = `workspace_${projectId}`

    // Check if users table exists
    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'users'
      ) AS exists`,
      schemaName
    )

    if (!tableCheck[0]?.exists) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'Authentication is not enabled for this project.',
        404
      )
    }

    // Detect which column stores the password hash — some schemas use 'password', others 'password_hash'
    const pwColRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'
       AND column_name IN ('password', 'password_hash') LIMIT 1`,
      schemaName
    )
    const pwCol = pwColRows[0]?.column_name ?? 'password'

    // Detect optional columns
    const optColRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'
       AND column_name IN ('role', 'is_blocked')`,
      schemaName
    )
    const optCols = new Set(optColRows.map(r => r.column_name))
    const selectCols = ['id', 'email', `"${pwCol}"`, 'name', ...(optCols.has('role') ? ['"role"'] : []), ...(optCols.has('is_blocked') ? ['"is_blocked"'] : [])].join(', ')

    // Sign-in must read the users row to verify the password hash. At this
    // moment the caller has no session-context user id yet, so RLS would
    // hide the row. Run as service-role — sign-in is a platform-internal
    // privileged operation, exactly what the service-role escape hatch is for.
    const users = await executeWithUserContext<any>(
      '',
      true,
      `SELECT ${selectCols} FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )

    const user = users[0]

    if (!user) {
      return createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
    }

    const storedHash: string | undefined = user[pwCol] ?? user.password ?? user.password_hash
    if (!storedHash) {
      return createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
    }

    // Reject blocked users
    if (user.is_blocked) {
      return createErrorResponse(ErrorCodes.FORBIDDEN, 'This account has been suspended.', 403)
    }

    // Verify password
    const isValid = await verifyPassword(password, storedHash)
    if (!isValid) {
      return createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret),
      { expiresIn: '7d' },
    )

    // Count this end-user as active for the month (MAU tracking — never blocks).
    trackEndUserActive(projectId, String(user.id)).catch(() => {})
    // Stamp last_login so the Auth dashboard's "active · 30d" metric is real.
    stampLastLogin(projectId, user.id).catch(() => {})

    return createSuccessResponse({
      user: { id: user.id, email: user.email, name: user.name, role: user.role ?? 'user' },
      token,
    })
  } catch (error: any) {
    console.error('Signin error:', error)
    const safe = sanitizeDiagnostic(error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      safe ? `Could not sign in — ${safe}` : 'Could not sign in.',
      500,
    )
  }
}
