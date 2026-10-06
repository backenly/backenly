/**
 * THE AUTHORIZATION REHEARSAL AGAINST A REAL ENGINE — who may read and write order_refunds
 * ======================================================================================
 *
 * Reconciliation proves the two representations hold the same values. These
 * tests pin the other half of the promise: on the rehearsal's copy, the new
 * table gives every identity exactly the access its parent gives, no more and
 * no less, and a copy that does not is reported as failed.
 *
 * The main fixture is a table built the way the product builds them: row-level
 * security forced, the service-role clause in every policy, per-user rows, and
 * two kinds of shared order that let a check tell "may see" apart from "may
 * change":
 *
 *   own        every caller reads and writes its own orders
 *   public     readable by anyone signed in, writable only by its owner
 *   listed     readable by anyone at all, anonymous included, writable only by
 *              its owner. No listed order carries a refund, so an anonymous
 *              caller sees no refund through either table but still has rows
 *              to try writing one onto.
 *
 * Two roles reach it: one that may read and write it, as an application's own
 * role does, and one that may only read it. Keys are fixed (`…000000000017` is
 * order 17) so that the first rows the rehearsal tries for each subject include
 * one it owns and one it may only look at. Order i belongs to user i % 3,
 * carries a refund when i is even, is public when i % 10 is 0 or 5, and listed
 * when i % 10 is 7.
 *
 *   passes        every identity — anonymous, three signed-in subjects drawn
 *                 from user_id, the service-role claim, for each role — gets
 *                 the same answer from both tables, and access leaves
 *                 `notRehearsed`
 *   anonymous     sees no refund through either table, and an insert through
 *                 the new table is refused exactly as the update of the parent
 *   see ≠ change  a subject that may see someone else's public order is refused
 *                 a write to its refund, because the parent's update policy
 *                 still decides
 *   too wide      a planted SELECT policy is caught by the read and
 *                 hidden-parent checks, and by the catalog
 *   too narrow    a planted RESTRICTIVE update policy is caught too: narrower
 *                 than the parent breaks old-versus-new equivalence as surely
 *                 as wider does
 *   unsynced      with the reverse sync dropped, writes the new table accepts
 *                 never reach the parent and skip its update policy: caught
 *   unseen        a DELETE policy wider only on rows the caller cannot see is
 *                 invisible to probes (each names its row), so the catalog
 *                 check catches it: every permissive policy on the new table
 *                 must test exactly what its read policy tests
 *   other hosts   access by grant alone passes, and roles past the limit are
 *                 named as not rehearsed; a host whose policies ignore the
 *                 service-role claim passes too: the satellite gives a caller
 *                 holding the claim exactly what the host gives it (it used
 *                 not to — the regression test below says how)
 *   nothing to    a table with no row-level security and no grant to anyone
 *   compare       but its owner is `unavailable`, with the reason, and stays in
 *                 `notRehearsed`
 *   no trace      no scratch schema, no satellite, no trigger on any host, the
 *                 live rows and policies as they were, and every pooled
 *                 session back to the platform's own role and claims
 *
 * The local role is a SUPERUSER and PostgreSQL exempts superusers from RLS, so
 * the rehearsal is given NOSUPERUSER roles created for this run, holding the
 * grants product roles hold. Those are the roles it SETs ROLE to.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import {
  REHEARSAL_MAX_ROLES,
  rehearseExtraction,
  type AuthorizationCheck,
  type RehearsalOptions,
  type RehearsalReport,
} from '@/lib/structural-evolution/rehearse'
import { readTableFacts } from '@/lib/structural-evolution/facts'
import { fq, ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'

jest.setTimeout(120_000)

const RUN = randomBytes(4).toString('hex')
/** May read and write orders, as an application's own role does. */
const ROLE = `bkn_evo_auth_${RUN}`
/** May only read orders, as a read-only API role does. */
const READER = `bkn_evo_read_${RUN}`
/** Read-only roles on tickets, more than the rehearsal acts as. Named to sort after ROLE. */
const EXTRA = [1, 2, 3, 4].map(n => `bkn_evo_xtra${n}_${RUN}`)
const USERS = [randomUUID(), randomUUID(), randomUUID()]
const ORDERS = 90

const SPEC: ExtractionSpec = {
  host: 'orders',
  members: ['refund_amount', 'refund_reason', 'refunded_at'],
  satellite: 'order_refunds',
  label: 'refund',
}

