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
 *     order_id    <pk>  unique, FK → orders    NO ACTION, DEFERRABLE INITIALLY DEFERRED
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
 * The foreign key takes no referential action while both representations
 * exist: deleting or re-keying an order is followed by the forward sync, as
 * the owner, which is how the reverse sync tells the sync's own writes from a
 * client's without trusting anything a session can set. It is deferred so it
 * is checked against the state the sync leaves at commit. `contract` gives it
 * the actions a column of the host had (deleting or re-keying the parent
 * carries the row).
 *
 * Defaults are not carried, deliberately: writing a refund through the new table
 * corresponds to UPDATE-ing the order, and an UPDATE never applies defaults.
 *
 * ── Constraints: the host enforces all of them until `contract` ─────────────
 *
 * Every satellite row comes from the host (forward sync, backfill) or reaches
 * the host as the caller before it commits (reverse sync), so the host's own
 * constraints decide what both tables may hold, at the moment and as the role
 * they always did. The satellite carries only what has provably the same
 * meaning on a subset of the host's rows — validated CHECK, UNIQUE and EXCLUDE
 * constraints verbatim from pg_get_constraintdef, and indexes — and so can
 * never refuse a write the host accepted. Foreign keys and NOT VALID
 * constraints on the members stay with the host and are re-created exactly by
 * `contract` (see `carriedObjects`).
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
 * its own policy, and a parent whose policies do not, does not. Writes are
 * granted only to roles that may UPDATE the parent, and the reverse sync
 * performs that UPDATE as the caller, so the parent's update policy is
 * enforced on every satellite write. Writing a refund needs exactly the
 * permission it needed when the refund was a column.
 *
 * The ladder's own complete view of the HOST is two permissive policies on it
 * for the platform role, SELECT and (lock-only) UPDATE, each admitting it only
 * in the same ladder context. Permissive policies are OR-ed, so they add rows to
 * that one view and change no other session's. A RESTRICTIVE policy binds them
 * too; when one would hide rows from the ladder, the plan is blocked, and if
 * one appears later the backfill stops and reconciliation says it could not
 * see every row instead of calling a partial view consistent (`hostVisibility`
 * in ./reconcile).
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
 *                                the writer's transaction. It mirrors the row
 *                                AS STORED — after every BEFORE trigger — on
 *                                every UPDATE whose stored members or key
 *                                changed, whatever the statement named, and on
 *                                INSERT and DELETE. It follows a re-keyed or
 *                                deleted parent itself. Any error ABORTS the
 *                                writer's statement: a swallowed deadlock or
 *                                lock timeout would commit the host write
 *                                without its mirror.
 *   reverse  (satellite → host)  AFTER ROW on the satellite, SECURITY INVOKER,
 *                                applies the write to the host as the caller.
 *                                Zero rows on a parent means its update policy
 *                                said no (or a rule on it skipped the update):
 *                                raised as 42501, and the satellite write
 *                                aborts with it. It marks the key it wrote, so
 *                                the forward sync runs for that row even when
 *                                the host's own triggers kept it exactly as it
 *                                was, and the satellite ends holding what the
 *                                host stored, not what the client sent.
 *
 * Authority: until a person runs `contract`, the HOST is the source of truth
 * and the satellite is a projection of it that also accepts writes. A satellite
 * write that did not reach the host did not happen (it aborted). If the two
 * ever disagree anyway — by bypassing triggers (`session_replication_role =
 * replica`, `ALTER TABLE … DISABLE TRIGGER`), which only an owner or a
 * superuser can do — reconciliation reports it, the ladder stops (`blocked`),
 * rollback refuses, and nothing is "repaired" by software guessing which side
 * was meant.
 *
 * ── What a session can and cannot forge ─────────────────────────────────────
 *
 * Every guard here is a custom setting, and any session may set one. None of
 * them is trusted to stand for an identity:
 *
 *   echo guard     honoured only inside a trigger (`pg_trigger_depth() > 1`)
 *                  AND as the role the forward sync runs as — its function's
 *                  owner, the platform — which a client's own statement never
 *                  is at that depth, and which the SECURITY DEFINER forward
 *                  sync always is when it writes the satellite. It names the
 *                  function's owner, not the table's: a project with read-write
 *                  direct access has every table it holds handed to its own
 *                  owner role (backenly_direct_sync_schema), which the platform
 *                  is a member of but is not. Set by hand, the guard skips
 *                  nothing: the write still reaches the parent's update policy.
 *   settle mark    makes the forward sync mirror one host row as stored. That
 *                  is the invariant itself; forged, it makes the two equal.
 *   ladder context admits the platform role to the satellite and to every host
 *                  row. Only a session that can already run arbitrary SQL AS
 *                  the platform role can set it, and that session can equally
 *                  claim the service role or disable triggers: the owner is
 *                  the trust boundary, and nothing that serves a client sets it.
 *   truncate mark  lets a TRUNCATE of the satellite through when it is the
 *                  cascade of truncating the host. Only the owner may truncate
 *                  the satellite at all; the guard stops accidents, not owners.
 *
 * The forward sync is the one function that runs as the owner, so it is the
 * one door worth guarding: EXECUTE on every function the ladder installs is
 * the owner's alone (PostgreSQL grants it to PUBLIC by default, and a role that
 * may EXECUTE a trigger function may attach it to a TEMP table of its own), and
 * the forward sync refuses to run for any table but the one its satellite's
 * foreign key references.
 *
 * Every function the ladder installs runs as the platform — the forward sync
 * always, the others whenever the platform writes, which is how the runtime
 * serves end users — so none may resolve a name against the workspace schema:
 * a project with read-write direct access may create functions and operators
 * there, and one that matched better than a built-in would run as the
 * platform. They run with `search_path` = `pg_catalog, pg_temp` (FUNCTION_PATH)
 * and name every workspace object in full, and a host whose primary key does
 * not compare with a built-in operator is not planned at all.
 *
 * ── Concurrency, case by case ──────────────────────────────────────────────
 *
 * Lock order: an old writer locks host row → satellite row; a new writer
 * locks satellite row → host row (the reverse sync); the backfill share-locks
 * host rows → satellite rows and never WAITS for a host row (NOWAIT).
 *
 *   old vs old (same row)    host row lock serialises them; each forward
 *                            mirror writes every member as stored, so the
 *                            later committer wins in both places
 *   new vs new (same row)    satellite row lock serialises them; the reverse
 *                            sync writes every member, later committer wins
 *   old vs new (same row)    usually serialised by whichever lock is taken
 *                            first. The crossing case — each holding one and
 *                            wanting the other — is a deadlock; PostgreSQL
 *                            aborts one WHOLE transaction (40P01) and the
 *                            survivor's value lands in both
 *   backfill vs writers      the batch share-locks its host rows with NOWAIT,
 *                            so a row being written makes the batch retry
 *                            instead of waiting; a backfill can therefore never
 *                            be part of a deadlock cycle, and a writer waits at
 *                            most one batch. The lock also stops a stale copy
 *                            overwriting a newer mirror.
 *   echo                     the forward sync sets its guard immediately around
 *                            its own write and restores it right after, not for
 *                            the rest of the transaction, which would skip an
 *                            unrelated later statement; inside a savepoint that
 *                            is rolled back, PostgreSQL restores the setting
 *   parent key changes       the forward sync re-keys the satellite row itself,
 *                            as the owner; a client moving a row to another
 *                            parent is refused (0A000)
 *   deletes                  deleting a parent: the forward sync deletes its
 *                            satellite row. Deleting a satellite row otherwise
 *                            clears the parent's members, as the caller, or is
 *                            refused (42501) — never decided by whether the
 *                            caller can SEE the parent: through row-level
 *                            security a hidden parent and a deleted one look
 *                            alike
 *   TRUNCATE                 refused on the satellite alone (row triggers do
 *                            not fire for it, so it would silently diverge);
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
  /**
   * The forward sync: one SECURITY DEFINER function on the host, fired AFTER
   * UPDATE (when the key or a member changed in the stored row, or the reverse
   * sync is settling that row) by this trigger, and AFTER INSERT OR DELETE by
   * `forwardRows`.
   */
  forward: string
  forwardRows: string
  reverse: string
  /** Statement trigger + function refusing TRUNCATE on the satellite, unless its host is being truncated. */
  truncateGuard: string
  /** Statement trigger + function on the host marking a TRUNCATE of it, so the guard lets its CASCADE through. */
  hostTruncate: string
  /** Statement-scoped setting `hostTruncate` writes and `truncateGuard` reads. */
  truncating: string
  policies: {
    owner: string
    select: string
    insert: string
    update: string
    delete: string
    /** On the HOST: the platform reads every row, and may lock it, only inside the ladder's own context. */
    hostRead: string
    hostLock: string
  }
  /** Custom GUC suppressing each direction's echo. */
  guc: string
  /**
   * Transaction-local GUC the reverse sync sets to the key it writes, so the
   * forward sync runs for that row even when the host kept it as it was (its
   * own trigger overrode the value written through the satellite).
   */
  settle: string
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
    forwardRows: p('fwr'),
    reverse: p('rev'),
    truncateGuard: p('trunc'),
    hostTruncate: p('htr'),
    truncating: `bkn_evo.truncating_${hash}`,
    policies: {
      owner: p('own'),
      select: p('sel'),
      insert: p('ins'),
      update: p('upd'),
      delete: p('del'),
      hostRead: p('hsee'),
      hostLock: p('hlck'),
    },
    guc: `bkn_evo.sync_${hash}`,
    settle: `bkn_evo.settle_${hash}`,
    access: `bkn_evo.access_${hash}`,
    carriedConstraint: i => `${p('ck')}_${i}`,
    carriedIndex: i => `${p('ix')}_${i}`,
  }
}

