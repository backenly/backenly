/**
 * ORGANIZATIONS (Phase 6 — team accounts)
 * =======================================
 * A platform account that owns projects and billing. Every user gets ONE
 * personal Organization, created lazily and idempotently. Teams form by
 * inviting users as members with a role. This layer is deliberately ADDITIVE:
 *
 *   • ensurePersonalOrg() adopts the user's existing projects + subscription
 *     into their personal org, so nothing about a solo user's experience
 *     changes — they are simply the sole OWNER of a one-person org.
 *   • Access + billing resolve through the org, but always fall back to the
 *     legacy owner/userId path when a project/subscription has no org yet.
 *
 * Roles (descending power): OWNER > ADMIN > DEVELOPER > VIEWER.
 *   OWNER  — full control incl. billing + delete org.
 *   ADMIN  — manage members/invites + everything a developer can do.
 *   DEVELOPER — build/operate projects.
 *   VIEWER — read-only.
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'

export type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'

export const ROLE_RANK: Record<OrgRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  DEVELOPER: 1,
  VIEWER: 0,
}

export function roleAtLeast(role: string | null | undefined, min: OrgRole): boolean {
  if (!role) return false
  const r = ROLE_RANK[role as OrgRole]
  return r != null && r >= ROLE_RANK[min]
}

const INVITE_TTL_DAYS = 14

function orgLockKeys(userId: string): [number, number] {
  const hash = crypto.createHash('sha256').update(`org:${userId}`).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

/**
 * Ensure the user has a personal organization and that their projects +
 * subscription are adopted into it. Idempotent and concurrency-safe (advisory
 * lock keyed on userId). Returns the personal org id.
 */