/** No row-level security; access is by table grant alone. */
const GRANTED: ExtractionSpec = {
  host: 'tickets',
  members: ['closed_at', 'closed_reason'],
  satellite: 'ticket_closures',
  label: 'closure',
}

/** Per-user policies that never mention the service-role claim. */
const UNCLAIMED: ExtractionSpec = {
  host: 'bookings',
  members: ['cancel_reason', 'cancelled_at'],
  satellite: 'booking_cancellations',
  label: 'cancellation',
}

/** No row-level security and no grant to anyone but its owner. */
const PLAIN: ExtractionSpec = {
  host: 'invoices',
  members: ['void_reason', 'voided_at'],
  satellite: 'invoice_voids',
  label: 'void',
}

const identitiesOf = (role: string) => ({
  anonymous: `${role} as anonymous`,
  subjects: [1, 2, 3].map(n => `${role} as subject ${n} (a user_id value)`),
  service: `${role} claiming the service role`,
})
const W = identitiesOf(ROLE)
const R = identitiesOf(READER)

let ownerId = ''
let projectId = ''
let schema = ''

const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)
const rows = <T = any>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p)
const t = (name: string) => `"${schema}"."${name}"`

/** Read as the platform (service claim), which every workspace table requires. */
async function asService<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T[]>(sql, ...p)
  })
}

async function rehearse(spec: ExtractionSpec, options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const resolved = await resolveExtractionPlan(projectId, spec)
  if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
  return rehearseExtraction(resolved.facts, spec, resolved.plan.planId, options)
}

/** One identity's checks, by check name. */
function checksOf(r: RehearsalReport, identity: string): Record<string, AuthorizationCheck> {
  return Object.fromEntries(r.authorization.checks.filter(c => c.identity === identity).map(c => [c.check, c]))
}

const failures = (r: RehearsalReport) => r.authorization.checks.filter(c => c.outcome === 'failed')
const distinct = <T>(xs: T[]) => [...new Set(xs)]

const WRITE_CHECKS = ['update_through_satellite', 'insert_through_satellite', 'delete_through_satellite']
const ACCESS_LINE = /^who may read and write /
const KEY = '[0-9a-f-]{36}'

/** What a pooled session looks like when nobody has changed it. */
const sessionState = async () =>
  (
    await rows<{ u: string; s: string; role: string; claims: string | null; svc: string | null; path: string; timeout: string }>(
      `SELECT current_user::text AS u, session_user::text AS s, current_setting('role') AS role,
              nullif(current_setting('request.jwt.claims', true), '') AS claims,
              nullif(current_setting('app.is_service_role', true), '') AS svc,
              current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout`,
    )
  )[0]

const liveSnapshot = () =>
  asService<{ id: string; v: string }>(
    `SELECT id::text AS id, ROW(user_id, total, status, refund_amount, refund_reason, refunded_at)::text AS v
       FROM ${t('orders')} ORDER BY id`,
  )

const livePolicies = () =>
  rows<{ name: string; qual: string | null; chk: string | null }>(
    `SELECT polname::text AS name, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS chk
       FROM pg_policy WHERE polrelid = to_regclass($1) ORDER BY polname`,
    t('orders'),
  )

