export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * Accept an organization invite.
 * ──────────────────────────────
 *   POST /api/v1/{projectId}/orgs/accept-invite
 *   Body: { token: string }
 *   Auth: X-User-Token (project-scoped end-user JWT signed with project.jwtSecret)
 *
 * Flow:
 *   1. Resolve the end-user JWT through the check every data door uses:
 *      project.jwtSecret, this project, not revoked, user not blocked.
 *   2. Look up `organization_invitations.token` in the workspace schema.
 *   3. Reject expired, already-accepted, or wrong-email invites.
 *   4. Insert into `organization_members` and stamp `accepted_at`.
 *
 * The invitation is matched on token, then verified against the end-user's
 * email so an attacker cannot accept a token issued to someone else (token
 * alone is not enough — they must also own the email it was sent to).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isRegionError, workspaceRawClient } from '@/lib/data-plane/regional'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.projectId

    // ── End-user JWT verification ──────────────────────────────────────────
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, jwtSecret: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    if (!project.jwtSecret) {
      return NextResponse.json(
        { error: 'End-user auth is not enabled on this project', code: 'AUTH_DISABLED' },
        { status: 409 },
      )
    }

    const header = request.headers.get('x-user-token') || request.headers.get('authorization')
    if (!header) {
      return NextResponse.json(
        { error: 'Sign in first, then accept the invite', code: 'AUTH_REQUIRED' },
        { status: 401 },
      )
    }
    const rawToken = header.replace(/^Bearer\s+/i, '')
    // The check every data door uses (server/lib/end-user-identity.ts): signed
    // with this project's secret, naming this project, and not revoked by
    // logout. A blocked user is refused with the runtime's answer.
    const endUser = await resolveEndUserFromToken(projectId, rawToken)
    if (endUser === 'blocked') {
      return NextResponse.json(
        { error: 'This account has been blocked by the project owner.', code: 'END_USER_BLOCKED' },
        { status: 403 },
      )
    }
    if (!endUser) {
      return NextResponse.json(
        { error: 'Invalid or expired session', code: 'INVALID_TOKEN' },
        { status: 401 },
      )
    }

    // ── Body ───────────────────────────────────────────────────────────────
    const body = await request.json().catch(() => ({} as any))
    const inviteToken = typeof body?.token === 'string' ? body.token.trim() : ''
    if (!inviteToken) {
      return NextResponse.json(
        { error: 'token is required (the invite token from the invitation email)', code: 'BAD_REQUEST' },
        { status: 400 },
      )
    }

    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    // The project's database, in its region. Resolved before the users
    // lookup's fail-soft catch, which would read an unreachable region as
    // "no account".
    const db = await workspaceRawClient(projectId)

    // ── Lookup invitation ──────────────────────────────────────────────────
    const invites = await db.$queryRawUnsafe<Array<{
      id: string
      organization_id: string
      email: string
      role: string
      expires_at: Date | null
      accepted_at: Date | null
    }>>(
      `SELECT id, organization_id, email, role, expires_at, accepted_at
         FROM "${postgresSchema}"."organization_invitations"
        WHERE token = $1 LIMIT 1`,
      inviteToken,
    )
    const invite = invites[0]
    if (!invite) {
      return NextResponse.json(
        { error: 'Invite not found or already consumed', code: 'INVITE_NOT_FOUND' },
        { status: 404 },
      )
    }
    if (invite.accepted_at) {
      return NextResponse.json(
        { error: 'This invite has already been accepted', code: 'INVITE_ALREADY_ACCEPTED' },
        { status: 409 },
      )
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return NextResponse.json(
        { error: 'This invite has expired. Ask the inviter to send a new one.', code: 'INVITE_EXPIRED' },
        { status: 410 },
      )
    }

    // ── Email match (anti-token-theft) ─────────────────────────────────────
    // Look up the end-user's email from the workspace users table — the JWT
    // payload may not include it. The invite is only valid for the user it
    // was addressed to. Read as the service role: the users table is row-level
    // secured against the app role, so a read without session claims matched
    // no row (lib/services/end-user-blocked.ts). And a bare $1 arrives as text,
    // which a uuid id refuses (42883), so the id is compared as text.
    let endUserEmail: string | null = null
    try {
      const rows = await executeWithUserContext<{ email: string }>(
        projectId,
        '',
        true,
        `SELECT email FROM "${postgresSchema}"."users" WHERE id::text = $1 LIMIT 1`,
        [endUser.userId],
      )
      endUserEmail = rows[0]?.email ?? null
    } catch {
      /* users table may not exist if auth wasn't enabled — handled below */
    }
    if (!endUserEmail) {
      return NextResponse.json(
        { error: 'Could not resolve your account email', code: 'NO_USER_RECORD' },
        { status: 409 },
      )
    }
    if (endUserEmail.toLowerCase() !== String(invite.email).toLowerCase()) {
      return NextResponse.json(
        {
          error: `This invite was sent to a different email address. Sign in with the address it was sent to (${invite.email}).`,
          code: 'INVITE_EMAIL_MISMATCH',
        },
        { status: 403 },
      )
    }

    // ── Already a member? Treat as idempotent success ──────────────────────
    const existing = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "${postgresSchema}"."organization_members"
        WHERE organization_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
      invite.organization_id, endUser.userId,
    )
    if (existing.length > 0) {
      // Still mark the invite consumed so it can't be reused later.
      await db.$executeRawUnsafe(
        `UPDATE "${postgresSchema}"."organization_invitations"
            SET accepted_at = NOW() WHERE id = $1::uuid`,
        invite.id,
      )
      return NextResponse.json({
        ok: true,
        message: 'You were already a member of this organization.',
        organizationId: invite.organization_id,
        role: invite.role,
      })
    }

    // ── Insert member + consume invite atomically ──────────────────────────
    await db.$transaction([
      db.$executeRawUnsafe(
        `INSERT INTO "${postgresSchema}"."organization_members"
           (id, organization_id, user_id, role, joined_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, NOW())`,
        invite.organization_id, endUser.userId, invite.role || 'member',
      ),
      db.$executeRawUnsafe(
        `UPDATE "${postgresSchema}"."organization_invitations"
            SET accepted_at = NOW() WHERE id = $1::uuid`,
        invite.id,
      ),
    ])

    return NextResponse.json({
      ok: true,
      message: 'Joined the organization.',
      organizationId: invite.organization_id,
      role: invite.role || 'member',
    })
  } catch (err: any) {
    // A region this process cannot reach: say so, without the message's
    // variable names.
    if (isRegionError(err)) {
      return NextResponse.json(
        { error: "This project's data region is not reachable from this server.", code: err.code },
        { status: 503 },
      )
    }
    return NextResponse.json(
      { error: err?.message ?? 'Unexpected error', code: 'INTERNAL' },
      { status: 500 },
    )
  }
}

export const POST = recordedV1(handlePOST)