export async function ensurePersonalOrg(userId: string): Promise<string> {
  // Fast path: an org this user OWNS already exists.
  const existing = await prisma.organization.findFirst({
    where: { ownerId: userId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) {
    // Best-effort adoption of anything created since (cheap, indexed updates).
    await adoptOwnerAssets(userId, existing.id)
    return existing.id
  }

  const [k1, k2] = orgLockKeys(userId)
  const orgId = await prisma.$transaction(async (tx) => {
    // ::int4 casts are load-bearing: Prisma binds JS numbers as bigint here,
    // and pg_advisory_xact_lock has no (bigint, bigint) overload.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    // Re-check inside the lock (another request may have just created it).
    const again = await tx.organization.findFirst({
      where: { ownerId: userId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (again) return again.id

    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
    const label = user?.name?.trim() || user?.email?.split('@')[0] || 'My'
    const name = /team|org/i.test(label) ? label : `${label}'s Team`

    const org = await tx.organization.create({ data: { name, ownerId: userId }, select: { id: true } })
    await tx.organizationMember.create({ data: { orgId: org.id, userId, role: 'OWNER' } })
    return org.id
  })

  await adoptOwnerAssets(userId, orgId)
  return orgId
}

/** Attach the owner's org-less projects + subscriptions to their org. */
async function adoptOwnerAssets(userId: string, orgId: string): Promise<void> {
  await prisma.project.updateMany({
    where: { userId, organizationId: null },
    data: { organizationId: orgId },
  }).catch(() => {})
  await prisma.subscription.updateMany({
    where: { userId, organizationId: null },
    data: { organizationId: orgId },
  }).catch(() => {})
}

/** The org used for the user's own billing/entitlements = the org they own. */
export async function getBillingOrgId(userId: string): Promise<string> {
  return ensurePersonalOrg(userId)
}

/**
 * Is the org on a paid plan (Pro/Enterprise)? Gates the *configuration* of
 * project-scoped members — the enforcement itself always runs, so a downgrade
 * never silently widens a restricted member's access; the owner just can't
 * create new restrictions until they upgrade again. Plan names: SANDBOX = Free,
 * BUILDER = Pro, SCALE = Enterprise (prisma/seed-billing.ts).
 */
export async function orgIsPaid(orgId: string): Promise<boolean> {
  const sub = await prisma.subscription.findFirst({
    where: { organizationId: orgId, status: { in: ['ACTIVE', 'GRACE'] } },
    select: { plan: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return sub?.plan?.name === 'BUILDER' || sub?.plan?.name === 'SCALE'
}

/** All org ids the user belongs to (owner or member). */
export async function getUserOrgIds(userId: string): Promise<string[]> {
  const rows = await prisma.organizationMember.findMany({
    where: { userId },
    select: { orgId: true },
  })
  return rows.map((r) => r.orgId)
}

/** The user's role in an org, or null if not a member. */
export async function userRoleInOrg(orgId: string, userId: string): Promise<OrgRole | null> {
  const m = await prisma.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  })
  return (m?.role as OrgRole) ?? null
}

export interface MemberRow {
  userId: string
  name: string | null
  email: string
  role: OrgRole
  joinedAt: Date
  isOwner: boolean
  // Project-scoped access (Pro+). `restricted` = access is limited to `projectIds`;
  // false = org-wide. Owner/Admin are always org-wide regardless of the flag.
  restricted: boolean
  projectIds: string[]
}

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const [org, members, grants] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }),
    prisma.organizationMember.findMany({
      where: { orgId },
      select: { userId: true, role: true, restricted: true, createdAt: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.projectMember.findMany({ where: { orgId }, select: { userId: true, projectId: true } }),
  ])
  const byUser = new Map<string, string[]>()
  for (const g of grants) {
    const list = byUser.get(g.userId) ?? []
    list.push(g.projectId)
    byUser.set(g.userId, list)
  }
  return members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role as OrgRole,
    joinedAt: m.createdAt,
    isOwner: m.userId === org?.ownerId,
    restricted: m.restricted,
    projectIds: byUser.get(m.userId) ?? [],
  }))
}

/**
 * Set a member's access mode. `restricted:false` → org-wide (clears the
 * allowlist). `restricted:true` → limited to `projectIds` (validated to belong
 * to this org; the allowlist is replaced wholesale). Refuses the owner and
 * admins — they are always org-wide by design. Plan-gating is enforced by the
 * caller (route), not here, so enforcement/cleanup paths can always run.
 */
export async function setMemberScope(
  orgId: string,
  userId: string,
  opts: { restricted: boolean; projectIds: string[] },
): Promise<{ ok: boolean; error?: string }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } })
  if (!org) return { ok: false, error: 'Organization not found.' }
  if (org.ownerId === userId) return { ok: false, error: 'The owner always has full access.' }

  const member = await prisma.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  })
  if (!member) return { ok: false, error: 'That person is not a member of this organization.' }
  if (member.role === 'ADMIN') {
    return { ok: false, error: 'Admins manage the whole organization and always have full access. Change them to Developer or Viewer to scope projects.' }
  }

  if (!opts.restricted) {
    await prisma.$transaction([
      prisma.organizationMember.update({ where: { orgId_userId: { orgId, userId } }, data: { restricted: false } }),
      prisma.projectMember.deleteMany({ where: { orgId, userId } }),
    ])
    return { ok: true }
  }

  // Only the org's own projects can be granted — silently drop anything else.
  const valid = await prisma.project.findMany({
    where: { id: { in: opts.projectIds }, organizationId: orgId },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.organizationMember.update({ where: { orgId_userId: { orgId, userId } }, data: { restricted: true } }),
    prisma.projectMember.deleteMany({ where: { orgId, userId } }),
    ...valid.map((p) => prisma.projectMember.create({ data: { orgId, userId, projectId: p.id } })),
  ])
  return { ok: true }
}

/** Grant a restricted member access to one project (project-level surface). */
export async function grantProjectAccess(orgId: string, userId: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  const [org, member, project] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }),
    prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { role: true, restricted: true } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } }),
  ])
  if (!org) return { ok: false, error: 'Organization not found.' }
  if (!project || project.organizationId !== orgId) return { ok: false, error: 'That project is not in this organization.' }
  if (!member) return { ok: false, error: 'That person is not a member of this organization.' }
  if (org.ownerId === userId || member.role === 'OWNER' || member.role === 'ADMIN' || !member.restricted) {
    return { ok: false, error: 'This member already has access to every project.' }
  }
  await prisma.projectMember.upsert({
    where: { userId_projectId: { userId, projectId } },
    update: {},
    create: { orgId, userId, projectId },
  })
  return { ok: true }
}

