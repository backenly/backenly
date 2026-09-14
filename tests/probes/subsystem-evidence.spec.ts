/**
 * PHASE 2 — subsystem evidence correlation, against the scenario bank
 * ===================================================================
 *
 * The evaluator draws harm from four ledgers that disagree about how they name
 * a table: findings carry `details.tableName`, request logs carry a URL path,
 * audit rows carry an unstructured JSON string, incidents carry a free-form
 * service list. Every one of those is a place attribution can silently go to
 * the wrong subsystem, and a wrong attribution is worse than a missing one —
 * it puts another area's evidence into this one's case.
 *
 * These run against real seeded schemas rather than fixtures, because the
 * failures being guarded are in the queries and the parsing, which a mock
 * reproduces perfectly and therefore cannot catch.
 */

import { PrismaClient } from '@prisma/client'

import { scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import { invalidateSubsystemCache } from '@/lib/autonomy/subsystem'
import {
  evaluateSubsystemRecurrence,
  driftTable,
  tablesNamedIn,
} from '@/lib/autonomy/subsystem-recurrence'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []

async function seed(id: string, ledger = {}): Promise<SeededProject> {
  const s = await seedScenario(prisma, scenario(id), ledger)
  seeded.push(s)
  invalidateSubsystemCache(s.projectId)
  return s
}

afterAll(async () => {
  for (const s of seeded) await teardownScenario(prisma, s)
  await prisma.$disconnect()
})

/** The auth component's evidence in a seeded auth-heavy project. */
const authEvidence = async (s: SeededProject) => {
  const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
  return r.subsystems.find(x => x.membership.includes('users'))!
}

// ── Pure attribution helpers ──────────────────────────────────────────────────

describe('driftTable', () => {
  it('strips the schema qualifier and quotes', () => {
    expect(driftTable('workspace_abc.orders')).toBe('orders')
    expect(driftTable('workspace_abc."order_items"')).toBe('order_items')
    expect(driftTable('orders')).toBe('orders')
  })

  it('returns null for an empty identity', () => {
    expect(driftTable(null)).toBeNull()
    expect(driftTable('')).toBeNull()
  })
})

describe('tablesNamedIn', () => {
  const members = ['orders', 'order_items']

  it('finds a member named in an audit payload', () => {
    expect(tablesNamedIn('{"table":"orders"}', members)).toEqual(['orders'])
  })

  /**
   * The substring trap. `orders` occurs inside `order_items`, so a naive
   * `includes` moves one subsystem's rollback onto another's evidence — and
   * because both are plausible, nobody would notice.
   */
  it('does not match a member that is only a substring of another name', () => {
    expect(tablesNamedIn('{"table":"order_items"}', members)).toEqual(['order_items'])
  })

  it('returns nothing for an empty payload', () => {
    expect(tablesNamedIn(null, members)).toEqual([])
    expect(tablesNamedIn('{}', members)).toEqual([])
  })
})

// ── Harm sources, end to end ──────────────────────────────────────────────────

describe('each harm source reaches the right subsystem', () => {
  it('counts an escalation on a member table', async () => {
    const s = await seed('auth-heavy', {
      escalations: [{ type: 'missing_rls', table: 'sessions' }],
    })
    const auth = await authEvidence(s)
    expect(auth.independentHarm.map(h => h.kind)).toContain('escalation')
  })

  it('counts a 5xx on a member table', async () => {
    const s = await seed('auth-heavy', { serverErrors: [{ table: 'verification_tokens' }] })
    const auth = await authEvidence(s)
    expect(auth.independentHarm.map(h => h.kind)).toContain('server_error')
  })

  it('counts a rollback whose audit payload names a member table', async () => {
    const s = await seed('auth-heavy')
    await prisma.auditLog.create({
      data: {
        projectId: s.projectId,
        action: 'ROLLBACK_DEPLOY',
        type: 'deployment',
        details: JSON.stringify({ reason: 'bad release', tableName: 'sessions' }),
        timestamp: new Date(),
      },
    })
    const auth = await authEvidence(s)
    expect(auth.independentHarm.map(h => h.kind)).toContain('rollback')
  })

  it('counts an incident naming a member table', async () => {
    const s = await seed('auth-heavy')
    await prisma.incident.create({
      data: {
        projectId: s.projectId,
        title: 'signup failing',
        description: 'users cannot register',
        severity: 'high',
        affectedServices: ['sessions'],
      },
    })
    const auth = await authEvidence(s)
    expect(auth.independentHarm.map(h => h.kind)).toContain('incident')
  })
})

describe('harm does not leak between subsystems', () => {
  it('an error on the articles side is not auth evidence', async () => {
    const s = await seed('auth-heavy', { serverErrors: [{ table: 'articles' }] })
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })

    const auth = r.subsystems.find(x => x.membership.includes('users'))!
    const articles = r.subsystems.find(x => x.membership.includes('articles'))!
    expect(auth.independentHarm).toHaveLength(0)
    expect(articles.independentHarm).toHaveLength(1)
  })

  it('an incident naming no member table counts nowhere', async () => {
    const s = await seed('auth-heavy')
    await prisma.incident.create({
      data: {
        projectId: s.projectId,
        title: 'CDN degraded',
        description: 'edge cache',
        severity: 'low',
        affectedServices: ['cdn', 'edge'],
      },
    })
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
    expect(r.subsystems.every(x => x.independentHarm.length === 0)).toBe(true)
  })

  /**
   * One rollback naming three member tables is ONE piece of evidence. Counted
   * per table it would be three, and the harm gate needs only one — so a single
   * event could clear the gate by itself while looking like corroboration.
   */
  it('one rollback naming several member tables counts once', async () => {
    const s = await seed('auth-heavy')
    await prisma.auditLog.create({
      data: {
        projectId: s.projectId,
        action: 'ROLLBACK_DEPLOY',
        type: 'deployment',
        details: JSON.stringify({ tables: ['users', 'sessions', 'verification_tokens'] }),
        timestamp: new Date(),
      },
    })
    const auth = await authEvidence(s)
    expect(auth.independentHarm.filter(h => h.kind === 'rollback')).toHaveLength(1)
  })
})

