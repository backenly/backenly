/**
 * PRINCIPALS: WHO ASKED, WHO ALLOWED IT, WHO DID IT
 * ================================================
 *
 * Phase 1's success condition is narrow and behavioural: new autonomy activity
 * is principal-aware, legacy representations resolve into one vocabulary where
 * that is possible, and unknown identity stays unknown instead of being
 * fabricated into something plausible.
 *
 * These are the four cases from the phase plan, exercised against a real
 * PostgreSQL rather than asserted against the type. A type test would pass on an
 * implementation that never wrote a row.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  P,
  describe as describePrincipal,
  fromApprovedBy,
  fromAuditLog,
  fromBackendActor,
  isWeakAttribution,
  loopPrincipals,
  principalsToMetadata,
  readPrincipals,
  toBackendActor,
  type Principal,
} from '@/lib/principal'

const prisma = new PrismaClient()
const created: { users: string[]; projects: string[] } = { users: [], projects: [] }

async function makeProject(): Promise<{ projectId: string; userId: string }> {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: {
      id: userId,
      email: `principal-${userId.slice(0, 8)}@backenly.test`,
      name: 'principal test',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'principal-test', userId } })
  created.users.push(userId)
  created.projects.push(projectId)
  return { projectId, userId }
}

afterAll(async () => {
  for (const id of created.projects) {
    await prisma.project.delete({ where: { id } }).catch(() => {})
  }
  for (const id of created.users) {
    await prisma.user.delete({ where: { id } }).catch(() => {})
  }
  await prisma.$disconnect()
})

describe('case 1 — the reconciler repairs an index under the project dial', () => {
  it('records the loop as requester and executor, and the owner as authorizer', async () => {
    const { projectId, userId } = await makeProject()

    const set = await loopPrincipals(prisma, projectId, 'reconciler')

    expect(set.requestedBy).toEqual({ kind: 'backenly', loop: 'reconciler' })
    expect(set.executedBy).toEqual({ kind: 'backenly', loop: 'reconciler' })
    // The dial is the delegation and the owner controls the dial, so the owner
    // is the standing authorizer for anything the loop does.
    expect(set.authorizedBy).toEqual({ kind: 'user', userId })
  })

  it('survives a round trip through a real audit row', async () => {
    const { projectId, userId } = await makeProject()
    const set = await loopPrincipals(prisma, projectId, 'reconciler')

    const row = await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_LIVE_RUN',
        type: 'autonomy',
        details: JSON.stringify({ applied: 1 }),
        metadata: principalsToMetadata(set) as any,
      },
    })

    const read = await prisma.auditLog.findUnique({ where: { id: row.id } })
    const back = readPrincipals(read!.metadata)

    expect(back?.executedBy).toEqual({ kind: 'backenly', loop: 'reconciler' })
    expect(back?.authorizedBy).toEqual({ kind: 'user', userId })
    // And the single-actor accessor agrees with the set.
    expect(fromAuditLog(read as any)).toEqual({ kind: 'backenly', loop: 'reconciler' })
  })
})

describe('case 2 — an agent requests a destructive change a human approves', () => {
  it('keeps requester, authorizer and executor distinct', () => {
    const apiKeyId = 'key_abc123'
    const approver = randomUUID()

    const set = {
      requestedBy: P.agent(apiKeyId, 'claude-code'),
      authorizedBy: fromApprovedBy(approver),
      executedBy: P.maintenance(),
    }

    expect(set.requestedBy).toEqual({
      kind: 'agent',
      apiKeyId,
      onBehalfOf: 'claude-code',
    })
    expect(set.authorizedBy).toEqual({ kind: 'user', userId: approver })
    expect(set.executedBy).toEqual({ kind: 'backenly', loop: 'maintenance' })

    // Three different principals in one action is the whole point; if any two
    // collapsed, the receipt could not answer "who allowed this".
    const kinds = new Set([
      describePrincipal(set.requestedBy),
      describePrincipal(set.authorizedBy),
      describePrincipal(set.executedBy),
    ])
    expect(kinds.size).toBe(3)
  })

  it('an agent can never be the authorizer of its own request', () => {
    // Enforced here as a property of the vocabulary. An agent principal is a
    // legitimate REQUESTER; nothing in Phase 1 may let it authorize, and the
    // approval path resolves its approver from a stored human id.
    const agent = P.agent('key_abc123')
    expect(agent.kind).toBe('agent')
    expect(fromApprovedBy(null).kind).toBe('unknown')
    expect(fromApprovedBy('key_abc123').kind).toBe('unknown')
  })
})

describe('case 3 — maintenance executes an approved rung', () => {
  it('names the approval principal as authorizer and the loop as executor', async () => {
    const { projectId, userId } = await makeProject()

    const set = {
      requestedBy: P.maintenance(),
      authorizedBy: fromApprovedBy(userId),
      executedBy: P.maintenance(),
    }

    const row = await prisma.auditLog.create({
      data: {
        projectId,
        action: 'MAINTENANCE_ROLLBACK_PERFORMED',
        type: 'autonomy',
        details: JSON.stringify({ status: 'verified' }),
        metadata: principalsToMetadata(set) as any,
      },
    })

    const back = readPrincipals((await prisma.auditLog.findUnique({ where: { id: row.id } }))!.metadata)
    expect(back?.requestedBy).toEqual({ kind: 'backenly', loop: 'maintenance' })
    expect(back?.authorizedBy).toEqual({ kind: 'user', userId })
  })
})

describe('case 4 — an external schema change', () => {
  it('is attributed to a database role and marked weak', () => {
    const p = P.external('backenly_user')
    expect(p).toEqual({ kind: 'external', role: 'backenly_user' })

    // A shared role identifies a credential and a context, never a person.
    expect(isWeakAttribution(p)).toBe(true)
    expect(describePrincipal(p)).toBe('database role backenly_user')
    expect(describePrincipal(p)).not.toMatch(/user:/)
  })

  it('round-trips through the legacy ledger vocabulary without becoming a person', () => {
    const p = P.external('some_role')
    const ledger = toBackendActor(p)
    expect(ledger.actorType).toBe('system')
    expect(fromBackendActor(ledger.actorType, ledger.actorId)).toEqual(p)
  })
})

describe('unknown stays unknown', () => {
  it('a legacy autonomy row resolves to unknown, not to a fabricated actor', async () => {
    const { projectId } = await makeProject()

    // Exactly what recordAutonomousAction wrote before Phase 1: no actor at all.
    const row = await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_LIVE_RUN',
        type: 'autonomy',
        details: JSON.stringify({ applied: 2 }),
      },
    })

    const read = await prisma.auditLog.findUnique({ where: { id: row.id } })
    const who = fromAuditLog(read as any)

    expect(who.kind).toBe('unknown')
    expect(isWeakAttribution(who)).toBe(true)
    // The reason travels with it, so a reader knows why rather than seeing a blank.
    expect((who as any).why).toMatch(/before principals/)
  })

  it('an ambiguous backenly_agent row does not guess a loop', () => {
    // The old vocabulary used one value for the AI executor AND both autonomy
    // loops. Resolving it to 'reconciler' would invent an attribution the row
    // never carried.
    expect(fromBackendActor('backenly_agent', null).kind).toBe('unknown')
    expect(fromBackendActor('backenly_agent', 'reconciler')).toEqual({
      kind: 'backenly',
      loop: 'reconciler',
    })
  })

  it('a project whose owner cannot be read authorizes nothing', async () => {
    const set = await loopPrincipals(prisma, randomUUID(), 'reconciler')
    expect(set.authorizedBy!.kind).toBe('unknown')
    expect(set.executedBy).toEqual({ kind: 'backenly', loop: 'reconciler' })
  })
})

describe('the legacy ledger keeps working', () => {
  it('every principal narrows to a valid BackendEvent actorType', () => {
    const all: Principal[] = [
      P.user('u1'),
      P.agent('k1'),
      P.reconciler(),
      P.maintenance(),
      P.operator('cli'),
      P.external('r1'),
      P.unknown('because'),
    ]
    for (const p of all) {
      const { actorType } = toBackendActor(p)
      expect(['user', 'backenly_agent', 'system']).toContain(actorType)
    }
  })
})
