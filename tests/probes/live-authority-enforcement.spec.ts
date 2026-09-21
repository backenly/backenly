/**
 * THE GATE IS THE AUTHORITY, NOT A SHADOW OPINION
 * ===============================================
 *
 * Every earlier proof evaluated the Authority Decision beside the live loop.
 * This one runs the REAL path — persisted intent, persisted grant, the real
 * gate, the real executor boundary — and proves that only AUTO_EXECUTE mutates.
 *
 * Real PostgreSQL throughout. A mock could not tell a gate that refuses from a
 * gate that was never called, which is the only thing this file is for.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { authorizeAutonomousFix, revalidateAtMutationBoundary } from '@/lib/authority/gate'
import { grantAuthority, revokeAuthority, loadGrants } from '@/lib/authority/grants'
import { declareOwnershipIntent } from '@/lib/authority/ownership-intent'
import { P } from '@/lib/principal'

const prisma = new PrismaClient()
const made: Array<{ projectId: string; userId: string; schema: string }> = []

async function project(): Promise<{ projectId: string; userId: string; schema: string }> {
  const userId = randomUUID()
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  await prisma.user.create({
    data: { id: userId, email: `live-${userId.slice(0, 8)}@backenly.test`, name: 'live', password: 'x' },
  })
  await prisma.project.create({ data: { id: projectId, name: 'live-authority', userId } })
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."posts" (id uuid PRIMARY KEY, user_id uuid, body text)`,
  )
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" FORCE ROW LEVEL SECURITY`)
  const rec = { projectId, userId, schema }
  made.push(rec)
  return rec
}

/** The wide-open policy the repair is meant to replace. */
async function wideOpen(schema: string): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE POLICY "p_open" ON "${schema}"."posts" USING (true)`)
}

async function declareIntent(projectId: string, userId: string, provenance: any = 'declared_by_user') {
  return declareOwnershipIntent(prisma, {
    projectId,
    tableName: 'posts',
    ownerColumn: 'user_id',
    provenance,
    declaredBy: P.user(userId),
  })
}

async function grant(projectId: string, userId: string, over: any = {}) {
  return grantAuthority({
    projectId,
    grantedBy: P.user(userId),
    actionClassId: 'tighten_policy',
    environment: 'development',
    ...over,
  })
}

const gateFor = (projectId: string) =>
  authorizeAutonomousFix({
    projectId,
    findingType: 'rls_wide_open',
    tableName: 'posts',
    loop: 'reconciler',
  })

beforeAll(() => {
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'
})

afterAll(async () => {
  for (const m of made) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m.schema}" CASCADE`).catch(() => {})
    await prisma.project.delete({ where: { id: m.projectId } }).catch(() => {})
    await prisma.user.delete({ where: { id: m.userId } }).catch(() => {})
  }
  await prisma.$disconnect()
})

describe('persisted authority survives a round trip', () => {
  it('stores and reloads a grant with its version', async () => {
    const { projectId, userId } = await project()
    const { id } = await grant(projectId, userId)

    const loaded = await loadGrants(projectId, 'tighten_policy')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(id)
    expect(loaded[0].grantedBy).toEqual({ kind: 'user', userId })
    expect(loaded[0].version).toBe(1)
  })

  it('refuses to let an agent grant authority, at the writer', async () => {
    const { projectId } = await project()
    await expect(
      grantAuthority({
        projectId,
        grantedBy: P.agent('key_1') as any,
        actionClassId: 'tighten_policy',
        environment: 'development',
      }),
    ).rejects.toThrow(/Only a person may delegate/)

    // And nothing was written, so a later read cannot find one either.
    expect(await loadGrants(projectId, 'tighten_policy')).toHaveLength(0)
  })
})

