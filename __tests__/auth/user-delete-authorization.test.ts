/**
 * ANY SIGNED-IN ACCOUNT COULD DELETE ANY OTHER
 * ============================================
 * `DELETE /api/users/[userId]` checked only that the caller was signed in, then
 * deleted the account named in the path, cascading every project it owned. The
 * route-authorization sweep fixed GET and PUT on the same route and missed it.
 *
 * It is admin only now, and not self-service either: deleting your own account
 * is DELETE /api/auth/delete-account, which also purges the workspaces.
 *
 * Calls the real handler against the real database. The session lookup is the
 * only thing replaced, so each request is made as a chosen caller with a chosen
 * role. Two-sided: the refusals are paired with the admin's permission, because
 * a refusal-only suite is green when nothing works.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

let caller: { userId: string; userEmail: string; userRole: string } | null = null
jest.mock('@/lib/auth/middleware', () => ({
  ...jest.requireActual('@/lib/auth/middleware'),
  requireAuth: async () => {
    if (!caller) throw new Error('Authentication required')
    return caller
  },
  // The real rule: an admin role (or the founder's address, unset here).
  requireAdmin: async () => {
    const { NextResponse } = await import('next/server')
    if (!caller) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    return caller.userRole === 'admin' ? null : NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  },
}))

const { DELETE } = require('@/app/api/users/[userId]/route')

const created: string[] = []

async function makeUser(label: string) {
  const user = await prisma.user.create({
    data: { email: `user-delete-${label}-${randomUUID()}@example.test`, name: label },
    select: { id: true, email: true },
  })
  created.push(user.id)
  return user
}

function as(user: { id: string; email: string }, role: 'user' | 'admin') {
  caller = { userId: user.id, userEmail: user.email, userRole: role }
}

const call = (userId: string) => DELETE({} as any, { params: Promise.resolve({ userId }) })
const exists = async (id: string) => (await prisma.user.count({ where: { id } })) === 1

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {})
  await prisma.$disconnect()
})

describe('DELETE /api/users/[userId]', () => {
  test('a signed-in account cannot delete another, and is told no such user', async () => {
    const attacker = await makeUser('attacker')
    const victim = await makeUser('victim')
    as(attacker, 'user')

    const res = await call(victim.id)

    expect(res.status).toBe(404)
    expect(await exists(victim.id)).toBe(true)
  })

  test('nor its own: that is /api/auth/delete-account, which also purges workspaces', async () => {
    const self = await makeUser('self')
    as(self, 'user')

    expect((await call(self.id)).status).toBe(404)
    expect(await exists(self.id)).toBe(true)
  })

  test('an admin can delete an account', async () => {
    const admin = await makeUser('admin')
    const target = await makeUser('target')
    as(admin, 'admin')

    expect((await call(target.id)).status).toBe(200)
    expect(await exists(target.id)).toBe(false)
  })
})
