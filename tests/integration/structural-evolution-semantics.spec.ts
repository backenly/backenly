/**
 * WHAT THE DUAL REPRESENTATION MUST PRESERVE — database semantics, as owned in production
 * ======================================================================================
 *
 * Each block is a way the two representations, or the behaviour old clients
 * see, could differ from what PostgreSQL alone would have done. Every block
 * runs with the workspace owned by a NOSUPERUSER NOBYPASSRLS platform role (see
 * tests/helpers/evolution-owned-workspace.ts): a superuser would pass all of
 * them by being exempt from row-level security.
 *
 *   triggers      the satellite converges to what the host COMMITTED, not to
 *                 what the statement named: BEFORE triggers that set members,
 *                 unrelated updates that change derived members, AFTER triggers
 *                 that write the row again, rollbacks, concurrent writers
 *   constraints   old clients get the host's exact constraint semantics during
 *                 the ladder: deferred foreign keys, NOT VALID constraints with
 *                 existing violators, deferrable uniques, referential actions
 *   hidden rows   rows the host hides from Backenly's own service view are
 *                 copied and reconciled through the ladder's own context; when a
 *                 restrictive policy makes that impossible, nothing reports
 *                 "consistent"
 *   truncate      TRUNCATE … CASCADE of the host empties both, as Backenly's own
 *                 truncate action runs it; the satellite alone cannot be emptied
 *   types         a member whose type has no equality operator (json) works on
 *                 every path, including the trigger that decides when to mirror
 *   forgery       a client that forges the sync's settings in the same statement
 *                 still cannot delete or move a satellite row without the host
 *   definer       the one function that runs as the owner cannot be fired on a
 *                 table of anyone else's, even by a role that may only read
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { reconcileWith } from '@/lib/structural-evolution/reconcile'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'
import { ANON, SERVICE, asUser, claimSql, ownedWorkspace, runLadder, type OwnedWorkspace } from '../helpers/evolution-owned-workspace'

jest.setTimeout(180_000)

const A = randomUUID()
const B = randomUUID()
const S = randomUUID()

const ALL_RUNGS = ['create', 'sync', 'backfill', 'expose', 'open'] as const

/** host vs satellite, read as the superuser running the suite: the ground truth, no row-level security. */
async function truth(w: OwnedWorkspace, spec: ExtractionSpec) {
  const fk = ladderNames(spec).fkColumn
  const m = spec.members.map(c => `"${c}"`).join(', ')
  const host = await prisma.$queryRawUnsafe<Array<{ k: string; v: string }>>(
    `SELECT id::text AS k, ROW(${m})::text AS v FROM ${w.t(spec.host)} WHERE ${spec.members.map(c => `"${c}" IS NOT NULL`).join(' OR ')} ORDER BY 1`,
  )
  const sat = await prisma.$queryRawUnsafe<Array<{ k: string; v: string }>>(
    `SELECT "${fk}"::text AS k, ROW(${m})::text AS v FROM ${w.t(spec.satellite)} ORDER BY 1`,
  )
  return { host, sat }
}

async function expectConverged(w: OwnedWorkspace, spec: ExtractionSpec) {
  const { host, sat } = await truth(w, spec)
  expect(sat).toEqual(host)
}

/** reconcile as production runs it: the platform, the service claim, the ladder's context. */
const reconcileAsPlatform = async (w: OwnedWorkspace, spec: ExtractionSpec) => {
  const facts = await w.facts()
  return w.within(w.platform, SERVICE, tx => reconcileWith(tx, facts, spec, { schema: w.schema }), { ladder: true })
}

// ── The host's own triggers decide the value ────────────────────────────────