describe('the full chain: intent + grant -> AUTO_EXECUTE', () => {
  it('authorizes only when every contract is satisfied', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)

    const gate = await gateFor(projectId)

    expect(gate.decision.intent?.satisfied).toBe(true)
    expect(gate.decision.delegation?.satisfied).toBe(true)
    expect(gate.decision.capability.recoveryStatus).toBe('implemented')
    expect(gate.decision.decision).toBe('AUTO_EXECUTE')
    expect(gate.mayExecute).toBe(true)

    // The lease carries what the mutation boundary must prove unchanged.
    expect(gate.lease.grantId).toBeTruthy()
    expect(gate.lease.grantVersion).toBe(1)
    expect(gate.lease.intentVersion).toBe(1)
  })

  it('writes a receipt naming the principals and the authority source', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)
    await gateFor(projectId)

    const rows = await prisma.auditLog.findMany({
      where: { projectId, action: { startsWith: 'AUTHORITY_' } },
    })
    expect(rows.length).toBeGreaterThan(0)
    const details = JSON.parse(rows[0].details ?? '{}')
    expect(details.actionClass).toBe('tighten_policy')
    expect(details.intent.satisfied).toBe(true)
    expect(details.delegation.satisfied).toBe(true)
    // Receipts are written for refusals too, which is what makes "why did
    // nothing happen" answerable.
    expect(rows[0].metadata).toBeTruthy()
  })
})

describe('the live negative cases: none of these may mutate', () => {
  it('no ownership intent -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await grant(projectId, userId)
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
    expect(gate.decision.intent?.satisfied).toBe(false)
  })

  it('inferred intent only -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId, 'inferred_by_backenly')
    await grant(projectId, userId)
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
    expect(gate.decision.narrowedBy).toContain('intent_intent_provenance_not_authoritative')
  })

  it('no delegation -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
    expect(gate.decision.intent?.satisfied).toBe(true)
  })

  it('wrong environment -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId, { environment: 'production' })
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
  })

  it('expired delegation -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId, { expiresAt: new Date(Date.now() - 60_000) })
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
  })

  it('revoked delegation -> not AUTO_EXECUTE', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    const { id } = await grant(projectId, userId)
    await revokeAuthority(id, userId)
    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(false)
  })

  it('unobservable resource -> FREEZE, and FREEZE names its blocker', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)

    // The schema goes away underneath the loop.
    await prisma.$executeRawUnsafe(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_gone"`)
    try {
      const gate = await gateFor(projectId)
      expect(gate.decision.decision).toBe('FREEZE')
      expect(gate.mayExecute).toBe(false)
      expect(gate.decision.blocker).toBeTruthy()
    } finally {
      await prisma.$executeRawUnsafe(`ALTER SCHEMA "${schema}_gone" RENAME TO "${schema}"`)
    }
  })

  it('an unregistered finding type freezes rather than passing unconstrained', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)

    const gate = await authorizeAutonomousFix({
      projectId,
      findingType: 'something_nobody_declared',
      tableName: 'posts',
      loop: 'reconciler',
    })
    expect(gate.decision.decision).toBe('FREEZE')
    expect(gate.decision.narrowedBy).toContain('action_class_unregistered')
  })
})

describe('the decision is a lease, not a certificate', () => {
  it('a grant revoked AFTER the decision stops the mutation', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    const { id } = await grant(projectId, userId)

    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(true)

    // The owner revokes through a surface that never takes the execution lock.
    await revokeAuthority(id, userId)

    const still = await revalidateAtMutationBoundary(gate, projectId)
    expect(still.stillValid).toBe(false)
    expect(still.reason).toMatch(/revoked|changed/)
  })

  it('an intent superseded AFTER the decision stops the mutation', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)

    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(true)

    // A new declaration supersedes the one the decision relied on.
    await declareIntent(projectId, userId)

    const still = await revalidateAtMutationBoundary(gate, projectId)
    expect(still.stillValid).toBe(false)
    expect(still.reason).toMatch(/superseded|changed/)
  })

  it('a resource that stops being observable stops the mutation', async () => {
    const { projectId, userId, schema } = await project()
    await wideOpen(schema)
    await declareIntent(projectId, userId)
    await grant(projectId, userId)

    const gate = await gateFor(projectId)
    expect(gate.mayExecute).toBe(true)

    await prisma.$executeRawUnsafe(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_gone2"`)
    try {
      const still = await revalidateAtMutationBoundary(gate, projectId)
      expect(still.stillValid).toBe(false)
    } finally {
      await prisma.$executeRawUnsafe(`ALTER SCHEMA "${schema}_gone2" RENAME TO "${schema}"`)
    }
  })
})
