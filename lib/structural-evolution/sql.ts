/**
 * THE EXTRACTION SQL — every statement a ladder can run, rendered from facts
 * ==========================================================================
 *
 * Nothing in this file takes SQL from a caller. Every statement is rendered from
 * two inputs: the catalog facts of the host table, and an `ExtractionSpec` that
 * names the host, the columns leaving it and the new table's name. Each of those
 * is an identifier checked against the catalog before it gets here. That is the
 * trade the rest of the platform makes — full capability through a closed
 * vocabulary — and it is what lets consent bind to the exact text below: the
 * plan hashes these strings into its version, so approving version N is
 * approving these statements and no others.
 *
 * ── The shape: a satellite that starts closed and follows its parent ────────
 *
 *   order_refunds
 *     id          uuid  primary key            (room for "many refunds" later)
 *     order_id    <pk>  unique, FK → orders    ON DELETE/UPDATE CASCADE
 *     refund_*    the members, same names, same types, no defaults
 *     CHECK       at least one member is set   (a row means "has a refund")
 *
 * Names are kept, not prettified. `refund_amount` stays `refund_amount` so
 * every CHECK, index and policy expression that reads it is valid on the new
 * table verbatim, and so a client migrating `select=refund_amount` to
 * `select=order_refunds(refund_amount)` changes one thing. Renaming is a
 * cosmetic evolution of its own and does not belong in a behaviour-preserving
 * one.
 *
 * Defaults are not carried, deliberately: writing a refund through the new table
 * corresponds to UPDATE-ing the order, and an UPDATE never applies defaults.
 *
 * ── Access: the satellite can never be more open than its parent ────────────
 *
 * Created with row-level security forced, every grant revoked (including any a
 * schema's default privileges handed out at CREATE), and one policy for the
 * role that creates it: the platform. That role is ALSO who the runtime serves
 * end users as, with only claims and forced row security between them, so the
 * policy admits it only inside the ladder's own context — a transaction-local
 * setting the forward sync sets around its own write and Backenly's backfill,
 * reconciliation and rehearsal set in their own transactions
 * (`ladderAccessSql`), and nothing that serves a client ever sets. Serving a
 * client, the platform gets what every role gets. Reads open later with a
 * policy that says "you may see this row iff you may see its parent", which is
 * evaluated by running the parent's OWN policy, so whatever rule protects
 * `orders` protects `order_refunds` without being restated. Nothing else is
 * honoured: not even the service-role claim, which is only a session setting
 * — a parent whose policies honour it extends that to the satellite through
 * its own policy, and a parent whose policies do not, does not. Writes are granted only to roles that may UPDATE the parent,
 * and the reverse sync performs that UPDATE as the caller, so the parent's
 * update policy is enforced on every satellite write. Writing a refund needs
 * exactly the permission it needed when the refund was a column.
 *
 * ── Sync: both directions, fail-closed, one authority ───────────────────────
 *
 * The rule the whole dual representation rests on: a transaction that commits
 * leaves the two representations equal, or it does not commit. There is no
 * third outcome — no committed state in which `orders.refund_amount` says 20
 * and `order_refunds.refund_amount` says 40 — so there is nothing for software
 * to guess about afterwards.
 *
 *   forward  (host → satellite)  AFTER ROW on the host, SECURITY DEFINER, in
 *                                the writer's transaction. Any error ABORTS the
 *                                writer's statement. It used to swallow errors
 *                                so an old client's write could never fail
 *                                because of it; but a swallowed deadlock,
 *                                serialization failure or lock timeout commits
 *                                the host write without its mirror — a
 *                                divergence nobody can resolve later. A
 *                                retryable error now is strictly better.
 *   reverse  (satellite → host)  AFTER ROW on the satellite, SECURITY INVOKER,
 *                                applies the write to the host as the caller.
 *                                Zero rows on a parent that exists means the
 *                                parent's update policy said no: raised as
 *                                42501, and the satellite write aborts with it.
 *
 * Authority: until a person runs `contract`, the HOST is the source of truth
 * and the satellite is a projection of it that also accepts writes. A satellite
 * write that did not reach the host did not happen (it aborted). If the two
 * ever disagree anyway — by bypassing triggers (`session_replication_role =
 * replica`, `ALTER TABLE … DISABLE TRIGGER`), or by the one forgery below —
 * reconciliation reports it, the ladder stops (`blocked`), rollback refuses,
 * and nothing is "repaired" by software guessing which side was meant.
 *
 * What a session can and cannot forge. Every guard here is a custom setting,
 * and any session may set one. The echo guards are only honoured from inside a
 * trigger (`pg_trigger_depth() > 1`), which a client's own statement never is,
 * so setting them by hand skips nothing: a satellite write still goes through
 * the parent's update policy. The cascade counters cannot be told apart that
 * way (PostgreSQL runs a foreign key's cascade at the caller's depth, as the
 * caller), so a principal that can run arbitrary SQL — never an end user of
 * the runtime or the REST API, which cannot set settings — and holds the
 * satellite's write grant could, within one statement, delete or re-key a
 * satellite row it can SEE without the host changing. That widens no read and
 * writes nothing to the host; it is a divergence, which observation reports.
 *
 * ── Concurrency, case by case ──────────────────────────────────────────────
 *
 * Lock order: an old writer locks host row → satellite row; a new writer
 * locks satellite row → host row (the reverse sync); the backfill share-locks
 * host rows → satellite rows and never WAITS for a host row (NOWAIT).
 *
 *   old vs old (same row)    host row lock serialises them; each forward
 *                            mirror writes every member from NEW, so the
 *                            later committer wins in both places
 *   new vs new (same row)    satellite row lock serialises them; the reverse
 *                            sync writes every member, later committer wins
 *   old vs new (same row)    usually serialised by whichever lock is taken
 *                            first. The crossing case — each holding one and
 *                            wanting the other — is a deadlock; PostgreSQL
 *                            aborts one WHOLE transaction (40P01) and the
 *                            survivor's value lands in both. Before
 *                            fail-closed, the abort could hit inside the
 *                            forward trigger and be swallowed.
 *   backfill vs writers      the batch share-locks its host rows with NOWAIT,
 *                            so a row being written makes the batch retry
 *                            instead of waiting; a backfill can therefore never
 *                            be part of a deadlock cycle, and a writer waits at
 *                            most one batch. The lock also stops a stale copy
 *                            overwriting a newer mirror.
 *   echo                     each direction sets one transaction-local guard
 *                            around its own nested write and clears it right
 *                            after, and honours it only from inside a trigger;
 *                            inside a savepoint that is rolled back,
 *                            PostgreSQL restores the setting with it
 *   parent key changes       ON UPDATE CASCADE rewrites the satellite's
 *                            reference. A BEFORE row trigger on the host counts
 *                            each re-keyed parent carrying the concern, and the
 *                            reverse sync accepts a reference change only by
 *                            consuming that count with nothing else moved. A
 *                            client moving a row to another parent is refused
 *                            (0A000).
 *   deletes                  deleting a parent cascades to its satellite row;
 *                            the same trigger counts it, and only a counted
 *                            delete may leave the host untouched. Deleting a
 *                            satellite row otherwise clears the parent's
 *                            members, as the caller, or is refused (42501).
 *                            Never decided by whether the caller can SEE the
 *                            parent: through row-level security a hidden parent
 *                            and a deleted one look alike.
 *   TRUNCATE                 refused on the satellite (row triggers do not
 *                            fire for it, so it would silently diverge);
 *                            TRUNCATE of the host needs CASCADE because of the
 *                            foreign key, and then empties both
 *   satellite removed by     the forward sync finds no satellite and lets the
 *   hand                     host write through: there is no second
 *                            representation left to disagree with, and old
 *                            clients keep working. Observation reports it.
 *   retries, crashes         every rung is one transaction and idempotent, or
 *                            adopted when its postcondition already holds (a
 *                            crash between COMMIT and the ledger write); one
 *                            ladder per project at a time (advisory lock)
 *
 * The echo of each direction is suppressed by one transaction-local setting,
 * set immediately around the nested write and cleared immediately after — not
 * left set for the rest of the transaction, which would silently skip an
 * unrelated later statement in it.
 */