/** Remove a member's access to one project. No-op if they weren't granted it. */
export async function revokeProjectAccess(orgId: string, userId: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  await prisma.projectMember.deleteMany({ where: { orgId, userId, projectId } })
  return { ok: true }
}

/**
 * The org roster annotated with each member's effective access to ONE project —
 * powers the project Settings → Access tab. `hasAccess` is true for org-wide
 * members (owner/admin/unrestricted) and for restricted members explicitly
 * granted this project.
 */
export async function listProjectAccess(orgId: string, projectId: string): Promise<
  Array<MemberRow & { hasAccess: boolean }>
> {
  const [members, granted] = await Promise.all([
    listMembers(orgId),
    prisma.projectMember.findMany({ where: { orgId, projectId }, select: { userId: true } }),
  ])
  const grantedSet = new Set(granted.map((g) => g.userId))
  return members.map((m) => ({
    ...m,
    hasAccess: !m.restricted || grantedSet.has(m.userId),
  }))
}

export interface InviteRow {
  id: string
  email: string
  role: OrgRole
  status: string
  createdAt: Date
  expiresAt: Date
  restricted: boolean
  scopedProjectIds: string[]
}

export async function listInvites(orgId: string): Promise<InviteRow[]> {
  const rows = await prisma.organizationInvite.findMany({
    where: { orgId, status: 'pending' },
    select: { id: true, email: true, role: true, status: true, createdAt: true, expiresAt: true, restricted: true, scopedProjectIds: true },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => ({ ...r, role: r.role as OrgRole }))
}

export interface CreateInviteResult {
  ok: boolean
  invite?: { id: string; email: string; role: OrgRole; token: string; expiresAt: Date }
  error?: string
}

/** Create a pending invite. Refuses duplicates + existing members. */
export async function createInvite(args: {
  orgId: string
  email: string
  role: OrgRole
  invitedById: string
  // Optional project-scoped invite (Pro+ — caller gates the plan). Applied when
  // the invite is accepted; ignored for ADMIN (admins are always org-wide).
  restricted?: boolean
  scopedProjectIds?: string[]
}): Promise<CreateInviteResult> {
  const email = args.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' }
  if (args.role === 'OWNER') return { ok: false, error: 'An organization has exactly one owner.' }

  // Scope only applies to Developer/Viewer. Validate the projects belong to the
  // org so a stale/foreign id can never be smuggled into the allowlist.
  const wantRestricted = !!args.restricted && args.role !== 'ADMIN'
  let scopedProjectIds: string[] = []
  if (wantRestricted) {
    const valid = await prisma.project.findMany({
      where: { id: { in: args.scopedProjectIds ?? [] }, organizationId: args.orgId },
      select: { id: true },
    })
    scopedProjectIds = valid.map((p) => p.id)
    if (scopedProjectIds.length === 0) {
      return { ok: false, error: 'Select at least one project for a project-scoped invite.' }
    }
  }

  // Already a member?
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (existingUser) {
    const member = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId: args.orgId, userId: existingUser.id } },
      select: { id: true },
    })
    if (member) return { ok: false, error: 'That person is already a member.' }
  }

  // Existing pending invite → refresh its token/expiry rather than duplicate.
  const token = crypto.randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  const existingInvite = await prisma.organizationInvite.findFirst({
    where: { orgId: args.orgId, email, status: 'pending' },
    select: { id: true },
  })

  const data = { role: args.role, token, expiresAt, invitedById: args.invitedById, restricted: wantRestricted, scopedProjectIds }
  const invite = existingInvite
    ? await prisma.organizationInvite.update({
        where: { id: existingInvite.id },
        data,
        select: { id: true, email: true, role: true, token: true, expiresAt: true },
      })
    : await prisma.organizationInvite.create({
        data: { orgId: args.orgId, email, ...data },
        select: { id: true, email: true, role: true, token: true, expiresAt: true },
      })

  return { ok: true, invite: { ...invite, role: invite.role as OrgRole } }
}