describe('triggers: the satellite converges to what the host committed', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }
  let w: OwnedWorkspace
  const ids: string[] = []

  beforeAll(async () => {
    w = await ownedWorkspace('trg', SPEC, w => {
      const { svc, sub } = claimSql(w)
      return [
        `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
           status text NOT NULL DEFAULT 'placed', total numeric NOT NULL DEFAULT 10, refund_amount numeric, refund_reason text)`,
        `ALTER TABLE ${w.t('orders')} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${w.t('orders')} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY rw ON ${w.t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`,
        // The application's own rule: a refunded order is refunded in full.
        `CREATE FUNCTION ${w.t('derive_refund')}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.status = 'refunded' THEN
             NEW.refund_amount := NEW.total;
             NEW.refund_reason := COALESCE(NEW.refund_reason, 'auto: refunded');
           END IF;
           RETURN NEW;
         END $$`,
        `CREATE TRIGGER derive_refund BEFORE UPDATE ON ${w.t('orders')} FOR EACH ROW EXECUTE FUNCTION ${w.t('derive_refund')}()`,
        // And one that writes the row again after the fact.
        `CREATE FUNCTION ${w.t('escalate')}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.refund_reason = 'escalate' THEN
             UPDATE ${w.t('orders')} SET refund_reason = 'escalated', refund_amount = COALESCE(refund_amount, 0) + 1 WHERE id = NEW.id;
           END IF;
           RETURN NULL;
         END $$`,
        `CREATE TRIGGER escalate AFTER UPDATE ON ${w.t('orders')} FOR EACH ROW EXECUTE FUNCTION ${w.t('escalate')}()`,
        `INSERT INTO ${w.t('orders')} (user_id, total, refund_amount, refund_reason)
         SELECT '${A}'::uuid, i * 10, CASE WHEN i % 2 = 0 THEN i END, CASE WHEN i % 2 = 0 THEN 'r' || i END FROM generate_series(1, 8) i`,
        `GRANT SELECT, UPDATE ON ${w.t('orders')} TO "${w.client}"`,
      ]
    })
    await runLadder(w, SPEC, [...ALL_RUNGS])
    ids.push(...(await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM ${w.t('orders')} ORDER BY total`)).map(r => r.id))
    await expectConverged(w, SPEC)
  }, 120_000)
  afterAll(async () => w.drop())

  it('a BEFORE trigger sets members the UPDATE never named', async () => {
    await w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET status = 'refunded' WHERE id = '${ids[0]}'`)
    const [h] = await prisma.$queryRawUnsafe<any[]>(`SELECT refund_amount::text AS a, refund_reason AS r FROM ${w.t('orders')} WHERE id = '${ids[0]}'`)
    expect(h).toEqual({ a: '10', r: 'auto: refunded' })
    await expectConverged(w, SPEC)
  })

  it('an update of an unrelated column changes a derived member', async () => {
    await w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET total = 77 WHERE id = '${ids[0]}'`)
    const [h] = await prisma.$queryRawUnsafe<any[]>(`SELECT refund_amount::text AS a FROM ${w.t('orders')} WHERE id = '${ids[0]}'`)
    expect(h.a).toBe('77')
    await expectConverged(w, SPEC)
  })

  it('an AFTER trigger that writes the row again, reached through the new table', async () => {
    await w.as(w.client, asUser(A), `UPDATE ${w.t('order_refunds')} SET refund_reason = 'escalate' WHERE order_id = '${ids[1]}'`)
    const [h] = await prisma.$queryRawUnsafe<any[]>(`SELECT refund_reason AS r FROM ${w.t('orders')} WHERE id = '${ids[1]}'`)
    expect(h.r).toBe('escalated')
    await expectConverged(w, SPEC)
  })

  it('the same AFTER trigger reached through the host', async () => {
    await w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET refund_reason = 'escalate' WHERE id = '${ids[3]}'`)
    await expectConverged(w, SPEC)
  })

  it('a rolled-back transaction leaves both as they were', async () => {
    const before = await truth(w, SPEC)
    await expect(
      w.within(w.platform, asUser(A), async tx => {
        await tx.$executeRawUnsafe(`UPDATE ${w.t('orders')} SET status = 'refunded', total = 999 WHERE id = '${ids[2]}'`)
        throw new Error('the client gave up')
      }),
    ).rejects.toThrow('the client gave up')
    expect(await truth(w, SPEC)).toEqual(before)
  })

  it("a value written through the new table that the host's own rule overrides: both keep what the host kept", async () => {
    // ids[6] is refunded, so derive_refund pins its amount to the total.
    await w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET status = 'refunded' WHERE id = '${ids[6]}'`)
    await expectConverged(w, SPEC)
    await w.as(w.client, asUser(A), `UPDATE ${w.t('order_refunds')} SET refund_amount = 5 WHERE order_id = '${ids[6]}'`)
    const [h] = await prisma.$queryRawUnsafe<any[]>(`SELECT refund_amount::text AS a FROM ${w.t('orders')} WHERE id = '${ids[6]}'`)
    expect(h.a).toBe('70')
    await expectConverged(w, SPEC)
  })

  it("a refund deleted through the new table that the host's own rule keeps: it is still in both", async () => {
    await w.as(w.client, asUser(A), `DELETE FROM ${w.t('order_refunds')} WHERE order_id = '${ids[6]}'`)
    const [h] = await prisma.$queryRawUnsafe<any[]>(`SELECT refund_amount::text AS a FROM ${w.t('orders')} WHERE id = '${ids[6]}'`)
    expect(h.a).toBe('70')
    await expectConverged(w, SPEC)
  })

  it('concurrent writers through both tables end equal, whatever order commits', async () => {
    const targets = ids.slice(4, 8)
    const writes: Array<() => Promise<unknown>> = []
    for (let i = 0; i < 24; i++) {
      const id = targets[i % targets.length]
      if (i % 3 === 0) writes.push(() => w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET status = 'refunded', total = ${100 + i} WHERE id = '${id}'`))
      else if (i % 3 === 1) writes.push(() => w.as(w.client, asUser(A), `UPDATE ${w.t('order_refunds')} SET refund_amount = ${200 + i} WHERE order_id = '${id}'`))
      else writes.push(() => w.as(w.platform, asUser(A), `UPDATE ${w.t('orders')} SET refund_reason = 'w${i}' WHERE id = '${id}'`))
    }
    const results = await Promise.allSettled(writes.map(f => f()))
    // A crossing pair may deadlock; PostgreSQL then aborts one whole transaction.
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/deadlock|could not serialize|lock/)
    await expectConverged(w, SPEC)
  })
})