import { createHash } from 'node:crypto'
import { IDENT, LADDER_OBJECT_PREFIX, type TableFacts } from './facts'
import { singular } from './lexicon'

export interface ExtractionSpec {
  host: string
  /** Sorted. */
  members: string[]
  satellite: string
  /** The concern's name, for prose only. */
  label: string
}

/** Where a render lands. The live workspace schema, or a rehearsal's scratch one. */
export interface RenderTarget {
  schema: string
}

export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`
export const fq = (schema: string, name: string) => `${qi(schema)}.${qi(name)}`
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

// ── Names ────────────────────────────────────────────────────────────────────

export interface LadderNames {
  hash: string
  fkColumn: string
  pk: string
  unique: string
  fk: string
  present: string
  forward: string
  reverse: string
  /** Statement trigger + function refusing TRUNCATE on the satellite. */
  truncateGuard: string
  /**
   * Row trigger + function on the host counting parents that carry the
   * concern and are being deleted, or re-keyed, in this transaction: the only
   * satellite changes the reverse sync accepts without changing the host.
   */
  cascadeMark: string
  /** Transaction-local counters the cascade mark keeps. */
  gone: string
  moved: string
  policies: { owner: string; select: string; insert: string; update: string; delete: string }
  /** Custom GUC suppressing each direction's echo. */
  guc: string
  /**
   * Transaction-local GUC under which the platform's own ladder work (the
   * forward sync, backfill, reconciliation) reaches every satellite row; see
   * `ladderAccessSql`.
   */
  access: string
  carriedConstraint: (i: number) => string
  carriedIndex: (i: number) => string
}

/**
 * Deterministic object names for one (host, satellite) pair.
 *
 * Every name starts with `bkn_evo_`, which is what `basisFingerprint` strips,
 * so a ladder's own objects never invalidate its own consent.
 */
export function ladderNames(spec: ExtractionSpec): LadderNames {
  const hash = createHash('sha256').update(`${spec.host}|${spec.satellite}`).digest('hex').slice(0, 10)
  const p = (s: string) => `${LADDER_OBJECT_PREFIX}${s}_${hash}`
  const base = `${singular(spec.host)}_id`.toLowerCase()
  const fkColumn = spec.members.includes(base) || base === 'id' ? `${singular(spec.host)}_ref`.toLowerCase() : base
  return {
    hash,
    fkColumn,
    pk: p('pk'),
    unique: p('uq'),
    fk: p('fk'),
    present: p('present'),
    forward: p('fwd'),
    reverse: p('rev'),
    truncateGuard: p('trunc'),
    cascadeMark: p('mark'),
    gone: `bkn_evo.gone_${hash}`,
    moved: `bkn_evo.moved_${hash}`,
    policies: { owner: p('own'), select: p('sel'), insert: p('ins'), update: p('upd'), delete: p('del') },
    guc: `bkn_evo.sync_${hash}`,
    access: `bkn_evo.access_${hash}`,
    carriedConstraint: i => `${p('ck')}_${i}`,
    carriedIndex: i => `${p('ix')}_${i}`,
  }
}

// ── What travels with the columns ────────────────────────────────────────────

export interface CarriedObjects {
  constraints: Array<{ name: string; from: string; definition: string }>
  indexes: Array<{ name: string; from: string; definition: string }>
  /** Objects on the members that are NOT carried, and why. */
  notCarried: string[]
}

const INDEXDEF = /^CREATE (UNIQUE )?INDEX (\S+) ON (?:ONLY )?(\S+) USING ([\s\S]+)$/

/**
 * Constraints and indexes that read ONLY the members, carried verbatim.
 *
 * Verbatim is safe precisely because member names are kept: `CHECK
 * ((refund_amount >= 0))` means the same thing on either table. Anything that
 * also reads a column staying behind stays behind with it, and keeps working,
 * because expand never removes the column it reads.
 */
export function carriedObjects(
  facts: TableFacts,
  spec: ExtractionSpec,
  names: LadderNames,
  target: RenderTarget,
  opts: { includeForeignKeys: boolean },
): CarriedObjects {
  const set = new Set(spec.members)
  const within = (cols: string[]) => cols.length > 0 && cols.every(c => set.has(c))
  const out: CarriedObjects = { constraints: [], indexes: [], notCarried: [] }
  let ci = 0
  for (const k of facts.constraints) {
    if (!within(k.columns) || k.name.startsWith(LADDER_OBJECT_PREFIX)) continue
    if (k.kind === 'c' || k.kind === 'u' || k.kind === 'x') {
      out.constraints.push({ name: names.carriedConstraint(ci++), from: k.name, definition: k.definition })
    } else if (k.kind === 'f') {
      const passive = ['a', 'r'].includes(k.onDelete ?? 'a') && ['a', 'r'].includes(k.onUpdate ?? 'a')
      if (!passive) {
        out.notCarried.push(`${k.name}: has a referential action; it stays on ${spec.host} and keeps guarding the value`)
      } else if (!opts.includeForeignKeys) {
        out.notCarried.push(`${k.name}: foreign keys are not rehearsed, because they would reach live tables`)
      } else {
        out.constraints.push({
          name: names.carriedConstraint(ci++),
          from: k.name,
          definition:
            `FOREIGN KEY (${k.columns.map(qi).join(', ')}) REFERENCES ` +
            `${fq(k.refSchema!, k.refTable!)} (${(k.refColumns ?? []).map(qi).join(', ')})`,
        })
      }
    }
  }
  let ii = 0
  for (const i of facts.indexes) {
    if (i.constraintBacked || i.primary || !within(i.references)) continue
    const m = INDEXDEF.exec(i.definition)
    if (!m) {
      out.notCarried.push(`${i.name}: its definition could not be read safely`)
      continue
    }
    const name = names.carriedIndex(ii++)
    out.indexes.push({
      name,
      from: i.name,
      definition: `CREATE ${m[1] ?? ''}INDEX ${qi(name)} ON ${fq(target.schema, spec.satellite)} USING ${m[4]}`,
    })
  }
  return out
}

// ── Shared fragments ─────────────────────────────────────────────────────────

function parts(facts: TableFacts, spec: ExtractionSpec, target: RenderTarget) {
  const names = ladderNames(spec)
  const pkName = facts.primaryKey[0]
  const pkCol = facts.columns.find(c => c.name === pkName)!
  const members = spec.members.map(m => facts.columns.find(c => c.name === m)!)
  return {
    names,
    host: fq(target.schema, spec.host),
    sat: fq(target.schema, spec.satellite),
    satName: qi(spec.satellite),
    pk: qi(pkName),
    pkType: pkCol.type,
    fk: qi(names.fkColumn),
    members,
    m: spec.members.map(qi),
  }
}

/**
 * A counter that lives for ONE client statement, kept in a transaction-local
 * setting as `<statement_timestamp>|<n>`: restored on savepoint rollback with
 * everything else, and never inherited by the next statement. A parent's
 * delete and the foreign key's cascade into the satellite are one statement;
 * an unrelated satellite delete later in the same transaction is another, and
 * reads zero whatever an earlier statement left behind.
 */
const counter = (guc: string) =>
  `(CASE WHEN split_part(COALESCE(current_setting('${guc}', true), ''), '|', 1) = statement_timestamp()::text ` +
  `THEN COALESCE(NULLIF(split_part(current_setting('${guc}', true), '|', 2), ''), '0')::int ELSE 0 END)`
const bump = (guc: string, by: 1 | -1) =>
  `PERFORM set_config('${guc}', statement_timestamp()::text || '|' || (${counter(guc)} ${by > 0 ? '+' : '-'} 1)::text, true);`

const rowOf = (alias: string, cols: string[]) => `ROW(${cols.map(c => `${alias}.${c}`).join(', ')})::text`
const allNull = (alias: string, cols: string[]) => cols.map(c => `${alias}.${c} IS NULL`).join(' AND ')
const anySet = (alias: string, cols: string[]) => `(${cols.map(c => `${alias}.${c} IS NOT NULL`).join(' OR ')})`

/**
 * The parent-visibility predicate every client-facing satellite policy shares:
 * the parent's own policies, run as the caller, and nothing else.
 */
function followsParent(x: ReturnType<typeof parts>): string {
  return `(EXISTS (SELECT 1 FROM ${x.host} h WHERE h.${x.pk} = ${x.satName}.${x.fk}))`
}

/**
 * Policies on a satellite that could admit a row its parent would not: for a
 * satellite as Backenly renders it, none.
 *
 * Every client-facing policy tests exactly `followsParent`, so each deparses to
 * the same text as the read policy. The one exception is the owner's own,
 * `TO CURRENT_USER` (a single named role, never PUBLIC). A permissive policy
 * that tests anything else, under any name, can widen access, and no probe that
 * names its row can see a write policy wider only on rows the caller cannot
 * read. A restrictive policy only narrows and is left to the probes.
 *
 * `reference` is the read policy's deparsed test, or null before reads are
 * exposed: then any client-facing policy at all is unexpected.
 */
export function policiesWiderThanParent(
  policies: Array<{ name: string; permissive: boolean; roles: string[]; using: string | null; withCheck: string | null }>,
  names: LadderNames,
): { reference: string | null; wider: string[] } {
  const reference = policies.find(p => p.name === names.policies.select)?.using ?? null
  // The owner's own: one named role, and nothing but the ladder's context as
  // its test, on both sides.
  const owners = (p: (typeof policies)[number]) =>
    p.name === names.policies.owner &&
    p.roles.length === 1 &&
    p.roles[0].toLowerCase() !== 'public' &&
    p.using !== null &&
    p.using === p.withCheck &&
    p.using.includes(`current_setting('${names.access}'`) &&
    !/\bOR\b/i.test(p.using)
  const wider = policies
    .filter(p => p.permissive && !owners(p))
    .filter(p => reference === null || [p.using, p.withCheck].some(e => e !== null && e !== reference))
    .map(p => p.name)
  return { reference, wider }
}

/**
 * Put the current transaction into the ladder's own context: the satellite's
 * owner policy admits the platform role only here. Run by Backenly's backfill,
 * reconciliation and rehearsal, in their own transactions, never by anything
 * that serves a client.
 */
export function ladderAccessSql(spec: ExtractionSpec): string {
  return `SELECT set_config(${lit(ladderNames(spec).access)}, 'on', true)`
}

/** The owner policy's whole test: the ladder's own context, nothing else. */
function ladderOnly(n: LadderNames): string {
  return `(current_setting(${lit(n.access)}, true) = 'on')`
}

function grantList(roles: string[]): string {
  return roles.map(r => (r === 'PUBLIC' ? 'PUBLIC' : qi(r))).join(', ')
}

// ── Step renderers ───────────────────────────────────────────────────────────

export function createSatelliteSql(
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
  carried: CarriedObjects,
  planId: string,
): string[] {
  const x = parts(facts, spec, target)
  const n = x.names
  const satRegclass = lit(`${qi(target.schema)}.${qi(spec.satellite)}`)
  return [
    [
      `CREATE TABLE ${x.sat} (`,
      `  "id" uuid NOT NULL DEFAULT gen_random_uuid(),`,
      `  ${x.fk} ${x.pkType} NOT NULL,`,
      ...x.members.map(c => `  ${qi(c.name)} ${c.type},`),
      `  CONSTRAINT ${qi(n.pk)} PRIMARY KEY ("id"),`,
      `  CONSTRAINT ${qi(n.unique)} UNIQUE (${x.fk}),`,
      `  CONSTRAINT ${qi(n.fk)} FOREIGN KEY (${x.fk}) REFERENCES ${x.host} (${x.pk}) ON DELETE CASCADE ON UPDATE CASCADE,`,
      `  CONSTRAINT ${qi(n.present)} CHECK (${x.m.join(' IS NOT NULL OR ')} IS NOT NULL)`,
      `)`,
    ].join('\n'),
    ...carried.constraints.map(c => `ALTER TABLE ${x.sat} ADD CONSTRAINT ${qi(c.name)} ${c.definition}`),
    ...carried.indexes.map(i => i.definition),
    `ALTER TABLE ${x.sat} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${x.sat} FORCE ROW LEVEL SECURITY`,
    // The creating role is the platform, and the platform is also who the
    // runtime serves end users as (claims set, row-level security forced). So
    // its own policy admits it only inside the ladder's own work (the forward
    // sync, backfill, reconciliation), which sets a transaction-local context
    // the runtime never does. Serving a client, the platform role gets exactly
    // what every other role gets: the parent's visibility, once reads open.
    `CREATE POLICY ${qi(n.policies.owner)} ON ${x.sat} FOR ALL TO CURRENT_USER USING ${ladderOnly(n)} WITH CHECK ${ladderOnly(n)}`,
    // Row triggers do not fire for TRUNCATE, so emptying the satellite would
    // leave the host carrying values the satellite silently lost.
    [
      `CREATE OR REPLACE FUNCTION ${fq(target.schema, n.truncateGuard)}()`,
      `RETURNS trigger`,
      `LANGUAGE plpgsql`,
      `SET search_path = ${qi(target.schema)}, pg_temp`,
      `AS $bkn$`,
      `BEGIN`,
      `  RAISE EXCEPTION '${spec.satellite} mirrors ${spec.host} and cannot be truncated; delete its rows instead, each delete reaches ${spec.host}'`,
      `    USING ERRCODE = '0A000';`,
      `END;`,
      `$bkn$`,
    ].join('\n'),
    `CREATE TRIGGER ${qi(n.truncateGuard)} BEFORE TRUNCATE ON ${x.sat} FOR EACH STATEMENT EXECUTE FUNCTION ${fq(target.schema, n.truncateGuard)}()`,
    // Starts closed: undo whatever the schema's default privileges granted at
    // CREATE, so nobody but the owner reaches it until a later rung says so.
    [
      `DO $bkn$`,
      `DECLARE g record;`,
      `BEGIN`,
      `  FOR g IN SELECT DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x.grantee)) END AS who`,
      `             FROM pg_class c, aclexplode(c.relacl) x`,
      `            WHERE c.oid = ${satRegclass}::regclass AND x.grantee <> c.relowner`,
      `  LOOP`,
      `    EXECUTE format('REVOKE ALL ON %s FROM %s', ${satRegclass}::regclass, g.who);`,
      `  END LOOP;`,
      `END $bkn$`,
    ].join('\n'),
    `COMMENT ON TABLE ${x.sat} IS ${lit(
      `The ${spec.label} concern of ${spec.host}, extracted by Backenly structural evolution (plan ${planId}). ` +
        `Kept in sync with ${spec.host}.${spec.members.join(', ')} until those columns are retired.`,
    )}`,
  ]
}

export function forwardSyncSql(facts: TableFacts, spec: ExtractionSpec, target: RenderTarget): string[] {
  const x = parts(facts, spec, target)
  const n = x.names
  const S = qi(target.schema)
  const fn = fq(target.schema, n.forward)
  const satRegclass = lit(`${qi(target.schema)}.${qi(spec.satellite)}`)
  const body = [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SECURITY DEFINER`,
    `SET search_path = ${S}, pg_temp`,
    `AS $bkn$`,
    `DECLARE`,
    `  prior text;`,
    `BEGIN`,
    `  -- The reverse direction is writing ${spec.host}; this is its echo. It only`,
    `  -- ever arrives from inside that trigger, so a direct write (depth 1) is`,
    `  -- never an echo, whatever the session has set.`,
    `  IF current_setting('${n.guc}', true) = '1' AND pg_trigger_depth() > 1 THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'UPDATE' AND ${rowOf('OLD', x.m)} IS NOT DISTINCT FROM ${rowOf('NEW', x.m)} THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'INSERT' AND ${allNull('NEW', x.m)} THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  -- Removed outside the ladder: there is no second representation left to`,
    `  -- disagree with, and the customer's write goes through.`,
    `  IF to_regclass(${satRegclass}) IS NULL THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  -- No exception handler, on purpose: if the mirror cannot be written, the`,
    `  -- write to ${spec.host} does not commit either.`,
    `  -- Runs as the satellite's owner (SECURITY DEFINER), in the ladder's own`,
    `  -- context, which its policy admits; the context is restored right after.`,
    `  prior := current_setting('${n.access}', true);`,
    `  PERFORM set_config('${n.access}', 'on', true);`,
    `  PERFORM set_config('${n.guc}', '1', true);`,
    `  IF ${allNull('NEW', x.m)} THEN`,
    `    DELETE FROM ${x.sat} WHERE ${x.fk} = NEW.${x.pk};`,
    `  ELSE`,
    `    INSERT INTO ${x.sat} AS s (${x.fk}, ${x.m.join(', ')})`,
    `    VALUES (NEW.${x.pk}, ${x.m.map(c => `NEW.${c}`).join(', ')})`,
    `    ON CONFLICT (${x.fk}) DO UPDATE SET ${x.m.map(c => `${c} = EXCLUDED.${c}`).join(', ')};`,
    `  END IF;`,
    `  PERFORM set_config('${n.guc}', '', true);`,
    `  PERFORM set_config('${n.access}', COALESCE(prior, ''), true);`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  // The foreign key cascades a parent's DELETE and key change into the
  // satellite; the reverse sync must accept exactly those, and nothing that
  // only looks like them. Counting them here, as the parent row goes, is the
  // one way to know without asking whether the caller can SEE the parent — a
  // hidden parent and a deleted one look the same through row-level security.
  const mark = fq(target.schema, n.cascadeMark)
  const markBody = [
    `CREATE OR REPLACE FUNCTION ${mark}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SET search_path = ${S}, pg_temp`,
    `AS $bkn$`,
    `BEGIN`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    ${bump(n.gone, 1)}`,
    `    RETURN OLD;`,
    `  END IF;`,
    `  IF NEW.${x.pk} IS DISTINCT FROM OLD.${x.pk} THEN`,
    `    ${bump(n.moved, 1)}`,
    `  END IF;`,
    `  RETURN NEW;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  return [
    body,
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${x.host}`,
    `CREATE TRIGGER ${qi(n.forward)} AFTER INSERT OR UPDATE OF ${x.m.join(', ')} ON ${x.host} ` +
      `FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    markBody,
    `DROP TRIGGER IF EXISTS ${qi(n.cascadeMark)} ON ${x.host}`,
    `CREATE TRIGGER ${qi(n.cascadeMark)} BEFORE DELETE OR UPDATE OF ${x.pk} ON ${x.host} ` +
      `FOR EACH ROW WHEN (${x.m.map(c => `OLD.${c} IS NOT NULL`).join(' OR ')}) EXECUTE FUNCTION ${mark}()`,
  ]
}

