/**
 * A REJECTED AUTHORIZATION CHANGE IS PUT BACK EXACTLY
 * ===================================================
 *
 * `tighten_policy` is authorized on a declared recovery, `restore_policies`,
 * and the Authority Decision reports that recovery as implemented. Until the
 * executor ran it, the claim was true of the maintenance path only: a policy
 * repair the reconciler made that then failed verification was escalated with
 * the new policy still in place. The receipt promised a recovery the loop never
 * performed.
 *
 * This file drives the real path end to end — persisted intent, persisted
 * grant, the real gate, the real executor, real PostgreSQL — and replaces only
 * the verifier's verdict, because a correct repair that genuinely fails
 * verification is not something a fixture can produce on demand. Everything
 * the assertions read comes from `pg_policies` and `pg_class`.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

/** Only the verdict is replaced. See verification-never-fails-open.test.ts for why a Proxy. */
let verifierMode: 'real' | 'unresolved' = 'real'

jest.mock('@/lib/autonomy/desired-state', () => {
  const load = () => jest.requireActual('@/lib/autonomy/desired-state') as Record<string, unknown>
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === '__esModule') return true
        if (prop === 'evaluateFixOutcome') {
          return async (...args: unknown[]) => {
            if (verifierMode === 'unresolved') {
              return {
                recheck: 'unresolved',
                regressions: [],
                accepted: false,
                reason: 'the gap is still present on re-check',
              }
            }
            return (load().evaluateFixOutcome as (...a: unknown[]) => unknown)(...args)
          }
        }
        return load()[prop]
      },
    },
  )
})

import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { declareOwnershipIntent } from '@/lib/authority/ownership-intent'
import { grantAuthority } from '@/lib/authority/grants'
import { P } from '@/lib/principal'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

interface Fixture {
  userId: string
  projectId: string
  planId: string
  schema: string
}
const made: Fixture[] = []

/**
 * One user-owned table with a wide-open policy beside a real one.
 *
 * RLS is enabled and deliberately NOT forced, and the second policy has a real
 * predicate the repair must leave alone, so an exact restore has three things
 * to get right that a sloppy one would not: the dropped policy, the untouched
 * policy, and the flag the repair may have changed.
 */
async function fixture(): Promise<Fixture> {
  const userId = randomUUID()
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  await prisma.user.create({
    data: { id: userId, email: `tp+${userId.slice(0, 8)}@backenly.test`, name: 'tp', password: 'x' },
  })
  const plan = await prisma.plan.create({
    data: {
      name: `TP_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  await prisma.subscription.create({ data: { userId, planId: plan.id, status: 'ACTIVE' } as any })
  await prisma.project.create({
    data: { id: projectId, name: 'tighten-policy-recovery', userId, autonomyLevel: 'AGGRESSIVE' } as any,
  })
  await q(`CREATE SCHEMA "${schema}"`)
  await q(`CREATE TABLE "${schema}"."posts" (id uuid PRIMARY KEY, user_id uuid, body text)`)
  await q(`ALTER TABLE "${schema}"."posts" ENABLE ROW LEVEL SECURITY`)
  await q(`CREATE POLICY "p_open" ON "${schema}"."posts" USING (true)`)
  await q(`CREATE POLICY "p_insert_has_owner" ON "${schema}"."posts" FOR INSERT WITH CHECK (user_id IS NOT NULL)`)
  await prisma.table.create({ data: { projectId, name: 'posts', schema, description: 'fixture' } })

  await declareOwnershipIntent(prisma, {
    projectId,
    tableName: 'posts',
    ownerColumn: 'user_id',
    provenance: 'declared_by_user',
    declaredBy: P.user(userId),
  })
  await grantAuthority({
    projectId,
    grantedBy: P.user(userId),
    actionClassId: 'tighten_policy',
    environment: 'development',
  })

  const f = { userId, projectId, planId: plan.id, schema }
  made.push(f)
  return f
}

async function openFinding(f: Fixture): Promise<string> {
  const row = await prisma.healthFinding.create({
    data: {
      projectId: f.projectId,
      // The type detectOverPermissiveRls actually emits.
      type: 'rls_expression_invalid',
      severity: 'warning',
      status: 'open',
      details: { tableName: 'posts', policyName: 'p_open', policyCommand: 'ALL', schemaName: f.schema },
    },
  })
  return row.id
}

/** Ground truth: the policy set and RLS flags, from the catalog. */
async function catalog(f: Fixture) {
  const policies = await prisma.$queryRawUnsafe<
    Array<{ policyname: string; permissive: string; cmd: string; qual: string | null; with_check: string | null }>
  >(
    `SELECT policyname, permissive, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = $1 AND tablename = 'posts' ORDER BY policyname`,
    f.schema,
  )
  const flags = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'posts'`,
    f.schema,
  )
  return { policies, flags: flags[0] }
}

afterAll(async () => {
  for (const f of made) {
    await q(`DROP SCHEMA IF EXISTS "${f.schema}" CASCADE`).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
    await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: f.projectId } }).catch(() => {})
    await prisma.subscription.deleteMany({ where: { userId: f.userId } }).catch(() => {})
    await prisma.plan.deleteMany({ where: { id: f.planId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: f.userId } }).catch(() => {})
  }
  await prisma.$disconnect()
}, 180_000)