let sessionBefore: Awaited<ReturnType<typeof sessionState>>
let ordersBefore: Array<{ id: string; v: string }> = []
let policiesBefore: Array<{ name: string; qual: string | null; chk: string | null }> = []

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `evo-auth-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo-auth' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-authorization-it', userId: ownerId } })).id
  schema = await resolveWorkspaceSchema(projectId)

  await q(`CREATE SCHEMA "${schema}"`)
  await q(jwtClaimFunctionSql(schema))
  for (const role of [ROLE, READER, ...EXTRA]) await q(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER`)
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO "${ROLE}", "${READER}"`)
  const svc = `"${schema}"."backenly_jwt_claim"('role') = 'service_role'`
  const sub = `"${schema}"."backenly_jwt_claim"('sub')`

  // ── orders: the product's shape ──────────────────────────────────────────
  await q(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    status text NOT NULL DEFAULT 'placed',
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text,
    refunded_at timestamptz
  )`)
  await q(
    `INSERT INTO ${t('orders')} (id, user_id, total, status, refund_amount, refund_reason, refunded_at)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            (ARRAY[$1::uuid, $2::uuid, $3::uuid])[(i % 3) + 1],
            (i % 90) + 10,
            CASE WHEN i % 10 IN (0, 5) THEN 'public' WHEN i % 10 = 7 THEN 'listed' ELSE 'placed' END,
            CASE WHEN i % 2 = 0 THEN (i % 40) + 1 END,
            CASE WHEN i % 2 = 0 THEN 'damaged ' || i END,
            CASE WHEN i % 2 = 0 THEN timestamptz '2026-01-01' + (i || ' hours')::interval END
       FROM generate_series(1, ${ORDERS}) i`,
    USERS[0],
    USERS[1],
    USERS[2],
  )
  await q(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await q(
    `CREATE POLICY orders_select ON ${t('orders')} FOR SELECT USING (${svc} OR user_id::text = ${sub}
       OR status = 'listed' OR (status = 'public' AND ${sub} IS NOT NULL))`,
  )
  await q(`CREATE POLICY orders_insert ON ${t('orders')} FOR INSERT WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_update ON ${t('orders')} FOR UPDATE USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_delete ON ${t('orders')} FOR DELETE USING (${svc} OR user_id::text = ${sub})`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t('orders')} TO "${ROLE}"`)
  await q(`GRANT SELECT ON ${t('orders')} TO "${READER}"`)

  // ── tickets: no row-level security; whoever holds the grant sees every row
  await q(`CREATE TABLE ${t('tickets')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text NOT NULL,
    closed_reason text,
    closed_at timestamptz
  )`)
  await q(
    `INSERT INTO ${t('tickets')} (title, closed_reason, closed_at)
     SELECT 'ticket ' || i, CASE WHEN i % 3 = 0 THEN 'fixed ' || i END,
            CASE WHEN i % 3 = 0 THEN timestamptz '2026-04-01' + (i || ' hours')::interval END
       FROM generate_series(1, 30) i`,
  )
  await q(`GRANT SELECT, UPDATE ON ${t('tickets')} TO "${ROLE}"`)
  await q(`GRANT SELECT ON ${t('tickets')} TO ${EXTRA.map(r => `"${r}"`).join(', ')}`)

  // ── bookings: the orders shape, but no policy honours the service-role claim
  await q(`CREATE TABLE ${t('bookings')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'placed',
    cancel_reason text,
    cancelled_at timestamptz
  )`)
  await q(
    `INSERT INTO ${t('bookings')} (user_id, status, cancel_reason, cancelled_at)
     SELECT (ARRAY[$1::uuid, $2::uuid, $3::uuid])[(i % 3) + 1],
            CASE WHEN i % 10 IN (0, 5) THEN 'public' ELSE 'placed' END,
            CASE WHEN i % 2 = 0 THEN 'weather ' || i END,
            CASE WHEN i % 2 = 0 THEN timestamptz '2026-03-01' + (i || ' hours')::interval END
       FROM generate_series(1, 60) i`,
    USERS[0],
    USERS[1],
    USERS[2],
  )
  await q(`ALTER TABLE ${t('bookings')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('bookings')} FORCE ROW LEVEL SECURITY`)
  await q(`CREATE POLICY bookings_select ON ${t('bookings')} FOR SELECT USING (user_id::text = ${sub} OR (status = 'public' AND ${sub} IS NOT NULL))`)
  await q(`CREATE POLICY bookings_insert ON ${t('bookings')} FOR INSERT WITH CHECK (user_id::text = ${sub})`)
  await q(`CREATE POLICY bookings_update ON ${t('bookings')} FOR UPDATE USING (user_id::text = ${sub}) WITH CHECK (user_id::text = ${sub})`)
  await q(`CREATE POLICY bookings_delete ON ${t('bookings')} FOR DELETE USING (user_id::text = ${sub})`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t('bookings')} TO "${ROLE}"`)

  // ── invoices: no row-level security, no grant — only its owner reaches it
  await q(`CREATE TABLE ${t('invoices')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    void_reason text,
    voided_at timestamptz
  )`)
  await q(
    `INSERT INTO ${t('invoices')} (user_id, total, void_reason, voided_at)
     SELECT $1::uuid, i, CASE WHEN i % 4 = 0 THEN 'duplicate' END,
            CASE WHEN i % 4 = 0 THEN timestamptz '2026-02-01' + (i || ' hours')::interval END
       FROM generate_series(1, 40) i`,
    USERS[0],
  )

  sessionBefore = await sessionState()
  ordersBefore = await liveSnapshot()
  policiesBefore = await livePolicies()
}, 60_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const role of [ROLE, READER, ...EXTRA]) {
    await q(`DROP OWNED BY "${role}"`).catch(() => {})
    await q(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

// ── The access the rendered SQL gives, compared identity by identity ────────

describe('the access rungs as rendered', () => {
  let r: RehearsalReport

  beforeAll(async () => {
    r = await rehearse(SPEC)
  })

  it('pass for every identity, and access is no longer listed as not rehearsed', () => {
    expect(r.error).toBeNull()
    expect(r.exercises.filter(e => e.outcome === 'failed')).toEqual([])
    expect(failures(r)).toEqual([])
    expect(r.authorization.status).toBe('passed')
    expect(r.passed).toBe(true)

    // Each role, times anonymous, three subjects and the service-role claim.
    expect(r.authorization.identities).toBeGreaterThanOrEqual(3)
    expect(r.authorization.identities).toBe(10)
    // Then the catalog, once, for every role.
    expect(distinct(r.authorization.checks.map(c => c.identity))).toEqual([
      W.anonymous, ...W.subjects, W.service,
      R.anonymous, ...R.subjects, R.service,
      'every role',
    ])
    expect(checksOf(r, 'every role').policies_follow_parent.outcome).toBe('passed')
    expect(r.authorization.detail).toMatch(/^order_refunds gave the same answer as orders in all \d+ check\(s\) across 10 identities/)
    expect(r.authorization.detail).toMatch(/3 signed-in subject\(s\) drawn from user_id/)

    // Every signed-in subject of the writing role owns some orders and may
    // only look at others, so each check has something on both sides.
    for (const subject of W.subjects) {
      const c = checksOf(r, subject)
      for (const name of ['read', 'hidden_parent', ...WRITE_CHECKS]) {
        expect([subject, name, c[name]?.outcome]).toEqual([subject, name, 'passed'])
      }
      expect(c.read.detail).toMatch(/the same rows with the same values through orders and through order_refunds/)
      expect(c.hidden_parent.detail).toMatch(/belong to orders rows this identity cannot see, and none of them is visible to it/)
      for (const name of WRITE_CHECKS) {
        expect(c[name].detail).toMatch(new RegExp(`^may change orders row ${KEY}: an? [A-Z]+ through order_refunds was allowed, and the write reached orders`))
        expect(c[name].detail).toMatch(new RegExp(`may not change orders row ${KEY}: an? [A-Z]+ through order_refunds was refused too`))
      }
    }

    // The service-role claim sees and may change every row, through both.
    const s = checksOf(r, W.service)
    expect(s.read.outcome).toBe('passed')
    expect(s.read.detail).toMatch(/^sees (\d+) of the \1 row\(s\)/)
    expect(s.hidden_parent.outcome).toBe('not_exercised')
    for (const name of WRITE_CHECKS) {
      expect(s[name].outcome).toBe('passed')
      expect(s[name].detail).toMatch(/every row tried could be changed through orders/)
    }

    // The reading role sees what the writing role sees, and may change
    // nothing through either table: the new table was granted no write to it.
    for (const [reader, writer] of [...R.subjects.map((x, i) => [x, W.subjects[i]]), [R.service, W.service]]) {
      const c = checksOf(r, reader)
      expect(c.read).toEqual({ ...checksOf(r, writer).read, identity: reader })
      for (const name of WRITE_CHECKS) {
        expect([reader, name, c[name].outcome]).toEqual([reader, name, 'passed'])
        expect(c[name].detail).not.toMatch(/may change orders row/)
        expect(c[name].detail).toMatch(/refused too \(permission denied for table order_refunds; undone whole\)/)
        expect(c[name].detail).toMatch(/none of the \d+ row\(s\) tried could be changed through orders/)
      }
    }

    expect(r.notRehearsed.filter(l => ACCESS_LINE.test(l))).toEqual([])
    expect(r.notRehearsed.join('\n')).not.toMatch(/cannot SET ROLE|only the first \d+ roles/)
  })

  it('an anonymous caller sees no refund through either table, and is refused a write through both', () => {
    for (const anonymous of [W.anonymous, R.anonymous]) {
      const a = checksOf(r, anonymous)
      expect(a.read.outcome).toBe('passed')
      expect(a.read.detail).toMatch(/^sees 0 of the \d+ row\(s\) carrying refund data/)
      // Every refund belongs to an order hidden from it, and none leaks.
      expect(a.hidden_parent.outcome).toBe('passed')
      expect(a.hidden_parent.detail).toMatch(/^(\d+) row\(s\) of order_refunds belong to orders rows this identity cannot see, and none of them is visible to it$/)

      // It may look at listed orders but change none of them, directly or by
      // inserting a refund for one.
      expect(a.insert_through_satellite.outcome).toBe('passed')
      expect(a.insert_through_satellite.detail).not.toMatch(/may change orders row/)
      expect(a.insert_through_satellite.detail).toMatch(new RegExp(`may not change orders row ${KEY}: an INSERT through order_refunds was refused too`))
      expect(a.insert_through_satellite.detail).toMatch(/none of the \d+ row\(s\) tried could be changed through orders/)

      // With no refund visible to it there is no refund row to update or
      // delete through either table. Said, and not counted as passed.
      for (const name of ['update_through_satellite', 'delete_through_satellite']) {
        expect(a[name].outcome).toBe('not_exercised')
        expect(a[name].detail).toBe('no row of order_refunds is visible to this identity')
      }
    }
    // The writing role holds the grant, so its insert reached the reverse
    // sync, which tried the parent as the caller and was refused there.
    expect(checksOf(r, W.anonymous).insert_through_satellite.detail).toMatch(
      new RegExp(
        `refused too \\(permission denied: this change to order_refunds changes orders row ${KEY}, which the caller may not update; undone whole\\)`,
      ),
    )
  })

  it("refuses a subject the refund of a public order it may see but not update — the parent's update policy still decides", async () => {
    const orders = new Map(
      (await asService<{ id: string; user_id: string; status: string }>(`SELECT id::text AS id, user_id::text AS user_id, status FROM ${t('orders')}`)).map(o => [
        o.id,
        o,
      ]),
    )
    for (const subject of W.subjects) {
      const c = checksOf(r, subject)
      const detail = c.update_through_satellite.detail
      const mine = new RegExp(`^may change orders row (${KEY}):`).exec(detail)![1]
      const theirs = new RegExp(`may not change orders row (${KEY}): an UPDATE through order_refunds was refused too \\((.*)\\)`).exec(detail)!
      expect([subject, c.update_through_satellite.outcome]).toEqual([subject, 'passed'])

      // A public order belonging to somebody else, which this subject reads.
      const parent = orders.get(theirs[1])!
      expect(parent.status).toBe('public')
      expect(parent.user_id).not.toBe(orders.get(mine)!.user_id)
      expect(c.read.outcome).toBe('passed')

      // The new table let the write in, the reverse sync tried it on the
      // parent as the caller, the parent's update policy said no, and the
      // whole statement was undone.
      expect(theirs[2]).toBe(
        `permission denied: this change to order_refunds changes orders row ${theirs[1]}, which the caller may not update; undone whole`,
      )
      // The same for removing it.
      expect(c.delete_through_satellite.detail).toMatch(
        new RegExp(`may not change orders row ${KEY}: a DELETE through order_refunds was refused too \\(permission denied: .*; undone whole\\)`),
      )
    }
  })
})

// ── Flaws planted on the copy must be caught ─────────────────────────────────

describe('a satellite whose access differs from its parent', () => {
  it('is caught when it is wider: a permissive read policy leaks refunds of hidden orders', async () => {
    const r = await rehearse(SPEC, {
      extraSatelliteSqlForTest: scratch => [`CREATE POLICY leak ON ${fq(scratch.schema, 'order_refunds')} FOR SELECT USING (true)`],
    })
    expect(r.error).toBeNull()
    expect(r.authorization.status).toBe('failed')
    expect(r.passed).toBe(false)
    // The data exercises still reconcile: this is an access failure alone.
    expect(r.exercises.filter(e => e.outcome === 'failed')).toEqual([])

    const failed = failures(r)
    expect(distinct(failed.map(c => c.check)).sort()).toEqual(['hidden_parent', 'policies_follow_parent', 'read'])
    // Everyone but the service-role claim, which may see every row anyway;
    // and the catalog, which names the policy.
    const exposed = [W.anonymous, ...W.subjects, R.anonymous, ...R.subjects]
    expect(distinct(failed.map(c => c.identity))).toEqual([...exposed, 'every role'])
    expect(checksOf(r, 'every role').policies_follow_parent.detail).toBe(
      'leak admits rows of order_refunds by another test than whether their orders row is visible',
    )
    for (const identity of exposed) {
      const c = checksOf(r, identity)
      expect(c.read.detail).toMatch(/^order_refunds shows \d+ row\(s\) this identity cannot see in orders/)
      expect(c.hidden_parent.detail).toMatch(/row\(s\) of order_refunds whose orders row is hidden from this identity ARE visible to it/)
    }
    expect(r.authorization.detail).toMatch(/access check\(s\) disagree between orders and order_refunds/)
    expect(r.authorization.detail).toContain(`First: ${W.anonymous}, read: order_refunds shows`)
    // A failed comparison is a finding, not a gap: access is not "not rehearsed".
    expect(r.notRehearsed.filter(l => ACCESS_LINE.test(l))).toEqual([])
  })

  it('is caught when it is narrower: a restrictive update policy refuses what the parent allows', async () => {
    const r = await rehearse(SPEC, {
      extraSatelliteSqlForTest: scratch => [
        `CREATE POLICY narrow ON ${fq(scratch.schema, 'order_refunds')} AS RESTRICTIVE FOR UPDATE USING (false)`,
      ],
    })
    expect(r.error).toBeNull()
    expect(r.authorization.status).toBe('failed')
    expect(r.passed).toBe(false)

    const failed = failures(r)
    expect(distinct(failed.map(c => c.check))).toEqual(['update_through_satellite'])
    // Every identity that may update some order is refused it through the new
    // table. Anonymous callers and the reading role may update none, so they
    // have nothing to disagree on.
    expect(distinct(failed.map(c => c.identity))).toEqual([...W.subjects, W.service])
    for (const c of failed) {
      expect(c.detail).toMatch(
        new RegExp(
          `may change orders row ${KEY}, but an UPDATE through order_refunds was REFUSED \\(narrower than the parent\\): ` +
            'no row was changed: the row rules filtered it out',
        ),
      )
    }
    // Reads, inserts and deletes are untouched by an UPDATE policy.
    for (const subject of W.subjects) {
      const c = checksOf(r, subject)
      for (const name of ['read', 'hidden_parent', 'insert_through_satellite', 'delete_through_satellite']) {
        expect([subject, name, c[name].outcome]).toEqual([subject, name, 'passed'])
      }
    }
    expect(r.authorization.detail).toMatch(/First: .*, update_through_satellite: .*REFUSED \(narrower than the parent\)/)
  })

  it('is caught when its writes stop reaching the parent: the reverse sync removed', async () => {
    const r = await rehearse(SPEC, {
      extraSatelliteSqlForTest: scratch => [`DROP TRIGGER ${ladderNames(SPEC).reverse} ON ${fq(scratch.schema, 'order_refunds')}`],
    })
    expect(r.error).toBeNull()
    expect(r.authorization.status).toBe('failed')
    expect(r.passed).toBe(false)

    // Reads are untouched; every write the new table accepts is now wrong.
    const failed = failures(r)
    expect(distinct(failed.map(c => c.check)).sort()).toEqual(WRITE_CHECKS.slice().sort())
    for (const subject of W.subjects) {
      const c = checksOf(r, subject)
      expect(c.read.outcome).toBe('passed')
      // Its own order: accepted, and never reached orders.
      expect(c.update_through_satellite.detail).toMatch(
        new RegExp(`an UPDATE through order_refunds was allowed, but orders row ${KEY} does not hold what was written`),
      )
      // Somebody else's public order: nothing asked the parent's update policy.
      expect(c.update_through_satellite.detail).toMatch(
        new RegExp(`may NOT change orders row ${KEY} \\(no row was changed: the row rules filtered it out\\), but an UPDATE through order_refunds was ALLOWED \\(wider than the parent\\)`),
      )
    }
    // The reading role holds no write grant on the new table, so it still
    // agrees: the grant, not the trigger, refuses it.
    for (const identity of [R.anonymous, ...R.subjects, R.service]) {
      expect(Object.values(checksOf(r, identity)).filter(x => x.outcome === 'failed')).toEqual([])
    }
  })

  /*
   * What no probe can see, and the catalog can.
   *
   * Every write probe names its row (`… WHERE order_id = $1`). Naming a column
   * makes PostgreSQL apply the table's SELECT policies to an UPDATE or DELETE
   * as well as its write policies, so a probe can only ever reach rows the
   * identity can see. A write policy that is wider only on HIDDEN rows is
   * therefore invisible to probes — yet `DELETE FROM order_refunds` with no
   * WHERE reads no column, is filtered by the DELETE policies alone, and would
   * remove refunds of orders the caller cannot see. The rehearsal's catalog
   * check refuses any permissive policy whose test is not the read policy's.
   */
  it('is caught when a delete policy is wider only on rows the caller cannot see', async () => {
    const r = await rehearse(SPEC, {
      extraSatelliteSqlForTest: scratch => [`CREATE POLICY sweep ON ${fq(scratch.schema, 'order_refunds')} FOR DELETE USING (true)`],
    })
    expect(r.error).toBeNull()
    expect(r.authorization.status).toBe('failed')
    expect(r.passed).toBe(false)
    // Only the catalog sees it; every probe still agrees.
    expect(failures(r).map(c => [c.identity, c.check])).toEqual([['every role', 'policies_follow_parent']])
    expect(r.authorization.detail).toContain(
      'First: every role, policies_follow_parent: sweep admits rows of order_refunds by another test than whether their orders row is visible.',
    )
  })

  it('leaves a restrictive policy to the probes: it can only narrow', async () => {
    const r = await rehearse(SPEC, {
      extraSatelliteSqlForTest: scratch => [
        `CREATE POLICY narrow_delete ON ${fq(scratch.schema, 'order_refunds')} AS RESTRICTIVE FOR DELETE USING (true)`,
      ],
    })
    expect(r.error).toBeNull()
    expect(checksOf(r, 'every role').policies_follow_parent.outcome).toBe('passed')
    expect(r.authorization.status).toBe('passed')
  })
})

// ── Hosts with other shapes of access ────────────────────────────────────────

describe('a host whose access is by grant alone', () => {
  it('passes, and names the roles past the limit as not rehearsed instead of skipping them quietly', async () => {
    const r = await rehearse(GRANTED)
    expect(r.error).toBeNull()
    expect(failures(r)).toEqual([])
    expect(r.authorization.status).toBe('passed')
    expect(r.passed).toBe(true)

    // Five roles may read tickets; the rehearsal acts as the first four. No
    // policy reads a column, so there is no subject to sign in as: anonymous
    // and the service-role claim only.
    const acted = [ROLE, ...EXTRA.slice(0, REHEARSAL_MAX_ROLES - 1)]
    const skipped = EXTRA.slice(REHEARSAL_MAX_ROLES - 1)
    expect(r.authorization.identities).toBe(acted.length * 2)
    expect(distinct(r.authorization.checks.map(c => c.identity))).toEqual([
      ...acted.flatMap(role => [`${role} as anonymous`, `${role} claiming the service role`]),
      'every role',
    ])
    expect(r.authorization.detail).toMatch(/0 signed-in subject\(s\), and the service-role claim/)
    expect(r.authorization.detail).toMatch(new RegExp(`Not rehearsed as: ${skipped.join(', ')}\\.$`))
    expect(r.notRehearsed).toContain(`access as ${skipped.join(', ')} — only the first ${REHEARSAL_MAX_ROLES} roles are rehearsed as`)
    expect(r.notRehearsed.filter(l => ACCESS_LINE.test(l))).toEqual([])

    // Without row-level security, whoever holds UPDATE changes every row, and
    // does so through the new table too; a role holding only SELECT changes
    // none through either.
    for (const identity of [`${ROLE} as anonymous`, `${ROLE} claiming the service role`]) {
      const c = checksOf(r, identity)
      expect(c.read.detail).toMatch(/^sees (\d+) of the \1 row\(s\)/)
      for (const name of WRITE_CHECKS) {
        expect(c[name].outcome).toBe('passed')
        expect(c[name].detail).toMatch(/was allowed, and the write reached tickets; every row tried could be changed through tickets$/)
      }
    }
    const reader = checksOf(r, `${EXTRA[0]} as anonymous`)
    for (const name of WRITE_CHECKS) {
      expect(reader[name].outcome).toBe('passed')
      expect(reader[name].detail).toMatch(/refused too \(permission denied for table ticket_closures; undone whole\)/)
    }
  })
})

describe('a host whose policies ignore the service-role claim', () => {
  /*
   * The access flaw this suite found in the SQL sql.ts used to render, and
   * the regression test for its fix.
   *
   * The satellite used to honour the service-role claim on its own: a
   * `FOR ALL USING (<claim> = 'service_role')` policy, and `followsParent`
   * starting with `<claim> = 'service_role' OR …`. Any role that can run SQL can
   * set that claim. Against a host whose own policies do not honour it, a
   * caller holding it could read every satellite row the host hid from it, and
   * delete satellite rows of hidden parents — and the delete committed without
   * reaching the parent, because the reverse sync took "the caller cannot see
   * the parent" for "the parent is gone".
   *
   * Now the satellite's client-facing policies are the parent's visibility and
   * nothing else, its one unconditional policy is for the role that creates it
   * (the platform, which the forward sync runs as), and the reverse sync
   * accepts a cascade only when the parent's own row trigger counted it in the
   * same statement. So a caller holding the claim gets exactly what the host
   * gives it — here, nothing beyond its own bookings.
   */

  it('gives a caller holding the claim exactly what the host gives it', async () => {
    const r = await rehearse(UNCLAIMED)
    expect(r.error).toBeNull()
    expect(r.exercises.filter(e => e.outcome === 'failed')).toEqual([])
    expect(failures(r)).toEqual([])
    expect(r.authorization.status).toBe('passed')
    expect(r.passed).toBe(true)

    const { service } = identitiesOf(ROLE)
    const c = checksOf(r, service)
    // The host shows a claim-holder none of these bookings, and so does the satellite.
    expect(c.read.outcome).toBe('passed')
    expect(c.read.detail).toMatch(/^sees 0 of the \d+ row\(s\)/)
    expect(c.hidden_parent.outcome).toBe('passed')
    // A delete of a hidden parent's row is refused whole, not committed past the parent.
    expect(c.delete_through_satellite.outcome).not.toBe('failed')
  })
})

// ── Nothing to compare ───────────────────────────────────────────────────────

describe('a host with no access rules of its own', () => {
  it('is unavailable with the reason, never passed, and access stays listed as not rehearsed', async () => {
    const facts = (await readTableFacts(schema, 'invoices'))!
    // The precondition, checked rather than assumed.
    expect(facts.rowSecurity).toBe(false)
    expect(facts.grants.filter(g => g.grantee !== facts.owner)).toEqual([])

    const r = await rehearse(PLAIN)
    expect(r.error).toBeNull()
    expect(r.authorization).toEqual({
      status: 'unavailable',
      detail: 'invoices has no row-level security and no role other than its owner holds a privilege on it; there is no access to compare',
      identities: 0,
      checks: [],
    })
    expect(r.notRehearsed.filter(l => ACCESS_LINE.test(l))).toEqual([
      'who may read and write invoice_voids, compared with invoices role by role — ' +
        'invoices has no row-level security and no role other than its owner holds a privilege on it; there is no access to compare; ' +
        'the access rungs are checked against the live catalog after they run',
    ])
    // The data exercises still ran and reconciled; "unavailable" is not a
    // failure, and it is never dressed up as a passed access check.
    expect(r.exercises.filter(e => e.outcome === 'failed')).toEqual([])
    expect(r.exercises.some(e => e.outcome === 'passed')).toBe(true)
    expect(r.passed).toBe(true)
  })
})

// ── No trace ─────────────────────────────────────────────────────────────────

describe('after every rehearsal above', () => {
  it('leaves nothing behind, and every session is the platform again', async () => {
    expect(await rows(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'bkn\\_rehearsal\\_%'`)).toEqual([])
    for (const spec of [SPEC, GRANTED, UNCLAIMED, PLAIN]) {
      expect([spec.satellite, await readTableFacts(schema, spec.satellite)]).toEqual([spec.satellite, null])
      expect([spec.host, (await readTableFacts(schema, spec.host))!.triggers]).toEqual([spec.host, []])
    }
    // No function the ladder renders survived either.
    expect(
      await rows(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname LIKE 'bkn\\_evo\\_%'`,
        schema,
      ),
    ).toEqual([])

    // The live table was only read: same rows, same policies, same grants.
    expect(await liveSnapshot()).toEqual(ordersBefore)
    expect(await livePolicies()).toEqual(policiesBefore)
    const live = (await readTableFacts(schema, 'orders'))!
    expect(live.grants.filter(g => g.grantee === ROLE).map(g => g.privilege).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    expect(live.grants.filter(g => g.grantee === READER).map(g => g.privilege)).toEqual(['SELECT'])
    expect(live.forceRowSecurity).toBe(true)

    // Every pooled session is back to the platform's own role, with no claims
    // and the timeouts and search path it had before. Many at once, so the
    // connections the rehearsals used are among them.
    const sessions = await Promise.all(Array.from({ length: 12 }, () => sessionState()))
    for (const s of sessions) expect(s).toEqual(sessionBefore)
    expect(sessionBefore.u).toBe(sessionBefore.s)
    expect(sessionBefore.role).toBe('none')
    expect(sessionBefore.claims).toBeNull()

    // And the platform can still do its ordinary work.
    expect(Number((await asService<{ n: number }>(`SELECT count(*)::int AS n FROM ${t('orders')}`))[0].n)).toBe(ORDERS)
  })
})