// ── Members whose type has no equality ──────────────────────────────────────

describe('types: a member with no equality operator', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_meta'], satellite: 'order_refunds', label: 'refund' }
  let w: OwnedWorkspace
  let id = ''

  beforeAll(async () => {
    w = await ownedWorkspace('typ', SPEC, w => [
      `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text, refund_amount numeric, refund_meta json)`,
      `INSERT INTO ${w.t('orders')} (note, refund_amount, refund_meta) VALUES ('a', 1, '{"by": "x"}'), ('b', NULL, NULL)`,
    ])
    await runLadder(w, SPEC, [...ALL_RUNGS])
    id = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE note = 'a'`))[0].id
  }, 120_000)
  afterAll(async () => w.drop())

  it('an old client updating an unrelated column still succeeds', async () => {
    await w.as(w.platform, SERVICE, `UPDATE ${w.t('orders')} SET note = 'a2'`)
    await expectConverged(w, SPEC)
  })

  it('a change to the json member alone is mirrored', async () => {
    await w.as(w.platform, SERVICE, `UPDATE ${w.t('orders')} SET refund_meta = '{"by": "y"}' WHERE id = '${id}'`)
    await expectConverged(w, SPEC)
    expect((await reconcileAsPlatform(w, SPEC)).consistent).toBe(true)
  })
})

// ── Constraints keep their exact meaning ────────────────────────────────────

describe('constraints: old clients keep the host\'s exact semantics during the ladder', () => {
  const SPEC: ExtractionSpec = {
    host: 'orders',
    members: ['refund_processor', 'refund_batch', 'refund_code', 'refund_ticket', 'refund_agent'],
    satellite: 'order_refunds',
    label: 'refund',
  }
  let w: OwnedWorkspace
  let violator = ''
  let codeViolator = ''

  beforeAll(async () => {
    w = await ownedWorkspace('con', SPEC, w => {
      const { svc, sub } = claimSql(w)
      return [
        `CREATE TABLE ${w.t('processors')} (id int PRIMARY KEY)`,
        `CREATE TABLE ${w.t('batches')} (id int PRIMARY KEY)`,
        `CREATE TABLE ${w.t('agents')} (id int PRIMARY KEY)`,
        `INSERT INTO ${w.t('processors')} VALUES (1), (2)`,
        `INSERT INTO ${w.t('batches')} VALUES (1)`,
        `INSERT INTO ${w.t('agents')} VALUES (1), (2)`,
        `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
           refund_processor int, refund_batch int, refund_code text, refund_ticket text, refund_agent int)`,
        `ALTER TABLE ${w.t('orders')} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${w.t('orders')} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY rw ON ${w.t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`,
        `INSERT INTO ${w.t('orders')} (user_id, refund_processor, refund_batch, refund_code, refund_ticket, refund_agent)
         SELECT '${A}'::uuid, 1, 1, 'ok' || i, 't' || i, 1 FROM generate_series(1, 6) i`,
        // Rows that already break a rule added later as NOT VALID.
        `INSERT INTO ${w.t('orders')} (user_id, refund_batch, refund_code) VALUES ('${A}', 404, 'ok-x'), ('${A}', NULL, 'bad')`,
        `ALTER TABLE ${w.t('orders')} ADD CONSTRAINT processor_fk FOREIGN KEY (refund_processor) REFERENCES ${w.t('processors')} (id) DEFERRABLE INITIALLY DEFERRED`,
        `ALTER TABLE ${w.t('orders')} ADD CONSTRAINT batch_fk FOREIGN KEY (refund_batch) REFERENCES ${w.t('batches')} (id) NOT VALID`,
        `ALTER TABLE ${w.t('orders')} ADD CONSTRAINT code_ok CHECK (refund_code <> 'bad') NOT VALID`,
        `ALTER TABLE ${w.t('orders')} ADD CONSTRAINT ticket_uq UNIQUE (refund_ticket) DEFERRABLE INITIALLY DEFERRED`,
        `ALTER TABLE ${w.t('orders')} ADD CONSTRAINT agent_fk FOREIGN KEY (refund_agent) REFERENCES ${w.t('agents')} (id) ON DELETE SET NULL`,
        `GRANT SELECT, UPDATE ON ${w.t('orders')} TO "${w.client}"`,
      ]
    })
    violator = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE refund_batch = 404`))[0].id
    codeViolator = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE refund_code = 'bad'`))[0].id
    await runLadder(w, SPEC, [...ALL_RUNGS])
  }, 120_000)
  afterAll(async () => w.drop())

  it('copies every row, including those a NOT VALID constraint was added over', async () => {
    await expectConverged(w, SPEC)
    expect((await truth(w, SPEC)).sat.length).toBe(8)
  })

  it('a deferred foreign key is still satisfied at commit, not at the statement', async () => {
    const [{ id }] = await w.as<{ id: string }>(w.platform, SERVICE, `SELECT id::text AS id FROM ${w.t('orders')} WHERE refund_code = 'ok1'`)
    await w.within(w.platform, SERVICE, async tx => {
      await tx.$executeRawUnsafe(`UPDATE ${w.t('orders')} SET refund_processor = 900 WHERE id = '${id}'`)
      await tx.$executeRawUnsafe(`INSERT INTO ${w.t('processors')} VALUES (900)`)
    })
    await expectConverged(w, SPEC)
  })

  it('a row a NOT VALID foreign key never checked can still be updated', async () => {
    await w.as(w.platform, SERVICE, `UPDATE ${w.t('orders')} SET refund_code = 'ok-y' WHERE id = '${violator}'`)
    await expectConverged(w, SPEC)
  })

  it('a deferrable unique can still be swapped within a transaction', async () => {
    const rows = await w.as<{ id: string }>(w.platform, SERVICE, `SELECT id::text AS id FROM ${w.t('orders')} WHERE refund_ticket IN ('t1', 't2') ORDER BY refund_ticket`)
    await w.within(w.platform, SERVICE, async tx => {
      await tx.$executeRawUnsafe(`UPDATE ${w.t('orders')} SET refund_ticket = 't2' WHERE id = '${rows[0].id}'`)
      await tx.$executeRawUnsafe(`UPDATE ${w.t('orders')} SET refund_ticket = 't1' WHERE id = '${rows[1].id}'`)
    })
    await expectConverged(w, SPEC)
  })

  it('a referential action fires once, on the host, and the satellite follows', async () => {
    await w.as(w.platform, SERVICE, `DELETE FROM ${w.t('agents')} WHERE id = 1`)
    const [{ n }] = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM ${w.t('orders')} WHERE refund_agent IS NOT NULL`)
    expect(n).toBe(0)
    await expectConverged(w, SPEC)
  })

  it('the host still refuses what it refused before', async () => {
    await expect(w.as(w.platform, SERVICE, `UPDATE ${w.t('orders')} SET refund_code = 'bad' WHERE refund_code = 'ok2'`)).rejects.toThrow(/code_ok/)
    await expect(w.as(w.platform, SERVICE, `UPDATE ${w.t('orders')} SET refund_batch = 77 WHERE refund_code = 'ok3'`)).rejects.toThrow(/batch_fk/)
    expect(codeViolator).not.toBe('')
    await expectConverged(w, SPEC)
  })
})

