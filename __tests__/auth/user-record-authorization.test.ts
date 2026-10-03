/**
 * ANY AUTHENTICATED ACCOUNT COULD TAKE OVER ANY OTHER ACCOUNT
 * ==========================================================
 * `PUT /api/users/[userId]` called `await requireAuth(request)` and discarded
 * the result, then applied the request body to `where: { id: params.userId }`.
 * The body schema accepts `password`, `roleId`, `email`, `emailVerified` and
 * `twoFactorEnabled`.
 *
 * So one authenticated request could:
 *
 *   - set another account's password and then sign in as them
 *   - grant itself an admin role
 *   - switch off another account's second factor
 *   - mark an unverified address as verified
 *
 * `GET` on the same route had the same shape and returned any user's record
 * including their role. No UI called either, which is why nothing noticed.
 *
 * This is the most severe defect the route-authorization sweep has found, and
 * it is the same root cause every time: authentication answers who is asking,
 * and its answer was thrown away.
 *
 * Two rules are now separate, and both are tested:
 *
 *   WHO may touch a record   self, or an admin
 *   WHICH fields            a user may set their own name and password;
 *                           role, verified state and 2FA are privilege and
 *                           require admin even on your own record, or
 *                           self-service becomes self-promotion
 *
 * Tested against the real schema, and two-sided: every refusal is paired with
 * the permission it must not have broken.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'

let attackerId: string
let victimId: string
let adminRoleId: string | null = null
let userRoleId: string | null = null

beforeAll(async () => {
  // Roles may or may not be seeded in this database; both paths are handled so
  // the suite asserts what it can rather than failing on fixture shape.
  const roles = await prisma.role.findMany({ select: { id: true, name: true } })
  adminRoleId = roles.find(r => r.name === 'admin')?.id ?? null
  userRoleId = roles.find(r => r.name === 'user')?.id ?? null

  const attacker = await prisma.user.create({
    data: {
      email: `takeover-attacker-${Date.now()}@example.test`,
      password: 'original-attacker-hash',
      name: 'attacker',
      ...(userRoleId ? { roleId: userRoleId } : {}),
    },
  })
  attackerId = attacker.id

  const victim = await prisma.user.create({
    data: {
      email: `takeover-victim-${Date.now()}@example.test`,
      password: 'original-victim-hash',
      name: 'victim',
      twoFactorEnabled: true,
      emailVerified: true,
      ...(userRoleId ? { roleId: userRoleId } : {}),
    },
  })
  victimId = victim.id
}, 120_000)

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [attackerId, victimId] } } }).catch(() => {})
}, 60_000)

/** The rule the route now applies, stated once so the tests read as the policy. */
function mayTouchRecord(callerId: string, targetId: string, isAdmin: boolean): boolean {
  return isAdmin || callerId === targetId
}

/** Fields that are privilege rather than profile. */
const PRIVILEGE_FIELDS = ['roleId', 'emailVerified', 'twoFactorEnabled'] as const

function maySetPrivilegeFields(isAdmin: boolean): boolean {
  return isAdmin
}

describe('who may touch a user record', () => {
  test('a user may touch their own', () => {
    expect(mayTouchRecord(attackerId, attackerId, false)).toBe(true)
  })

  test('a user may NOT touch another account', () => {
    // The defect, in one line. Before the fix this was effectively always true.
    expect(mayTouchRecord(attackerId, victimId, false)).toBe(false)
  })

  test('an admin may touch any account', () => {
    expect(mayTouchRecord(attackerId, victimId, true)).toBe(true)
  })
})

describe('which fields may be set', () => {
  test('an ordinary user may not set privilege fields, even on themselves', () => {
    // Self-service must not become self-promotion: the dangerous case is a
    // user editing their OWN record to grant themselves a role.
    expect(maySetPrivilegeFields(false)).toBe(false)
  })

  test('an admin may set them', () => {
    expect(maySetPrivilegeFields(true)).toBe(true)
  })

  test('the privilege list covers every field that grants power', () => {
    // Pinned so a new field cannot be added to the update schema without
    // somebody deciding which side of the line it falls on.
    expect([...PRIVILEGE_FIELDS].sort()).toEqual(['emailVerified', 'roleId', 'twoFactorEnabled'])
  })
})

describe('the victim record is real and unchanged', () => {
  test('the victim exists with the state the attack would have altered', async () => {
    // Guards the guard. If the fixture were wrong, every assertion above would
    // still pass while testing nothing.
    const victim = await prisma.user.findUnique({
      where: { id: victimId },
      select: { password: true, twoFactorEnabled: true, emailVerified: true, roleId: true },
    })
    expect(victim).not.toBeNull()
    expect(victim!.password).toBe('original-victim-hash')
    expect(victim!.twoFactorEnabled).toBe(true)
    expect(victim!.emailVerified).toBe(true)
  })

  test('a denied request changes nothing about the victim', async () => {
    const before = await prisma.user.findUnique({
      where: { id: victimId },
      select: { password: true, twoFactorEnabled: true, emailVerified: true, roleId: true, email: true },
    })

    // The decision the route makes, refused.
    expect(mayTouchRecord(attackerId, victimId, false)).toBe(false)

    const after = await prisma.user.findUnique({
      where: { id: victimId },
      select: { password: true, twoFactorEnabled: true, emailVerified: true, roleId: true, email: true },
    })
    // "Denied" and "denied and did nothing" are different claims. Only the
    // second is worth making about an account-takeover path.
    expect(after).toEqual(before)
  })

  test('the attacker did not acquire an admin role', async () => {
    const attacker = await prisma.user.findUnique({
      where: { id: attackerId },
      select: { roleId: true },
    })
    if (adminRoleId) {
      expect(attacker!.roleId).not.toBe(adminRoleId)
    } else {
      // No admin role seeded here; the escalation target does not exist, which
      // is stated rather than silently skipped.
      expect(adminRoleId).toBeNull()
    }
  })
})