// ── What travels with the columns ────────────────────────────────────────────

export interface CarriedObjects {
  constraints: Array<{ name: string; from: string; definition: string }>
  indexes: Array<{ name: string; from: string; definition: string }>
  /**
   * Constraints on the members that the host alone enforces while both
   * representations exist, and that `contract` re-creates on the satellite
   * exactly as the host has them (definition from pg_get_constraintdef).
   */
  deferred: Array<{ name: string; from: string; definition: string }>
  /** Objects on the members that are NOT carried, and why. */
  notCarried: string[]
}

const INDEXDEF = /^CREATE (UNIQUE )?INDEX (\S+) ON (?:ONLY )?(\S+) USING ([\s\S]+)$/

/**
 * Constraints and indexes that read ONLY the members.
 *
 * While both representations exist the HOST enforces every constraint: every
 * satellite row comes from the host (forward sync, backfill) or reaches the
 * host as the caller before it commits (reverse sync). So the satellite only
 * carries what has provably the same meaning on a subset of the host's rows,
 * where it can never refuse a write the host accepted:
 *
 *   carried    validated CHECK, UNIQUE and EXCLUDE constraints (verbatim from
 *              pg_get_constraintdef, so DEFERRABLE / INITIALLY DEFERRED and
 *              NULLS NOT DISTINCT survive), and indexes; the satellite's rows
 *              and values are a subset of the host's, so these are never
 *              stricter there
 *   deferred   foreign keys (their timing, MATCH type, NOT VALID state and
 *              referential actions would run a second time, at another moment,
 *              as another role) and every NOT VALID constraint (the backfill
 *              inserts rows such a constraint never checked): left to the host,
 *              and re-created exactly by `contract`
 *
 * Verbatim is safe because member names are kept: `CHECK ((refund_amount >=
 * 0))` means the same thing on either table. Anything that also reads a
 * column staying behind stays behind with it, and keeps working, because
 * expand never removes the column it reads.
 */