beforeEach(() => {
  verifierMode = 'real'
})

describe('an authorized tighten_policy repair', () => {
  it('replaces the wide-open policy with the predicate the intent declares', async () => {
    const f = await fixture()
    const id = await openFinding(f)

    const res = await runAutoFix(id, f.projectId, { skipCooldown: true })
    expect(res.outcome).toBe('auto_fixed')

    const after = await catalog(f)
    const names = after.policies.map(p => p.policyname)
    expect(names).not.toContain('p_open')
    // The policy with a real predicate is a considered decision; untouched.
    expect(names).toContain('p_insert_has_owner')
    // Scoped on the declared owner column, not merely "some policy exists".
    const scoped = after.policies.filter(p => /user_id/.test(`${p.qual ?? ''} ${p.with_check ?? ''}`))
    expect(scoped.some(p => p.policyname !== 'p_insert_has_owner')).toBe(true)

    // Nothing was rolled back, so nothing claims it was.
    expect(await prisma.auditLog.count({ where: { projectId: f.projectId, action: 'AUTHORITY_RECOVERY' } })).toBe(0)
  }, 180_000)
})

describe('when the verifier rejects the repair', () => {
  it('restores the exact pre-repair policies and RLS flags, and says so', async () => {
    const f = await fixture()
    const id = await openFinding(f)
    const before = await catalog(f)
    expect(before.policies.map(p => p.policyname)).toEqual(['p_insert_has_owner', 'p_open'])
    expect(before.flags).toEqual({ relrowsecurity: true, relforcerowsecurity: false })

    verifierMode = 'unresolved'
    const res = await runAutoFix(id, f.projectId, { skipCooldown: true })

    // ── Not recorded as fixed ─────────────────────────────────────────────
    // `escalated` is the result; `pending_approval` is the status it leaves on
    // the finding, asserted below.
    expect(res.outcome).toBe('escalated')
    expect(await prisma.auditLog.count({ where: { projectId: f.projectId, action: 'HEALTH_AUTO_FIXED' } })).toBe(0)

    // ── The repair really ran, and the recovery really restored ──────────
    //
    // `verified` is only reachable when the post-state differed from the
    // pre-state (otherwise the status is `not_needed`), so this one row proves
    // both that the mutation happened and that it was undone.
    const rec = await prisma.auditLog.findFirst({
      where: { projectId: f.projectId, action: 'AUTHORITY_RECOVERY' },
      select: { details: true },
    })
    expect(rec).not.toBeNull()
    const d = JSON.parse(rec!.details as string)
    expect(d.strategy).toBe('restore_policies')
    expect(d.status).toBe('verified')
    expect(d.findingId).toBe(id)

    // ── Exact semantics, from the catalog ─────────────────────────────────
    const after = await catalog(f)
    expect(after.policies).toEqual(before.policies)
    expect(after.flags).toEqual(before.flags)

    // ── The finding says what state the table was left in ────────────────
    const finding = await prisma.healthFinding.findUnique({ where: { id } })
    expect(finding!.status).toBe('pending_approval')
    expect(String((finding!.details as any).escalation.reason)).toMatch(/restore_policies\): verified/)
  }, 180_000)
})
