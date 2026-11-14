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
 *   2. In one transaction, as the service role: look up and lock
 *      `organization_invitations.token` in the workspace schema.
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
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
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
    // The project's database, in its region.
    const db = await workspaceRawClient(projectId)

    // ── One transaction, as the service role ──────────────────────────────
    // The teams tables are row-level secured (lib/services/workspace-rls.ts,
    // template "teams"): an invitation is readable only by its organization's
    // owner and admins, and an end user writes a membership only into an
    // organization they own. This route is the server side of an invitation,
    // the one door through which an end user joins someone else's
    // organization, so every statement here is the service role's, never the
    // caller's. Without claims, under the application role production runs as
    // (no BYPASSRLS, held to FORCE row-level security), the lookup matched no
    // invitation and every invite answered 404.
    //
    // The invitation is locked (FOR UPDATE) before it is checked, so two
    // accepts of one token cannot both find it unaccepted: the second waits for
    // the first to commit, then reads it accepted.
    const outcome = await db.$transaction(async (tx): Promise<{ status: number; body: Record<string, unknown> }> => {
      await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ isServiceRole: true }))

      // ── Lookup invitation ────────────────────────────────────────────────
      const invites = await tx.$queryRawUnsafe<Array<{
        id: string
        organization_id: string
        email: string
        role: string | null
        expires_at: Date | null
        accepted_at: Date | null
      }>>(
        `SELECT id::text AS id, organization_id::text AS organization_id, email, role, expires_at, accepted_at
           FROM "${postgresSchema}"."organization_invitations"
          WHERE token = $1
          LIMIT 1
          FOR UPDATE`,
        inviteToken,
      )
      const invite = invites[0]
      if (!invite) {
        return { status: 404, body: { error: 'Invite not found or already consumed', code: 'INVITE_NOT_FOUND' } }
      }
      if (invite.accepted_at) {
        return { status: 409, body: { error: 'This invite has already been accepted', code: 'INVITE_ALREADY_ACCEPTED' } }
      }
      if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
        return { status: 410, body: { error: 'This invite has expired. Ask the inviter to send a new one.', code: 'INVITE_EXPIRED' } }
      }

      // ── Email match (anti-token-theft) ───────────────────────────────────
      // The end-user's email, from the workspace users table: the JWT payload
      // may not include it. The invite is only valid for the user it was
      // addressed to. A project without the table has no account to match, said
      // as such rather than as an aborted transaction. A bare $1 arrives as
      // text, which a uuid id refuses (42883), so the id is compared as text.
      const [usersTable] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        `"${postgresSchema}"."users"`,
      )
      const users = usersTable?.present
        ? await tx.$queryRawUnsafe<Array<{ email: string | null }>>(
            `SELECT email FROM "${postgresSchema}"."users" WHERE id::text = $1 LIMIT 1`,
            endUser.userId,
          )
        : []
      const endUserEmail = users[0]?.email ?? null
      if (!endUserEmail) {
        return { status: 409, body: { error: 'Could not resolve your account email', code: 'NO_USER_RECORD' } }
      }
      if (endUserEmail.toLowerCase() !== String(invite.email).toLowerCase()) {
        return {
          status: 403,
          body: {
            error: `This invite was sent to a different email address. Sign in with the address it was sent to (${invite.email}).`,
            code: 'INVITE_EMAIL_MISMATCH',
          },
        }
      }

      // ── Already a member? Treat as idempotent success ────────────────────
      const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM "${postgresSchema}"."organization_members"
          WHERE organization_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
        invite.organization_id, endUser.userId,
      )
      if (existing.length === 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "${postgresSchema}"."organization_members"
             (id, organization_id, user_id, role, joined_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, NOW())`,
          invite.organization_id, endUser.userId, invite.role || 'member',
        )
      }
      // Consumed either way, so it cannot be used again.
      await tx.$executeRawUnsafe(
        `UPDATE "${postgresSchema}"."organization_invitations"
            SET accepted_at = NOW() WHERE id = $1::uuid`,
        invite.id,
      )

      return existing.length > 0
        ? {
            status: 200,
            body: {
              ok: true,
              message: 'You were already a member of this organization.',
              organizationId: invite.organization_id,
              role: invite.role,
            },
          }
        : {
            status: 200,
            body: {
              ok: true,
              message: 'Joined the organization.',
              organizationId: invite.organization_id,
              role: invite.role || 'member',
            },
          }
    })

    return NextResponse.json(outcome.body, { status: outcome.status })
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