// ── Rows hidden from Backenly's own view ────────────────────────────────────

describe('hidden rows: never a "consistent" from a partial view', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }

  const build = (label: string, restrictive: boolean) =>
    ownedWorkspace(label, SPEC, w => {
      const { svc, sub } = claimSql(w)
      return [
        `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
           secret boolean NOT NULL DEFAULT false, refund_amount numeric, refund_reason text)`,
        `INSERT INTO ${w.t('orders')} (user_id, secret, refund_amount, refund_reason)
         SELECT CASE WHEN i % 3 = 0 THEN '${S}'::uuid ELSE '${B}'::uuid END, i % 3 = 0, i, 'r' || i FROM generate_series(1, 12) i`,
        `ALTER TABLE ${w.t('orders')} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${w.t('orders')} FORCE ROW LEVEL SECURITY`,
        // Secret orders: only their owner sees them, not even the service claim.
        `CREATE POLICY see ON ${w.t('orders')} FOR SELECT USING ((${svc} AND NOT secret) OR user_id::text = ${sub})`,
        `CREATE POLICY change ON ${w.t('orders')} FOR UPDATE USING ((${svc} AND NOT secret) OR user_id::text = ${sub})`,
        ...(restrictive ? [`CREATE POLICY never_secret ON ${w.t('orders')} AS RESTRICTIVE FOR ALL USING (NOT secret OR user_id::text = ${sub})`] : []),
        `GRANT SELECT, UPDATE ON ${w.t('orders')} TO "${w.client}"`,
      ]
    })

  describe('hidden only by permissive policies', () => {
    let w: OwnedWorkspace
    beforeAll(async () => {
      w = await build('hid', false)
      await runLadder(w, SPEC, ['create', 'sync', 'backfill'])
    }, 120_000)
    afterAll(async () => w.drop())

    it('the service view really does hide them', async () => {
      const [{ n }] = await w.as<{ n: number }>(w.platform, SERVICE, `SELECT count(*)::int AS n FROM ${w.t('orders')}`)
      expect(n).toBe(8)
    })

    it('the ladder copies them anyway, and reconciles every row', async () => {
      await expectConverged(w, SPEC)
      expect((await truth(w, SPEC)).sat.length).toBe(12)
      const r = await reconcileAsPlatform(w, SPEC)
      expect(r.consistent).toBe(true)
      expect(r.satelliteRows).toBe(12)
    })

    it('and the runtime still sees exactly what it saw', async () => {
      for (const claims of [ANON, SERVICE, asUser(B), asUser(S)]) {
        const [h] = await w.as<{ n: number }>(w.platform, claims, `SELECT count(*)::int AS n FROM ${w.t('orders')}`)
        const [hs] = await w.as<{ n: number }>(w.platform, claims, `SELECT count(*)::int AS n FROM ${w.t('orders')} WHERE refund_amount IS NOT NULL`)
        expect({ h: h.n, hs: hs.n }).toEqual(
          claims === SERVICE ? { h: 8, hs: 8 } : claims === ANON ? { h: 0, hs: 0 } : claims.userId === S ? { h: 4, hs: 4 } : { h: 8, hs: 8 },
        )
      }
    })
  })

  describe('hidden by a restrictive policy that binds Backenly too', () => {
    let w: OwnedWorkspace
    beforeAll(async () => {
      w = await build('rst', true)
      await runLadder(w, SPEC, ['create', 'sync']).catch(() => {})
      await runLadder(w, SPEC, ['backfill']).catch(() => {})
    }, 120_000)
    afterAll(async () => w.drop())

    it('reconciliation does not call a partial view consistent', async () => {
      const r = await reconcileAsPlatform(w, SPEC)
      const { host, sat } = await truth(w, SPEC)
      if (sat.length !== host.length) expect(r.consistent).toBe(false)
      expect(r.consistent).toBe(false)
      expect(r.summary).toMatch(/cannot see every row/)
    })
  })
})