export function carriedObjects(
  facts: TableFacts,
  spec: ExtractionSpec,
  names: LadderNames,
  target: RenderTarget,
): CarriedObjects {
  const set = new Set(spec.members)
  const within = (cols: string[]) => cols.length > 0 && cols.every(c => set.has(c))
  const out: CarriedObjects = { constraints: [], indexes: [], deferred: [], notCarried: [] }
  let ci = 0
  for (const k of facts.constraints) {
    if (!within(k.columns) || k.name.startsWith(LADDER_OBJECT_PREFIX)) continue
    if (k.kind === 'f' || !k.validated) {
      out.deferred.push({ name: k.name, from: k.name, definition: k.definition })
      out.notCarried.push(
        `${k.name}: ${k.kind === 'f' ? 'a foreign key' : 'not validated (NOT VALID)'}; ${spec.host} keeps enforcing it ` +
          `while both tables exist, and the final step re-creates it on ${spec.satellite} exactly as it is`,
      )
    } else if (k.kind === 'c' || k.kind === 'u' || k.kind === 'x') {
      out.constraints.push({ name: names.carriedConstraint(ci++), from: k.name, definition: k.definition })
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

/**
 * The search path of every function the ladder installs: built-ins, then the
 * session's own temporary objects for relations only. Never the workspace
 * schema, where a project role may create objects (see the header).
 */
const FUNCTION_PATH = 'pg_catalog, pg_temp'

/**
 * Only the owner may EXECUTE a function the ladder installs. PostgreSQL grants
 * EXECUTE to PUBLIC on every new function, and a role that may EXECUTE a
 * trigger function may attach it to a table of its own — a TEMP table needs
 * nothing but the database's default TEMP privilege. For the SECURITY DEFINER
 * forward sync that would be a door into the satellite as its owner, past its
 * row-level security, from any role that can run SQL. Firing a trigger checks
 * no privilege, so the ladder's own triggers are unaffected. Whatever a
 * schema's default privileges granted is revoked too.
 */
function ownerOnlySql(fn: string): string {
  const sig = `${lit(`${fn}()`)}::regprocedure`
  return [
    `DO $bkn$`,
    `DECLARE g record;`,
    `BEGIN`,
    `  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', ${sig});`,
    `  FOR g IN SELECT DISTINCT quote_ident(pg_get_userbyid(x.grantee)) AS who`,
    `             FROM pg_proc p, aclexplode(p.proacl) x`,
    `            WHERE p.oid = ${sig} AND x.grantee <> p.proowner AND x.grantee <> 0`,
    `  LOOP`,
    `    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', ${sig}, g.who);`,
    `  END LOOP;`,
    `END $bkn$`,
  ].join('\n')
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
      // No referential action: the forward sync deletes and re-keys the row
      // itself, as the owner, so the reverse sync can tell those apart from a
      // client's write without trusting anything a session can set. Deferred,
      // so the check meets the state the forward sync leaves at commit. It
      // also states the relationship, which is how REST clients embed it.
      `  CONSTRAINT ${qi(n.fk)} FOREIGN KEY (${x.fk}) REFERENCES ${x.host} (${x.pk}) DEFERRABLE INITIALLY DEFERRED,`,
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
    // Row triggers do not fire for TRUNCATE, so emptying the satellite alone
    // would leave the host carrying values the satellite silently lost. Only
    // the cascade of truncating the host itself is let through: the host's
    // own BEFORE TRUNCATE trigger marks this statement (see forwardSyncSql).
    // Only the owner may truncate the satellite at all, and the owner could
    // equally drop this guard: it stops accidents, not owners.
    [
      `CREATE OR REPLACE FUNCTION ${fq(target.schema, n.truncateGuard)}()`,
      `RETURNS trigger`,
      `LANGUAGE plpgsql`,
      `SET search_path = ${FUNCTION_PATH}`,
      `AS $bkn$`,
      `BEGIN`,
      `  IF current_setting('${n.truncating}', true) = statement_timestamp()::text THEN`,
      `    RETURN NULL;`,
      `  END IF;`,
      `  RAISE EXCEPTION '${spec.satellite} mirrors ${spec.host} and cannot be truncated on its own; truncate ${spec.host} with CASCADE, or delete rows, each delete reaches ${spec.host}'`,
      `    USING ERRCODE = '0A000';`,
      `END;`,
      `$bkn$`,
    ].join('\n'),
    ownerOnlySql(fq(target.schema, n.truncateGuard)),
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
  const fn = fq(target.schema, n.forward)
  const satRegclass = lit(`${qi(target.schema)}.${qi(spec.satellite)}`)
  const ladder = ladderOnly(n)
  const body = [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SECURITY DEFINER`,
    `SET search_path = ${FUNCTION_PATH}`,
    `AS $bkn$`,
    `DECLARE`,
    `  prior_access text;`,
    `  prior_guard text;`,
    `BEGIN`,
    `  -- Removed outside the ladder: there is no second representation left to`,
    `  -- disagree with, and the customer's write goes through.`,
    `  IF to_regclass(${satRegclass}) IS NULL THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  -- Runs as the owner, so it runs for the host and nothing else: the table`,
    `  -- the satellite's own foreign key references, after each row. EXECUTE is`,
    `  -- the owner's alone; this holds even if someone grants it again.`,
    `  IF TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' OR NOT EXISTS (`,
    `       SELECT 1 FROM pg_constraint c`,
    `        WHERE c.conrelid = to_regclass(${satRegclass}) AND c.conname = ${lit(n.fk)} AND c.contype = 'f' AND c.confrelid = TG_RELID) THEN`,
    `    RAISE EXCEPTION '${n.forward} fires only for ${spec.host}, after each row' USING ERRCODE = '42501';`,
    `  END IF;`,
    `  IF TG_OP = 'INSERT' AND ${allNull('NEW', x.m)} THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'DELETE' AND ${allNull('OLD', x.m)} THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  -- NEW is the row as stored, after every BEFORE trigger of ${spec.host}:`,
    `  -- the satellite follows what the host committed, not what the statement`,
    `  -- named. A host AFTER trigger that writes the row again fires this again.`,
    `  -- No exception handler, on purpose: if the mirror cannot be written, the`,
    `  -- write to ${spec.host} does not commit either.`,
    `  -- Runs as the satellite's owner (SECURITY DEFINER), in the ladder's own`,
    `  -- context, which its policy admits; both settings are restored after.`,
    `  prior_access := current_setting('${n.access}', true);`,
    `  prior_guard := current_setting('${n.guc}', true);`,
    `  PERFORM set_config('${n.access}', 'on', true);`,
    `  PERFORM set_config('${n.guc}', '1', true);`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    DELETE FROM ${x.sat} WHERE ${x.fk} = OLD.${x.pk};`,
    `  ELSE`,
    `    IF TG_OP = 'UPDATE' AND NEW.${x.pk} IS DISTINCT FROM OLD.${x.pk} THEN`,
    `      UPDATE ${x.sat} SET ${x.fk} = NEW.${x.pk} WHERE ${x.fk} = OLD.${x.pk};`,
    `    END IF;`,
    `    IF ${allNull('NEW', x.m)} THEN`,
    `      DELETE FROM ${x.sat} WHERE ${x.fk} = NEW.${x.pk};`,
    `    ELSE`,
    `      INSERT INTO ${x.sat} AS s (${x.fk}, ${x.m.join(', ')})`,
    `      VALUES (NEW.${x.pk}, ${x.m.map(c => `NEW.${c}`).join(', ')})`,
    `      ON CONFLICT (${x.fk}) DO UPDATE SET ${x.m.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
    `       WHERE ${rowOf('s', x.m)} IS DISTINCT FROM ${rowOf('EXCLUDED', x.m)};`,
    `    END IF;`,
    `  END IF;`,
    `  PERFORM set_config('${n.guc}', COALESCE(prior_guard, ''), true);`,
    `  PERFORM set_config('${n.access}', COALESCE(prior_access, ''), true);`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  const truncate = fq(target.schema, n.hostTruncate)
  const truncateBody = [
    `CREATE OR REPLACE FUNCTION ${truncate}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SET search_path = ${FUNCTION_PATH}`,
    `AS $bkn$`,
    `BEGIN`,
    `  -- ${spec.host} is being truncated in this statement: its CASCADE may`,
    `  -- empty ${spec.satellite} with it (see the satellite's truncate guard).`,
    `  PERFORM set_config('${n.truncating}', statement_timestamp()::text, true);`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  // Compared as text: a member's type may have no equality operator (json),
  // and a trigger's WHEN that cannot be planned fails CREATE TRIGGER.
  const changed =
    `ROW(OLD.${x.pk}, ${x.m.map(c => `OLD.${c}`).join(', ')})::text IS DISTINCT FROM ` +
    `ROW(NEW.${x.pk}, ${x.m.map(c => `NEW.${c}`).join(', ')})::text`
  const settling = `current_setting(${lit(n.settle)}, true) = NEW.${x.pk}::text`
  return [
    // Backenly's own complete view of the host: every row, readable and
    // lockable by the platform role ONLY inside the ladder's context, which
    // nothing serving a client ever sets. Permissive policies are OR-ed, so
    // this adds rows to that one view and changes no other session's. It
    // cannot see past a RESTRICTIVE policy; see hostVisibility in ./reconcile.
    `DROP POLICY IF EXISTS ${qi(n.policies.hostRead)} ON ${x.host}`,
    `CREATE POLICY ${qi(n.policies.hostRead)} ON ${x.host} FOR SELECT TO CURRENT_USER USING ${ladder}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.hostLock)} ON ${x.host}`,
    `CREATE POLICY ${qi(n.policies.hostLock)} ON ${x.host} FOR UPDATE TO CURRENT_USER USING ${ladder} WITH CHECK (false)`,
    body,
    ownerOnlySql(fn),
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${x.host}`,
    // Every UPDATE, not only those naming a member: a BEFORE trigger may set
    // one the statement never named. The WHEN keeps unrelated updates cheap
    // and off the satellite's rows. It also fires for the row a write through
    // the satellite is settling, whose host row may not have changed at all.
    `CREATE TRIGGER ${qi(n.forward)} AFTER UPDATE ON ${x.host} FOR EACH ROW WHEN (${changed} OR ${settling}) EXECUTE FUNCTION ${fn}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.forwardRows)} ON ${x.host}`,
    `CREATE TRIGGER ${qi(n.forwardRows)} AFTER INSERT OR DELETE ON ${x.host} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    truncateBody,
    ownerOnlySql(truncate),
    `DROP TRIGGER IF EXISTS ${qi(n.hostTruncate)} ON ${x.host}`,
    `CREATE TRIGGER ${qi(n.hostTruncate)} BEFORE TRUNCATE ON ${x.host} FOR EACH STATEMENT EXECUTE FUNCTION ${truncate}()`,
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
  const fn = fq(target.schema, n.reverse)
  const body = [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SET search_path = ${FUNCTION_PATH}`,
    `AS $bkn$`,
    `DECLARE`,
    `  n bigint;`,
    `  k ${x.sat}.${x.fk}%TYPE;`,
    `  prior_settle text;`,
    `BEGIN`,
    `  -- The forward sync writing ${spec.satellite}: mirroring the host, or`,
    `  -- following a parent that was deleted or re-keyed. It alone is ALL of:`,
    `  -- inside a trigger, running as its own function's owner (SECURITY`,
    `  -- DEFINER), with its guard set. A client's own write runs at depth 1;`,
    `  -- no setting a session can write makes it look like the sync.`,
    `  IF current_setting('${n.guc}', true) = '1' AND pg_trigger_depth() > 1`,
    `     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p`,
    `                          WHERE p.oid = to_regprocedure(${lit(`${fq(target.schema, n.forward)}()`)})) THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'UPDATE' AND NEW.${x.fk} IS DISTINCT FROM OLD.${x.fk} THEN`,
    `    RAISE EXCEPTION '${spec.satellite}.${n.fkColumn} cannot change while ${spec.host} still carries these columns; delete and insert instead'`,
    `      USING ERRCODE = '0A000';`,
    `  END IF;`,
    `  k := CASE WHEN TG_OP = 'DELETE' THEN OLD.${x.fk} ELSE NEW.${x.fk} END;`,
    `  -- ${spec.host} is the authority, and its own triggers may store something`,
    `  -- other than what was written here, or keep the row exactly as it was.`,
    `  -- Marking the key makes the forward sync run for this row either way, so`,
    `  -- ${spec.satellite} ends holding what ${spec.host} stored. Anyone may set`,
    `  -- the mark; all it can make the forward sync do is make the two equal.`,
    `  prior_settle := current_setting('${n.settle}', true);`,
    `  PERFORM set_config('${n.settle}', k::text, true);`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NULL`).join(', ')} WHERE ${x.pk} = k;`,
    `  ELSE`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NEW.${c}`).join(', ')} WHERE ${x.pk} = k;`,
    `  END IF;`,
    `  GET DIAGNOSTICS n = ROW_COUNT;`,
    `  PERFORM set_config('${n.settle}', COALESCE(prior_settle, ''), true);`,
    `  -- Run as the caller, so ${spec.host}'s own update policy decided: zero rows`,
    `  -- means it said no, there is no such parent, or a rule on ${spec.host}`,
    `  -- skipped the update; the satellite write aborts with it.`,
    `  IF n = 0 THEN`,
    `    RAISE EXCEPTION 'permission denied: this change to ${spec.satellite} changes ${spec.host} row %, which the caller may not update', k`,
    `      USING ERRCODE = '42501';`,
    `  END IF;`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  const parent = followsParent(x)
  return [
    body,
    ownerOnlySql(fn),
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

/**
 * Shown to a person, never executed by software. After it the satellite is
 * the only representation: the syncs, Backenly's own host policies and the
 * truncate guard go, the parent link takes the referential actions a row of
 * the host had (deleting or re-keying the parent carries the row), the
 * constraints the host enforced on these columns until now are re-created
 * exactly, and the columns leave the host.
 */
export function contractSql(facts: TableFacts, spec: ExtractionSpec, target: RenderTarget): string[] {
  const x = parts(facts, spec, target)
  const n = x.names
  const carried = carriedObjects(facts, spec, n, target)
  return [
    `DROP TRIGGER IF EXISTS ${qi(n.reverse)} ON ${x.sat}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.reverse)}()`,
    ...dropForwardSyncSql(spec, target),
    `DROP TRIGGER IF EXISTS ${qi(n.truncateGuard)} ON ${x.sat}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.truncateGuard)}()`,
    `ALTER TABLE ${x.sat} DROP CONSTRAINT ${qi(n.fk)}, ` +
      `ADD CONSTRAINT ${qi(n.fk)} FOREIGN KEY (${x.fk}) REFERENCES ${x.host} (${x.pk}) ON DELETE CASCADE ON UPDATE CASCADE`,
    ...carried.deferred.map(d => `ALTER TABLE ${x.sat} ADD CONSTRAINT ${qi(d.name)} ${d.definition}`),
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

/** Everything the ladder put on the HOST: the forward sync, the truncate mark, Backenly's own read policies. */
export function dropForwardSyncSql(spec: ExtractionSpec, target: RenderTarget): string[] {
  const n = ladderNames(spec)
  const host = fq(target.schema, spec.host)
  return [
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${host}`,
    `DROP TRIGGER IF EXISTS ${qi(n.forwardRows)} ON ${host}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.forward)}()`,
    `DROP TRIGGER IF EXISTS ${qi(n.hostTruncate)} ON ${host}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.hostTruncate)}()`,
    `DROP POLICY IF EXISTS ${qi(n.policies.hostRead)} ON ${host}`,
    `DROP POLICY IF EXISTS ${qi(n.policies.hostLock)} ON ${host}`,
  ]
}

/** The host-side objects the ladder added, by name: all present, or the sync is not live. */
export function hostLadderObjects(spec: ExtractionSpec): { triggers: string[]; policies: string[] } {
  const n = ladderNames(spec)
  return { triggers: [n.forward, n.forwardRows, n.hostTruncate], policies: [n.policies.hostRead, n.policies.hostLock] }
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
