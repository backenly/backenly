/**
 * A workspace owned the way production owns one, for the structural-evolution
 * suites that must not run as a superuser.
 *
 * PostgreSQL exempts superusers (and BYPASSRLS roles) from row-level security,
 * and the local and CI test role is a superuser. So every statement here runs
 * under `SET LOCAL ROLE` as one of:
 *
 *   platform   NOSUPERUSER NOBYPASSRLS, owns the schema and every table in it,
 *              runs the ladder AND serves the runtime's end users (claims set)
 *   client     NOSUPERUSER NOBYPASSRLS, a REST-style role holding grants
 *
 * and the ladder's SQL is rendered by the production renderers and run as the
 * platform, exactly as production runs it.
 */

import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql, type RlsIdentity } from '@/lib/services/rls-session'
import { granteesWith, readTableFacts, type TableFacts } from '@/lib/structural-evolution/facts'
import { workspaceOn } from '@/lib/structural-evolution/workspace'
import {
  backfillBatchSql,
  carriedObjects,
  createSatelliteSql,
  exposeReadsSql,
  forwardSyncSql,
  ladderAccessSql,
  ladderNames,
  openWritesSql,
  type ExtractionSpec,
} from '@/lib/structural-evolution/sql'

export const ANON: RlsIdentity = { userId: '' }
export const SERVICE: RlsIdentity = { userId: '', isServiceRole: true, userRole: 'service' }
export const asUser = (userId: string): RlsIdentity => ({ userId })

export interface OwnedWorkspace {
  schema: string
  platform: string
  client: string
  t: (name: string) => string
  /** One transaction as `role` with claims, optionally in the ladder's own context. Returns the last statement's rows. */
  as: <T = any>(role: string, claims: RlsIdentity, sql: string | string[], opts?: { ladder?: boolean; params?: unknown[] }) => Promise<T[]>
  /** The same, handing the transaction to `fn` after role, claims and context are set. */
  within: <T>(role: string, claims: RlsIdentity, fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { ladder?: boolean }) => Promise<T>
  facts: () => Promise<TableFacts>
  drop: () => Promise<void>
}

/**
 * Two roles and a schema owned by the platform role. `setup` runs as the
 * platform with the service claim, after the claim function exists.
 */
export async function ownedWorkspace(label: string, spec: ExtractionSpec, setup: (w: OwnedWorkspace) => string[]): Promise<OwnedWorkspace> {
  const run = randomBytes(4).toString('hex')
  const platform = `bkn_evo_plat_${label}_${run}`
  const client = `bkn_evo_web_${label}_${run}`
  const schema = `evo_${label}_${run}`
  const t = (n: string) => `"${schema}"."${n}"`

  const within: OwnedWorkspace['within'] = (role, claims, fn, opts = {}) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`)
      await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams(claims))
      if (opts.ladder) await tx.$executeRawUnsafe(ladderAccessSql(spec))
      return fn(tx)
    })
  const as: OwnedWorkspace['as'] = (role, claims, sql, opts = {}) =>
    within(
      role,
      claims,
      async tx => {
        let last: any[] = []
        for (const s of Array.isArray(sql) ? sql : [sql]) last = await tx.$queryRawUnsafe<any[]>(s, ...(opts.params ?? []))
        return last
      },
      opts,
    )

  const w: OwnedWorkspace = {
    schema,
    platform,
    client,
    t,
    as,
    within,
    facts: async () => (await readTableFacts(workspaceOn(prisma, schema), spec.host))!,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${client}"`).catch(() => {})
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${platform}"`).catch(() => {})
    },
  }
  await prisma.$executeRawUnsafe(`CREATE ROLE "${platform}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`CREATE ROLE "${client}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION "${platform}"`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${client}"`)
  await as(platform, SERVICE, [jwtClaimFunctionSql(schema), ...setup(w)])
  return w
}

/** `<schema>.backenly_jwt_claim('role') = 'service_role'` and the `sub` comparison, for policies. */
export const claimSql = (w: OwnedWorkspace) => ({
  svc: `${w.t('backenly_jwt_claim')}('role') = 'service_role'`,
  sub: `${w.t('backenly_jwt_claim')}('sub')`,
})

export type Rung = 'create' | 'sync' | 'backfill' | 'expose' | 'open'

/** Run ladder rungs as the platform, rendered by the production renderers from live facts. */
export async function runLadder(w: OwnedWorkspace, spec: ExtractionSpec, rungs: Rung[]): Promise<void> {
  const target = { schema: w.schema }
  for (const rung of rungs) {
    const facts = await w.facts()
    if (rung === 'create') {
      const carried = carriedObjects(facts, spec, ladderNames(spec), target, { includeForeignKeys: true })
      await w.as(w.platform, SERVICE, createSatelliteSql(facts, spec, target, carried, `plan-${w.schema}`))
    } else if (rung === 'sync') {
      await w.as(w.platform, SERVICE, forwardSyncSql(facts, spec, target))
    } else if (rung === 'backfill') {
      let cursor: string | null = null
      for (let i = 0; i < 100; i++) {
        const [row] = await w.as<{ scanned: bigint; next_cursor: string | null }>(w.platform, SERVICE, backfillBatchSql(facts, spec, target, 50), {
          ladder: true,
          params: [cursor],
        })
        cursor = row?.next_cursor ?? cursor
        if (Number(row?.scanned ?? 0) < 50) break
      }
    } else if (rung === 'expose') {
      await w.as(w.platform, SERVICE, exposeReadsSql(facts, spec, target, granteesWith(facts, 'SELECT')))
    } else if (rung === 'open') {
      const readers = granteesWith(facts, 'SELECT')
      await w.as(w.platform, SERVICE, openWritesSql(facts, spec, target, granteesWith(facts, 'UPDATE').filter(r => readers.includes(r))))
    }
  }
}
