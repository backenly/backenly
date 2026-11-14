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
 *   2. In one transaction, as the service role: look up and lock the
 *      invitation by its token's SHA-256, which is all the table keeps. Only a
 *      stored hash is ever matched: an invitation whose token was kept as
 *      written (one from before the teams rules) is never accepted, since
 *      whoever could read the table could read its token.
 *   3. Reject expired, already-accepted, or wrong-email invites, and one whose
 *      inviter is no longer the organization's owner or an admin, or could not
 *      grant its role (only the owner invites with a role other than member or
 *      admin).
 *   4. Insert into `organization_members` and stamp `accepted_at`.
 *
 * The invitation is matched on token, then verified against the end-user's
 * email so an attacker cannot accept a token issued to someone else (token
 * alone is not enough — they must also own the email it was sent to). The
 * emails are compared as written, or ASCII-lowercased when no other account
 * shares that form: never with Unicode case folding, which takes the Kelvin
 * sign for a k, and never to let a case variant of an address take the
 * invitation of the account the address belongs to. A refusal does not say
 * which address the invitation is for.
 */

import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isRegionError, workspaceRawClient } from '@/lib/data-plane/regional'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/** How the teams rules keep a token (lib/services/workspace-rls.ts, teamsPolicySql). */
function tokenHash(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

/** Printable ASCII and no spaces: an address with anything else may be a look-alike, and is refused. */
const PLAIN_ADDRESS = /^[\x21-\x7e]+$/

/** Lowercase A-Z only: no Unicode case folding. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

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
    if (!inviteToken || inviteToken.length > 512) {
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
      // By the token's hash, and nothing else: the stored token must be that
      // hash. A token kept as written (a table from before the teams rules)
      // is matched by no path, because the owner, the admins and, under the
      // earlier rules, anyone could read it; and a stored hash given as the
      // token hashes to something else. Their organizations' owners invite again.
      const invites = await tx.$queryRawUnsafe<Array<{
        id: string
        organization_id: string
        email: string
        role: string | null
        invited_by_user_id: string | null
        expires_at: Date | null
        accepted_at: Date | null
      }>>(
        `SELECT id::text AS id, organization_id::text AS organization_id, email, role,
                invited_by_user_id::text AS invited_by_user_id, expires_at, accepted_at
           FROM "${postgresSchema}"."organization_invitations"
          WHERE token = $1
          LIMIT 2
          FOR UPDATE`,
        tokenHash(inviteToken),
      )
      // Two rows for one token (a client that reused one in two organizations)
      // name no one invitation.
      const invite = invites.length === 1 ? invites[0] : undefined
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
      // The same address as written, or the same once A-Z are lowercased when
      // no other account has that form: users.email is unique as written, so
      // `INES@…` can be another account than `ines@…`, and the one holding the
      // address as invited is the invitee. Anything outside printable ASCII is
      // refused rather than folded. The refusal names no address.
      const invited = String(invite.email)
      let sameAddress = false
      if (PLAIN_ADDRESS.test(endUserEmail) && PLAIN_ADDRESS.test(invited)) {
        if (endUserEmail === invited) {
          sameAddress = true
        } else if (asciiLower(endUserEmail) === asciiLower(invited)) {
          const [others] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM "${postgresSchema}"."users"
              WHERE translate(email::text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = $1
                AND id::text <> $2`,
            asciiLower(invited),
            endUser.userId,
          )
          sameAddress = Number(others?.n ?? 1) === 0
        }
      }
      if (!sameAddress) {
        return {
          status: 403,
          body: {
            error: 'This invite was sent to a different email address. Sign in with the address it was sent to.',
            code: 'INVITE_EMAIL_MISMATCH',
          },
        }
      }

      // ── Its inviter, now ─────────────────────────────────────────────────
      // An invitation stands only while whoever wrote it may still invite:
      // the organization's owner, or a member whose role is owner or admin.
      // And it grants only what they may grant: an admin invites members and
      // admins, any other role (owner above all) is the owner's to give. Asked
      // here, at acceptance, so an admin removed since, or an invitation
      // written under earlier rules or by a server on someone's say-so, admits
      // no one beyond what its inviter could grant today.
      const role = invite.role || 'member'
      const [standing] = await tx.$queryRawUnsafe<Array<{ owner: boolean; admin: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM "${postgresSchema}"."organizations" o
                         WHERE o.id::text = $1 AND o.owner_user_id::text = $2) AS owner,
                EXISTS (SELECT 1 FROM "${postgresSchema}"."organization_members" m
                         WHERE m.organization_id::text = $1 AND m.user_id::text = $2
                           AND m.role::text IN ('owner', 'admin')) AS admin`,
        invite.organization_id,
        invite.invited_by_user_id ?? '',
      )
      if (!invite.invited_by_user_id || !(standing?.owner || standing?.admin)) {
        return {
          status: 403,
          body: {
            error: 'Whoever sent this invite can no longer invite people to the organization. Ask its owner for a new one.',
            code: 'INVITE_INVITER_NOT_ALLOWED',
          },
        }
      }
      if (!standing.owner && role !== 'member' && role !== 'admin') {
        return {
          status: 403,
          body: {
            error: `Only the organization's owner can invite you as "${role}", and this invite is not from them. Ask the owner to send it.`,
            code: 'INVITE_ROLE_NOT_ALLOWED',
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
          invite.organization_id, endUser.userId, role,
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
              role,
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