// ── TRUNCATE ─────────────────────────────────────────────────────────────────

describe('truncate', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount'], satellite: 'order_refunds', label: 'refund' }
  let w: OwnedWorkspace
  beforeAll(async () => {
    w = await ownedWorkspace('trn', SPEC, w => [
      `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, refund_amount numeric)`,
      `INSERT INTO ${w.t('orders')} (user_id, refund_amount) SELECT '${A}'::uuid, i FROM generate_series(1, 5) i`,
      `GRANT SELECT, UPDATE ON ${w.t('orders')} TO "${w.client}"`,
    ])
    await runLadder(w, SPEC, ['create', 'sync', 'backfill'])
  }, 120_000)
  afterAll(async () => w.drop())

  it('the satellite cannot be emptied on its own', async () => {
    await expect(w.as(w.platform, SERVICE, `TRUNCATE ${w.t('order_refunds')}`)).rejects.toThrow(/cannot be truncated/)
    await expectConverged(w, SPEC)
  })

  it('TRUNCATE … CASCADE of the host, as Backenly\'s own truncate action runs it, empties both', async () => {
    await w.as(w.platform, SERVICE, `TRUNCATE TABLE ${w.t('orders')} RESTART IDENTITY CASCADE`)
    expect(await truth(w, SPEC)).toEqual({ host: [], sat: [] })
  })
})

