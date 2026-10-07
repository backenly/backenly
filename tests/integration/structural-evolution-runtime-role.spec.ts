/**
 * THE NEW TABLE, AS THE RUNTIME REACHES IT — the platform role, not a superuser
 * ===========================================================================
 *
 * The runtime serves end users as the platform's own database role: the same
 * role that creates the new table, owns it, and runs the forward sync. Only
 * claims and FORCE ROW LEVEL SECURITY keep one end user from another. So the
 * satellite's policy for its owner must never admit a request the runtime
 * serves; it admits the platform only inside the ladder's own work.
 *
 * Every other suite runs as a superuser, which PostgreSQL exempts from
 * row-level security, so none of them can see this. Here the workspace is owned
 * by a NOSUPERUSER NOBYPASSRLS role, as in production, and every statement of
 * the ladder and of "the runtime" runs as it.
 *
 *   closed      created and backfilled, the new table shows the runtime nothing
 *               and accepts nothing from it, under any claims
 *   ladder      Backenly's own context sees and copies every row; a host write
 *               served by the runtime is still mirrored
 *   open        once reads and writes open, the runtime gets from the new table
 *               exactly what it gets from the host, claim by claim
 *   no bypass   a client that sets the sync's echo guard by hand is still held
 *               to the host's update policy
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql, type RlsIdentity } from '@/lib/services/rls-session'
import { readTableFacts, granteesWith, type TableFacts } from '@/lib/structural-evolution/facts'
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

jest.setTimeout(120_000)

const RUN = randomBytes(4).toString('hex')
const PLAT = `bkn_evo_plat_${RUN}`
const WEB = `bkn_evo_web_${RUN}`
const SCHEMA = `evo_runtime_${RUN}`
const t = (n: string) => `"${SCHEMA}"."${n}"`
const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }
const N = ladderNames(SPEC)
const A = randomUUID()
const B = randomUUID()

const ANON: RlsIdentity = { userId: '' }
const AS_A: RlsIdentity = { userId: A }
const SERVICE: RlsIdentity = { userId: '', isServiceRole: true, userRole: 'service' }

/** One transaction as `role`, with claims, optionally in the ladder's own context. */
async function as<T = any>(role: string, claims: RlsIdentity, sql: string[] | string, opts: { ladder?: boolean; params?: unknown[] } = {}) {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`)
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams(claims))
    if (opts.ladder) await tx.$executeRawUnsafe(ladderAccessSql(SPEC))
    const all = Array.isArray(sql) ? sql : [sql]
    let last: T[] = []
    for (const s of all) last = await tx.$queryRawUnsafe<T[]>(s, ...(opts.params ?? []))
    return last
  })
}

const count = async (role: string, claims: RlsIdentity, table: string, where = 'true', opts: { ladder?: boolean } = {}) =>
  Number((await as<{ n: bigint }>(role, claims, `SELECT count(*)::bigint AS n FROM ${t(table)} WHERE ${where}`, opts))[0].n)

/** The same claims see as many refunds through the new table as through the host. */
async function sameAsHost(claims: RlsIdentity) {
  return {
    host: await count(PLAT, claims, 'orders', 'refund_amount IS NOT NULL OR refund_reason IS NOT NULL'),
    satellite: await count(PLAT, claims, 'order_refunds'),
  }
}

let facts: TableFacts

beforeAll(async () => {
  const q = (s: string) => prisma.$executeRawUnsafe(s)
  await q(`CREATE ROLE "${PLAT}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await q(`CREATE ROLE "${WEB}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await q(`CREATE SCHEMA "${SCHEMA}" AUTHORIZATION "${PLAT}"`)
  await q(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${WEB}"`)

  const svc = `${t('backenly_jwt_claim')}('role') = 'service_role'`
  const own = `user_id::text = ${t('backenly_jwt_claim')}('sub')`
  await as(PLAT, SERVICE, [
    jwtClaimFunctionSql(SCHEMA),
    `CREATE TABLE ${t('orders')} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       public boolean NOT NULL DEFAULT false,
       refund_amount numeric,
       refund_reason text)`,
    `ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`,
    // Anyone may see public orders; only their owner may change one.
    `CREATE POLICY see ON ${t('orders')} FOR SELECT USING (${svc} OR ${own} OR public)`,
    `CREATE POLICY add ON ${t('orders')} FOR INSERT WITH CHECK (${svc} OR ${own})`,
    `CREATE POLICY change ON ${t('orders')} FOR UPDATE USING (${svc} OR ${own}) WITH CHECK (${svc} OR ${own})`,
    `CREATE POLICY remove ON ${t('orders')} FOR DELETE USING (${svc} OR ${own})`,
    `INSERT INTO ${t('orders')} (user_id, public, refund_amount, refund_reason)
     SELECT CASE WHEN i % 2 = 0 THEN '${A}'::uuid ELSE '${B}'::uuid END, i % 3 = 0,
            CASE WHEN i % 4 < 2 THEN i END, CASE WHEN i % 4 < 2 THEN 'r' || i END
       FROM generate_series(1, 24) i`,
    `GRANT SELECT, UPDATE ON ${t('orders')} TO "${WEB}"`,
  ])
  facts = (await readTableFacts(SCHEMA, 'orders'))!
  expect(facts.owner).toBe(PLAT)
  expect(facts.forceRowSecurity).toBe(true)

  // The ladder up to, not including, opening anything — run as the platform.
  const target = { schema: SCHEMA }
  const carried = carriedObjects(facts, SPEC, N, target, { includeForeignKeys: false })
  await as(PLAT, SERVICE, [...createSatelliteSql(facts, SPEC, target, carried, 'plan-runtime'), ...forwardSyncSql(facts, SPEC, target)])
  await as(PLAT, SERVICE, backfillBatchSql(facts, SPEC, target, 1_000), { ladder: true, params: [null] })
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${WEB}"`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PLAT}"`).catch(() => {})
})

describe('before anything is opened', () => {
  it('the ladder\'s own context sees, and copied, every refund', async () => {
    const all = await count(PLAT, SERVICE, 'orders', 'refund_amount IS NOT NULL')
    expect(all).toBe(12)
    expect(await count(PLAT, SERVICE, 'order_refunds', 'true', { ladder: true })).toBe(all)
  })

  it.each([
    ['anonymous', ANON],
    ['a signed-in end user', AS_A],
    ['the service-role claim', SERVICE],
  ])('the runtime, serving %s, sees nothing in the new table', async (_who, claims) => {
    expect(await count(PLAT, claims as RlsIdentity, 'order_refunds')).toBe(0)
  })

  it('and changes nothing in it', async () => {
    const [{ n }] = await as<{ n: bigint }>(PLAT, ANON, `WITH d AS (DELETE FROM ${t('order_refunds')} RETURNING 1) SELECT count(*)::bigint AS n FROM d`)
    expect(Number(n)).toBe(0)
    await expect(
      as(PLAT, AS_A, `INSERT INTO ${t('order_refunds')} (order_id, refund_amount) SELECT id, 1 FROM ${t('orders')} WHERE refund_amount IS NULL LIMIT 1`),
    ).rejects.toThrow(/row-level security/)
    expect(await count(PLAT, SERVICE, 'order_refunds', 'true', { ladder: true })).toBe(12)
  })

  it('a host write the runtime serves is still mirrored', async () => {
    const [{ id }] = await as<{ id: string }>(PLAT, AS_A, `SELECT id::text AS id FROM ${t('orders')} WHERE user_id = '${A}' AND refund_amount IS NOT NULL ORDER BY id LIMIT 1`)
    await as(PLAT, AS_A, `UPDATE ${t('orders')} SET refund_reason = 'changed by A' WHERE id = '${id}'`)
    const [row] = await as<{ r: string }>(PLAT, SERVICE, `SELECT refund_reason AS r FROM ${t('order_refunds')} WHERE order_id = '${id}'`, { ladder: true })
    expect(row.r).toBe('changed by A')
  })
})

describe('once reads and writes are open', () => {
  beforeAll(async () => {
    const target = { schema: SCHEMA }
    const readers = granteesWith(facts, 'SELECT')
    const writers = granteesWith(facts, 'UPDATE').filter(r => readers.includes(r))
    expect(writers).toEqual([WEB])
    await as(PLAT, SERVICE, [...exposeReadsSql(facts, SPEC, target, readers), ...openWritesSql(facts, SPEC, target, writers)])
  })

  it.each([
    ['anonymous', ANON],
    ['a signed-in end user', AS_A],
    ['the service-role claim', SERVICE],
  ])('the runtime, serving %s, sees exactly the refunds the host shows it', async (_who, claims) => {
    const r = await sameAsHost(claims as RlsIdentity)
    expect(r.satellite).toBe(r.host)
  })

  it('anonymous sees only public orders\' refunds, through either table', async () => {
    const r = await sameAsHost(ANON)
    expect(r.host).toBeGreaterThan(0)
    expect(r.host).toBeLessThan(12)
  })

  it('a client that sets the echo guard by hand is still held to the host\'s update policy', async () => {
    // B's public refunded order: A may see it, not change it.
    const [{ id }] = await as<{ id: string }>(
      PLAT,
      SERVICE,
      `SELECT id::text AS id FROM ${t('orders')} WHERE user_id = '${B}' AND public AND refund_amount IS NOT NULL ORDER BY id LIMIT 1`,
    )
    const forged = `SELECT set_config('${N.guc}', '1', true)`
    for (const write of [
      `UPDATE ${t('order_refunds')} SET refund_amount = 999 WHERE order_id = '${id}'`,
      `DELETE FROM ${t('order_refunds')} WHERE order_id = '${id}'`,
    ]) {
      await expect(as(WEB, AS_A, [forged, write])).rejects.toThrow(/permission denied: this change to order_refunds changes orders row/)
      await expect(as(PLAT, AS_A, [forged, write])).rejects.toThrow(/permission denied: this change to order_refunds changes orders row/)
    }
    const [host] = await as<{ a: string }>(PLAT, SERVICE, `SELECT refund_amount::text AS a FROM ${t('orders')} WHERE id = '${id}'`)
    const [sat] = await as<{ a: string }>(PLAT, SERVICE, `SELECT refund_amount::text AS a FROM ${t('order_refunds')} WHERE order_id = '${id}'`, { ladder: true })
    expect(sat.a).toBe(host.a)
    expect(host.a).not.toBe('999')
  })

  it('an end user\'s own write through the new table reaches the host', async () => {
    const [{ id }] = await as<{ id: string }>(PLAT, AS_A, `SELECT order_id::text AS id FROM ${t('order_refunds')} o JOIN ${t('orders')} h ON h.id = o.order_id WHERE h.user_id = '${A}' ORDER BY 1 LIMIT 1`)
    await as(WEB, AS_A, `UPDATE ${t('order_refunds')} SET refund_amount = 7 WHERE order_id = '${id}'`)
    const [host] = await as<{ a: string }>(PLAT, SERVICE, `SELECT refund_amount::text AS a FROM ${t('orders')} WHERE id = '${id}'`)
    expect(host.a).toBe('7')
  })
})