describe('external DDL is an amplifier, never harm', () => {
  it('records drift as externalDdlCount and not as harm', async () => {
    const s = await seed('auth-heavy')
    for (const t of ['users', 'sessions']) {
      await prisma.schemaDriftEvent.create({
        data: {
          projectId: s.projectId,
          roleName: 'bkn_rw_test',
          commandTag: 'ALTER TABLE',
          objectIdentity: `${s.schema}."${t}"`,
          schemaName: s.schema,
        },
      })
    }
    const auth = await authEvidence(s)
    expect(auth.externalDdlCount).toBe(2)
    expect(auth.independentHarm).toHaveLength(0)
  })

  /**
   * Somebody running ALTER TABLE from psql is a person working, not a backend
   * failing. If external DDL ever reaches the gate, the most actively
   * maintained backend becomes the one reported sickest.
   */
  it('drift alone never fires the detector', async () => {
    const s = await seed('auth-heavy', {
      confirmedRepairs: [
        { type: 'missing_rls', table: 'users' },
        { type: 'missing_fk_index', table: 'sessions', column: 'user_id' },
        { type: 'missing_fk_index', table: 'verification_tokens', column: 'user_id' },
      ],
    })
    for (let i = 0; i < 20; i++) {
      await prisma.schemaDriftEvent.create({
        data: {
          projectId: s.projectId,
          roleName: 'bkn_rw_test',
          commandTag: 'ALTER TABLE',
          objectIdentity: `${s.schema}."users"`,
          schemaName: s.schema,
        },
      })
    }
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
    // Three confirmed repairs across two gaps, twenty external changes, and no
    // independent harm: still silent.
    expect(r.firing).toHaveLength(0)
  })
})

describe('the full firing case, assembled from the bank', () => {
  it('fires with repairs plus one genuinely independent harm signal', async () => {
    const s = await seed('auth-heavy', {
      confirmedRepairs: [
        { type: 'missing_rls', table: 'users' },
        { type: 'missing_fk_index', table: 'sessions', column: 'user_id' },
        { type: 'missing_fk_index', table: 'verification_tokens', column: 'user_id' },
      ],
      serverErrors: [{ table: 'sessions' }],
      changes: [{ table: 'users' }, { table: 'sessions' }],
    })
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
    const auth = r.firing.find(x => x.membership.includes('users'))

    expect(auth).toBeDefined()
    expect(auth!.membership).toEqual(['password_resets', 'sessions', 'users', 'verification_tokens'])
    expect(auth!.confirmedRepairs).toHaveLength(3)
    expect(auth!.distinctGapIdentities).toHaveLength(3)
    expect(auth!.changeCount).toBe(2)
  })

  it('stays silent on the healthy control scenario', async () => {
    const s = await seed('content-community')
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
    expect(r.firing).toHaveLength(0)
  })

  it('refuses to reason about a backend with no constraint skeleton', async () => {
    // Same recurrence evidence as the firing case, on a schema whose
    // relationships exist only as column names. The honest answer is silence.
    const s = await seed('messy-legacy', {
      confirmedRepairs: [
        { type: 'missing_rls', table: 'users' },
        { type: 'missing_fk_index', table: 'orders', column: 'user_id' },
        { type: 'missing_fk_index', table: 'order_items', column: 'order_id' },
      ],
      serverErrors: [{ table: 'orders' }],
    })
    const r = await evaluateSubsystemRecurrence(s.projectId, { kind: 'skeleton' })
    expect(r.noConstraintSkeleton).toBe(true)
    expect(r.firing).toHaveLength(0)
  })
})