export interface AcceptInviteResult {
  ok: boolean
  orgId?: string
  orgName?: string
  error?: string
}

/**
 * Accept an invite as the given user. Validates status + expiry + email match,
 * then creates the membership. Idempotent — re-accepting is a no-op success.
 */
export async function acceptInvite(token: string, userId: string): Promise<AcceptInviteResult> {
  const invite = await prisma.organizationInvite.findUnique({
    where: { token },
    select: { id: true, orgId: true, email: true, role: true, status: true, expiresAt: true, restricted: true, scopedProjectIds: true },
  })
  if (!invite) return { ok: false, error: 'This invite link is invalid.' }

  const org = await prisma.organization.findUnique({ where: { id: invite.orgId }, select: { name: true } })

  if (invite.status === 'accepted') {
    // Already accepted — treat as success if this user is a member.
    const m = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId } },
      select: { id: true },
    })
    if (m) return { ok: true, orgId: invite.orgId, orgName: org?.name }
  }
  if (invite.status !== 'pending') return { ok: false, error: 'This invite is no longer active.' }
  if (invite.expiresAt < new Date()) {
    await prisma.organizationInvite.update({ where: { id: invite.id }, data: { status: 'expired' } }).catch(() => {})
    return { ok: false, error: 'This invite has expired. Ask for a new one.' }
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!user) return { ok: false, error: 'Sign in to accept this invite.' }
  if (user.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
    return { ok: false, error: `This invite was sent to ${invite.email}. Sign in with that email to accept.` }
  }

  // Project-scoped invites carry their allowlist through to the new membership,
  // so a scoped invitee never sees the org's other projects — not even in the
  // window right after accepting. Re-validate the ids against the org (a project
  // may have been deleted since the invite was sent).
  const applyScope = invite.restricted && invite.role !== 'ADMIN'
  const scopedIds = applyScope
    ? (await prisma.project.findMany({
        where: { id: { in: invite.scopedProjectIds }, organizationId: invite.orgId },
        select: { id: true },
      })).map((p) => p.id)
    : []

  await prisma.$transaction([
    prisma.organizationMember.upsert({
      where: { orgId_userId: { orgId: invite.orgId, userId } },
      update: {}, // already a member → leave role + scope as-is
      create: { orgId: invite.orgId, userId, role: invite.role, restricted: applyScope },
    }),
    ...scopedIds.map((projectId) =>
      prisma.projectMember.upsert({
        where: { userId_projectId: { userId, projectId } },
        update: {},
        create: { orgId: invite.orgId, userId, projectId },
      }),
    ),
    prisma.organizationInvite.update({
      where: { id: invite.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    }),
  ])

  return { ok: true, orgId: invite.orgId, orgName: org?.name }
}

export async function revokeInvite(inviteId: string, orgId: string): Promise<boolean> {
  const res = await prisma.organizationInvite.updateMany({
    where: { id: inviteId, orgId, status: 'pending' },
    data: { status: 'revoked' },
  })
  return res.count > 0
}

/** Remove a member. Refuses to remove the owner. */
export async function removeMember(orgId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } })
  if (!org) return { ok: false, error: 'Organization not found.' }
  if (org.ownerId === userId) return { ok: false, error: 'The owner cannot be removed.' }
  await prisma.organizationMember.deleteMany({ where: { orgId, userId } })
  return { ok: true }
}

/** Change a member's role. Refuses to change the owner or assign OWNER. */
export async function setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<{ ok: boolean; error?: string }> {
  if (role === 'OWNER') return { ok: false, error: 'Ownership transfer is not supported here.' }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } })
  if (org?.ownerId === userId) return { ok: false, error: "The owner's role can't be changed." }
  await prisma.organizationMember.updateMany({ where: { orgId, userId }, data: { role } })
  return { ok: true }
}