/**
 * One backfill batch. `$1` is the cursor as text, NULL for the first batch.
 *
 * The batch's host rows are taken `FOR SHARE NOWAIT`. The share lock stops a
 * write landing between this batch reading a row and upserting it — the
 * forward trigger would mirror the new value and the backfill would then
 * mirror the stale one over it. NOWAIT means the batch never waits for a
 * writer: a row being written fails the batch with 55P03 and the caller
 * retries it. A backfill that never waits can never be part of a deadlock
 * cycle, and a writer waits at most for one small batch.
 */
export function backfillBatchSql(
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
  batchRows: number,
): string {
  const x = parts(facts, spec, target)
  const b = x.m.map(c => `b.${c}`)
  return [
    `WITH batch AS (`,
    `  SELECT h.${x.pk} AS k, ${x.m.map(c => `h.${c}`).join(', ')}`,
    `    FROM ${x.host} h`,
    `   WHERE $1::text IS NULL OR h.${x.pk} > ($1::text)::${x.pkType}`,
    `   ORDER BY h.${x.pk}`,
    `   LIMIT ${Math.max(1, Math.floor(batchRows))}`,
    `   FOR SHARE OF h NOWAIT`,
    `), up AS (`,
    `  INSERT INTO ${x.sat} AS s (${x.fk}, ${x.m.join(', ')})`,
    `  SELECT b.k, ${b.join(', ')} FROM batch b WHERE ${anySet('b', x.m)}`,
    `  ON CONFLICT (${x.fk}) DO UPDATE SET ${x.m.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
    `   WHERE ${rowOf('s', x.m)} IS DISTINCT FROM ${rowOf('EXCLUDED', x.m)}`,
    `  RETURNING 1`,
    `), gone AS (`,
    `  DELETE FROM ${x.sat} s USING batch b`,
    `   WHERE s.${x.fk} = b.k AND ${allNull('b', x.m)}`,
    `  RETURNING 1`,
    `)`,
    `SELECT (SELECT count(*) FROM batch)::bigint AS scanned,`,
    `       (SELECT count(*) FROM up)::bigint AS upserted,`,
    `       (SELECT count(*) FROM gone)::bigint AS removed,`,
    // Cast AFTER ordering. In `SELECT k::text … ORDER BY k` the ORDER BY binds
    // to the text output column and sorts integer keys as text ('999' > '1000').
    `       (SELECT b.k FROM batch b ORDER BY b.k DESC LIMIT 1)::text AS next_cursor`,
  ].join('\n')
}

/**
 * The equivalence check, as one statement so both tables are read at ONE
 * snapshot. Run under REPEATABLE READ by the caller; under READ COMMITTED a
 * write between two sub-selects would read as a mismatch that never existed.
 *
 * Values are compared as their text rendering. Both sides have the same types by
 * construction, so the rendering is the same function of the same value — and
 * it works for `json`, `point` and every other type with no equality operator.
 */
export function reconcileSql(facts: TableFacts, spec: ExtractionSpec, target: RenderTarget): string {
  const x = parts(facts, spec, target)
  const present = anySet('h', x.m)
  const missing = `FROM ${x.host} h WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${x.sat} s WHERE s.${x.fk} = h.${x.pk})`
  const orphaned = `FROM ${x.sat} s LEFT JOIN ${x.host} h ON h.${x.pk} = s.${x.fk} WHERE h.${x.pk} IS NULL OR (${allNull('h', x.m)})`
  const mismatched = `FROM ${x.sat} s JOIN ${x.host} h ON h.${x.pk} = s.${x.fk} WHERE ${rowOf('h', x.m)} IS DISTINCT FROM ${rowOf('s', x.m)}`
  return [
    `SELECT`,
    `  (SELECT count(*) FROM ${x.host} h WHERE ${present})::bigint AS present,`,
    `  (SELECT count(*) FROM ${x.sat})::bigint AS satellite_rows,`,
    `  (SELECT count(*) ${missing})::bigint AS missing,`,
    `  (SELECT count(*) ${orphaned})::bigint AS orphaned,`,
    `  (SELECT count(*) ${mismatched})::bigint AS mismatched,`,
    `  ARRAY(SELECT h.${x.pk}::text ${missing} LIMIT 5) AS missing_keys,`,
    `  ARRAY(SELECT s.${x.fk}::text ${orphaned} LIMIT 5) AS orphaned_keys,`,
    `  ARRAY(SELECT h.${x.pk}::text ${mismatched} LIMIT 5) AS mismatched_keys`,
  ].join('\n')
}

export function exposeReadsSql(
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
  readers: string[],
): string[] {
  const x = parts(facts, spec, target)
  return [
    // Every rung is safe to run twice: a crash after COMMIT and before the
    // ledger recorded it re-runs the rung on the next attempt.
    `DROP POLICY IF EXISTS ${qi(x.names.policies.select)} ON ${x.sat}`,
    `CREATE POLICY ${qi(x.names.policies.select)} ON ${x.sat} FOR SELECT USING ${followsParent(x)}`,
    ...(readers.length > 0 ? [`GRANT SELECT ON ${x.sat} TO ${grantList(readers)}`] : []),
  ]
}

export function openWritesSql(
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
  writers: string[],
): string[] {
  const x = parts(facts, spec, target)
  const n = x.names
  const S = qi(target.schema)
  const fn = fq(target.schema, n.reverse)
  const body = [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SET search_path = ${S}, pg_temp`,
    `AS $bkn$`,
    `DECLARE`,
    `  n bigint;`,
    `  k ${x.pkType};`,
    `  r record;`,
    `  wanted text;`,
    `BEGIN`,
    `  -- The forward direction (or this trigger's own correction below) is`,
    `  -- writing ${spec.satellite}; this is its echo. Both arrive from inside a`,
    `  -- trigger; a client's own write is at depth 1 and is never skipped, so`,
    `  -- setting the guard by hand cannot bypass ${spec.host}'s update policy.`,
    `  IF current_setting('${n.guc}', true) = '1' AND pg_trigger_depth() > 1 THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'UPDATE' AND NEW.${x.fk} IS DISTINCT FROM OLD.${x.fk} THEN`,
    `    -- ${spec.host}'s own key changed and ON UPDATE CASCADE carried it here:`,
    `    -- counted as the parent row was re-keyed (see the cascade mark), and`,
    `    -- nothing but the reference moved. Anything else is a client moving a`,
    `    -- row to another parent, which is refused.`,
    `    IF ${rowOf('OLD', x.m)} IS NOT DISTINCT FROM ${rowOf('NEW', x.m)} AND ${counter(n.moved)} > 0 THEN`,
    `      ${bump(n.moved, -1)}`,
    `      RETURN NULL;`,
    `    END IF;`,
    `    RAISE EXCEPTION '${spec.satellite}.${n.fkColumn} cannot change while ${spec.host} still carries these columns; delete and insert instead'`,
    `      USING ERRCODE = '0A000';`,
    `  END IF;`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    k := OLD.${x.fk};`,
    `    wanted := ROW(${x.members.map(c => `NULL::${c.type}`).join(', ')})::text;`,
    `  ELSE`,
    `    k := NEW.${x.fk};`,
    `    wanted := ${rowOf('NEW', x.m)};`,
    `  END IF;`,
    `  PERFORM set_config('${n.guc}', '1', true);`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NULL`).join(', ')} WHERE ${x.pk} = k RETURNING * INTO r;`,
    `  ELSE`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NEW.${c}`).join(', ')} WHERE ${x.pk} = k RETURNING * INTO r;`,
    `  END IF;`,
    `  GET DIAGNOSTICS n = ROW_COUNT;`,
    `  -- ${spec.host} is the authority. If one of its own triggers stored`,
    `  -- something other than what was written, ${spec.satellite} takes what`,
    `  -- ${spec.host} stored, in this same statement.`,
    `  IF n = 1 AND ${rowOf('r', x.m)} IS DISTINCT FROM wanted THEN`,
    `    IF ${allNull('r', x.m)} THEN`,
    `      DELETE FROM ${x.sat} WHERE ${x.fk} = k;`,
    `    ELSE`,
    `      INSERT INTO ${x.sat} AS s (${x.fk}, ${x.m.join(', ')})`,
    `      VALUES (k, ${x.m.map(c => `r.${c}`).join(', ')})`,
    `      ON CONFLICT (${x.fk}) DO UPDATE SET ${x.m.map(c => `${c} = EXCLUDED.${c}`).join(', ')};`,
    `    END IF;`,
    `  END IF;`,
    `  PERFORM set_config('${n.guc}', '', true);`,
    `  -- Run as the caller, so ${spec.host}'s own update policy decided: zero rows`,
    `  -- means it said no. The one exception is the cascade from deleting a`,
    `  -- parent that carried the concern, counted as that parent row went (see`,
    `  -- the cascade mark). It is never inferred from the caller not seeing the`,
    `  -- parent: through row-level security a hidden parent and a deleted one`,
    `  -- look the same, and only one of them may skip the host.`,
    `  IF n = 0 THEN`,
    `    IF TG_OP = 'DELETE' AND ${counter(n.gone)} > 0 THEN`,
    `      ${bump(n.gone, -1)}`,
    `    ELSE`,
    `      RAISE EXCEPTION 'permission denied: this change to ${spec.satellite} changes ${spec.host} row %, which the caller may not update', k`,
    `        USING ERRCODE = '42501';`,
    `    END IF;`,
    `  END IF;`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  const parent = followsParent(x)
  return [
    body,
    `DROP TRIGGER IF EXISTS ${qi(n.reverse)} ON ${x.sat}`,
    `CREATE TRIGGER ${qi(n.reverse)} AFTER INSERT OR UPDATE OR DELETE ON ${x.sat} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    `DROP POLICY IF EXISTS ${qi(n.policies.insert)} ON ${x.sat}`,
    `CREATE POLICY ${qi(n.policies.insert)} ON ${x.sat} FOR INSERT WITH CHECK ${parent}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.update)} ON ${x.sat}`,
    `CREATE POLICY ${qi(n.policies.update)} ON ${x.sat} FOR UPDATE USING ${parent} WITH CHECK ${parent}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.delete)} ON ${x.sat}`,
    `CREATE POLICY ${qi(n.policies.delete)} ON ${x.sat} FOR DELETE USING ${parent}`,
    ...(writers.length > 0 ? [`GRANT INSERT, UPDATE, DELETE ON ${x.sat} TO ${grantList(writers)}`] : []),
  ]
}

/** Shown to a person, never executed by software. */
export function contractSql(facts: TableFacts, spec: ExtractionSpec, target: RenderTarget): string[] {
  const x = parts(facts, spec, target)
  const n = x.names
  return [
    `DROP TRIGGER IF EXISTS ${qi(n.reverse)} ON ${x.sat}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.reverse)}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${x.host}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.forward)}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.cascadeMark)} ON ${x.host}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.cascadeMark)}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.truncateGuard)} ON ${x.sat}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.truncateGuard)}()`,
    `ALTER TABLE ${x.host} ${x.m.map(c => `DROP COLUMN ${c}`).join(', ')}`,
  ]
}

// ── Rollback renderers ───────────────────────────────────────────────────────

export function dropSatelliteSql(spec: ExtractionSpec, target: RenderTarget): string[] {
  // RESTRICT, the default. Anything someone built on top of the satellite
  // makes this fail loudly rather than disappear with it.
  return [
    `DROP TABLE ${fq(target.schema, spec.satellite)}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, ladderNames(spec).truncateGuard)}()`,
  ]
}

export function dropForwardSyncSql(spec: ExtractionSpec, target: RenderTarget): string[] {
  const n = ladderNames(spec)
  return [
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${fq(target.schema, spec.host)}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.forward)}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.cascadeMark)} ON ${fq(target.schema, spec.host)}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.cascadeMark)}()`,
  ]
}

