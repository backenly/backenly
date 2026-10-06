/**
 * A real project for the Architecture Evolution Engine suites: an `orders`
 * table whose refund columns arrived together, are set on the same rows and
 * keep changing, with the schema history and request traffic the analysis
 * reads. It proposes to extract the refunds.
 */

import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import { decisionTrail, summarizeDecisions } from '@/lib/evolution-engine/memory'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'
import { handleEvolutionBackfillJob } from '@/lib/structural-evolution/backfill-job'

export interface Fixture {
  ownerId: string
  projectId: string
  schema: string
}

export const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)

export async function asService<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T[]>(sql, ...p)
  })
}

/**
 * A project whose `orders` carries refunds that arrived together, are set on
 * the same rows, and keep changing — the same shape as the structural
 * evolution suite, which the analysis proposes to extract.
 */
export async function buildProject(label: string): Promise<Fixture> {
  const ownerId = (await prisma.user.create({
    data: { email: `evo-engine-${label}-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo' },
  })).id
  const projectId = (await prisma.project.create({ data: { name: `evolution-engine-${label}`, userId: ownerId } })).id
  const schema = await resolveWorkspaceSchema(projectId)
  const t = (n: string) => `"${schema}"."${n}"`
  await q(`CREATE SCHEMA "${schema}"`)
  await q(jwtClaimFunctionSql(schema))
  await q(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    status text NOT NULL DEFAULT 'placed',
    created_at timestamptz NOT NULL DEFAULT now(),
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text,
    refunded_at timestamptz,
    coupon_code text,
    discount_amount numeric
  )`)
  await q(
    `INSERT INTO ${t('orders')} (user_id, total, created_at, refund_amount, refund_reason, refunded_at, coupon_code, discount_amount)
     SELECT gen_random_uuid(), (i % 90) + 10, now() - (i || ' hours')::interval,
            CASE WHEN i % 5 = 0 THEN (i % 40) + 1 END,
            CASE WHEN i % 5 = 0 THEN 'damaged' END,
            CASE WHEN i % 5 = 0 THEN now() - (i || ' hours')::interval + interval '2 days' END,
            CASE WHEN i % 5 = 1 THEN 'SAVE10' END,
            CASE WHEN i % 5 = 2 THEN 5 END
       FROM generate_series(1, 300) i`,
  )
  const svc = `"${schema}"."backenly_jwt_claim"('role') = 'service_role'`
  const sub = `"${schema}"."backenly_jwt_claim"('sub')`
  await q(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await q(`CREATE POLICY orders_rw ON ${t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`ANALYZE ${t('orders')}`)

  const base = ['id', 'user_id', 'total', 'status', 'created_at']
  const snap = (v: number, days: number, cols: string[] | null) =>
    prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId,
        versionNum: v,
        trigger: 'post_migration',
        rawDdl: '',
        createdAt: new Date(Date.now() - days * 86_400_000),
        tables: cols
          ? [{ name: 'orders', columns: cols.map(name => ({ name, type: 'text', nullable: true, default: null, isPrimary: name === 'id' })) }]
          : [],
      },
    })
  await snap(1, 220, null)
  await snap(2, 200, base)
  await snap(3, 60, [...base, 'refund_amount', 'refund_reason', 'refunded_at'])
  await snap(4, 20, [...base, 'refund_amount', 'refund_reason', 'refunded_at', 'coupon_code', 'discount_amount'])
  await prisma.apiRequestLog.createMany({
    data: Array.from({ length: 1_200 }, () => ({
      projectId,
      userId: ownerId,
      method: 'GET',
      path: '/db/orders',
      statusCode: 200,
      duration: 4,
      timestamp: new Date(Date.now() - 86_400_000),
    })),
  })
  return { ownerId, projectId, schema }
}

export async function dropProject(f: Fixture): Promise<void> {
  await q(`DROP SCHEMA IF EXISTS "${f.schema}" CASCADE`).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId: f.projectId } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.maintenanceApproval.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.apiRequestLog.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId: f.projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: f.ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: f.ownerId } }).catch(() => {})
}

export async function requestsOf(projectId: string) {
  const rows = await prisma.healthFinding.findMany({
    where: { projectId, type: EVOLUTION_FINDING_TYPE },
    orderBy: { detectedAt: 'asc' },
    select: { id: true, status: true, details: true },
  })
  return rows.map(r => ({ id: r.id, status: r.status, details: r.details as Record<string, unknown>, ev: (r.details as { evolution: EvolutionRequestDetails }).evolution }))
}

export async function stateOf(projectId: string, decisionId: string) {
  return summarizeDecisions(await decisionTrail(projectId, decisionId))[0]
}

/** Run every queued backfill batch the way the worker would, and mark it done. */
export async function drain(projectId: string): Promise<Array<{ refusal?: string; cursor: string | null }>> {
  const results = []
  for (let i = 0; i < 50; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { projectId, type: 'evolution_backfill', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) break
    const result = await handleEvolutionBackfillJob(job.payload as any)
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'completed', result: result as object, completedAt: new Date() } })
    results.push(result)
  }
  return results
}