// ── Forging the sync's own settings ─────────────────────────────────────────

describe('forgery: settings set in the same statement change nothing', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount'], satellite: 'order_refunds', label: 'refund' }
  const N = ladderNames(SPEC)
  let w: OwnedWorkspace
  let bPublic = ''
  let aPlain = ''
  let aRefund = ''

  beforeAll(async () => {
    w = await ownedWorkspace('frg', SPEC, w => {
      const { svc, sub } = claimSql(w)
      return [
        `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, public boolean NOT NULL DEFAULT false, refund_amount numeric)`,
        `INSERT INTO ${w.t('orders')} (user_id, public, refund_amount) VALUES ('${B}', true, 50), ('${A}', false, NULL), ('${A}', false, 7)`,
        `ALTER TABLE ${w.t('orders')} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${w.t('orders')} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY see ON ${w.t('orders')} FOR SELECT USING (${svc} OR public OR user_id::text = ${sub})`,
        `CREATE POLICY change ON ${w.t('orders')} FOR UPDATE USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`,
        `GRANT SELECT, UPDATE ON ${w.t('orders')} TO "${w.client}"`,
      ]
    })
    await runLadder(w, SPEC, [...ALL_RUNGS])
    bPublic = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE user_id = '${B}'`))[0].id
    aPlain = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE user_id = '${A}' AND refund_amount IS NULL`))[0].id
    aRefund = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE user_id = '${A}' AND refund_amount IS NOT NULL`))[0].id
  }, 120_000)
  afterAll(async () => w.drop())

  // The settings older versions of the sync trusted to tell a cascade from a
  // client's write, forged within the statement; now nothing reads them, and
  // the sync's own guard is honoured only inside a trigger, as the owner.
  const forge = (setting: string) => `SELECT set_config('${setting}', statement_timestamp()::text || '|1', true)`

  it('cannot delete the refund of an order the caller may see but not update', async () => {
    await expect(
      w.as(
        w.client,
        asUser(A),
        `WITH f AS (${forge(`bkn_evo.gone_${N.hash}`)}), g AS (SELECT set_config('${N.guc}', '1', true))
         DELETE FROM ${w.t('order_refunds')} WHERE order_id = '${bPublic}' AND EXISTS (SELECT 1 FROM f) AND EXISTS (SELECT 1 FROM g)`,
      ),
    ).rejects.toThrow(/permission denied|row-level security|cannot change/)
    await expectConverged(w, SPEC)
  })

  it('cannot move a refund to another order', async () => {
    await expect(
      w.as(
        w.client,
        asUser(A),
        `WITH f AS (${forge(`bkn_evo.moved_${N.hash}`)}), g AS (SELECT set_config('${N.guc}', '1', true))
         UPDATE ${w.t('order_refunds')} SET order_id = '${aPlain}' WHERE order_id = '${aRefund}' AND EXISTS (SELECT 1 FROM f) AND EXISTS (SELECT 1 FROM g)`,
      ),
    ).rejects.toThrow(/cannot change|permission denied/)
    await expectConverged(w, SPEC)
  })

  it('deleting a parent still removes its refund, through the host', async () => {
    await w.as(w.platform, SERVICE, `DELETE FROM ${w.t('orders')} WHERE id = '${aRefund}'`)
    await expectConverged(w, SPEC)
  })
})

// ── The one function that runs as the owner ─────────────────────────────────

describe('definer: the forward sync runs as the owner for the host, and for nothing else', () => {
  const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount'], satellite: 'order_refunds', label: 'refund' }
  const N = ladderNames(SPEC)
  let w: OwnedWorkspace
  let reader = ''
  let theirs = ''

  beforeAll(async () => {
    w = await ownedWorkspace('dfn', SPEC, w => {
      const { svc, sub } = claimSql(w)
      return [
        `CREATE TABLE ${w.t('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, refund_amount numeric)`,
        `INSERT INTO ${w.t('orders')} (user_id, refund_amount) VALUES ('${B}', 50), ('${B}', NULL)`,
        `ALTER TABLE ${w.t('orders')} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${w.t('orders')} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY rw ON ${w.t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`,
      ]
    })
    await runLadder(w, SPEC, [...ALL_RUNGS])
    // A role that can run SQL but write nothing here: the shape of a project's
    // SELECT-only direct-access login, or any login with TEMP on the database.
    reader = `bkn_evo_ro_${w.schema.slice(-8)}`
    await prisma.$executeRawUnsafe(`CREATE ROLE "${reader}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${w.schema}" TO "${reader}"`)
    await prisma.$executeRawUnsafe(`GRANT SELECT ON ${w.t('orders')}, ${w.t('order_refunds')} TO "${reader}"`)
    await prisma.$executeRawUnsafe(`GRANT TEMPORARY ON DATABASE "${(await prisma.$queryRawUnsafe<any[]>('SELECT current_database() AS d'))[0].d}" TO "${reader}"`)
    theirs = (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text AS id FROM ${w.t('orders')} WHERE refund_amount IS NULL`))[0].id
  }, 120_000)
  afterAll(async () => {
    await w.drop()
    const db = (await prisma.$queryRawUnsafe<any[]>('SELECT current_database() AS d'))[0].d
    await prisma.$executeRawUnsafe(`REVOKE TEMPORARY ON DATABASE "${db}" FROM "${reader}"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${reader}"`).catch(() => {})
  })

  const hijack = (op: 'INSERT' | 'DELETE', key: string) => [
    `CREATE TEMP TABLE hijack (id uuid, refund_amount numeric) ON COMMIT DROP`,
    `CREATE TRIGGER hijack AFTER ${op} ON hijack FOR EACH ROW EXECUTE FUNCTION ${w.t(N.forward)}()`,
    `INSERT INTO hijack VALUES ('${key}', 999)`,
    ...(op === 'DELETE' ? [`DELETE FROM hijack`] : []),
  ]

  it('a role that may only read cannot fire it on a table of its own to write the new table', async () => {
    await expect(w.as(reader, asUser(A), hijack('INSERT', theirs))).rejects.toThrow(/permission denied for function/)
    await expect(w.as(reader, asUser(A), hijack('DELETE', theirs))).rejects.toThrow(/permission denied for function/)
    await expectConverged(w, SPEC)
    expect(await prisma.$queryRawUnsafe(`SELECT 1 FROM ${w.t('order_refunds')} WHERE order_id = '${theirs}'`)).toEqual([])
  })

  it('nor can a role that may write the new table, through the same door', async () => {
    await expect(w.as(w.client, asUser(B), hijack('INSERT', theirs))).rejects.toThrow(/permission denied for function/)
    await expectConverged(w, SPEC)
  })

  it('and fired on any table but the host, even by its owner, it refuses before writing anything', async () => {
    await expect(w.as(w.platform, SERVICE, hijack('INSERT', theirs))).rejects.toThrow(/fires only for/)
    await expectConverged(w, SPEC)
  })

  it('no function the ladder installs is executable by anyone but its owner', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; acl: string | null }>>(
      `SELECT p.proname AS name, p.proacl::text AS acl FROM pg_proc p
        WHERE p.pronamespace = '"${w.schema}"'::regnamespace AND p.proname LIKE 'bkn\\_evo\\_%' ORDER BY 1`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const r of rows) {
      // An ACL that names only the owner; NULL would mean the default, which includes PUBLIC.
      expect(r.acl).not.toBeNull()
      expect(r.acl).toMatch(new RegExp(`^\\{"?${w.platform}"?=X/"?${w.platform}"?\\}$`))
    }
  })
})