export function revokeReadsSql(spec: ExtractionSpec, target: RenderTarget, readers: string[]): string[] {
  const n = ladderNames(spec)
  const sat = fq(target.schema, spec.satellite)
  return [
    `DROP POLICY IF EXISTS ${qi(n.policies.select)} ON ${sat}`,
    ...(readers.length > 0 ? [`REVOKE SELECT ON ${sat} FROM ${grantList(readers)}`] : []),
  ]
}

export function closeWritesSql(spec: ExtractionSpec, target: RenderTarget, writers: string[]): string[] {
  const n = ladderNames(spec)
  const sat = fq(target.schema, spec.satellite)
  return [
    ...(writers.length > 0 ? [`REVOKE INSERT, UPDATE, DELETE ON ${sat} FROM ${grantList(writers)}`] : []),
    `DROP POLICY IF EXISTS ${qi(n.policies.insert)} ON ${sat}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.update)} ON ${sat}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.delete)} ON ${sat}`,
    `DROP TRIGGER IF EXISTS ${qi(n.reverse)} ON ${sat}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.reverse)}()`,
  ]
}

/** Every identifier a spec names, checked once. */
export function specProblem(spec: ExtractionSpec): string | null {
  for (const id of [spec.host, spec.satellite, ...spec.members]) {
    if (!IDENT.test(id)) return `"${id}" is not a valid identifier`
  }
  if (spec.satellite.startsWith(LADDER_OBJECT_PREFIX)) return `"${spec.satellite}" uses a reserved prefix`
  if (spec.satellite === spec.host) return 'the new table cannot have the same name as the host'
  if (new Set(spec.members).size !== spec.members.length) return 'a column is listed twice'
  return null
}
