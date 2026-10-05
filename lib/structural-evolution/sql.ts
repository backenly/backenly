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
 * Created with row-level security forced, one service-role policy, and every
 * grant revoked — including any a schema's default privileges handed out at
 * CREATE. Reads open later with a policy that says "you may see this row iff
 * you may see its parent", which is evaluated by running the parent's OWN
 * policy, so whatever rule protects `orders` protects `order_refunds` without
 * being restated. Writes are granted only to roles that may UPDATE the parent,
 * and the reverse sync performs that UPDATE as the caller, so the parent's
 * update policy is enforced on every satellite write. Writing a refund needs
 * exactly the permission it needed when the refund was a column.
 *
 * ── Sync: both directions, one guard ────────────────────────────────────────
 *
 * Forward (host → satellite) is SECURITY DEFINER and swallows its own errors,
 * like the maintenance dual-write: it mirrors a write the parent's policies
 * already allowed, and it must never abort a customer's write to the table they
 * have always written. Reconciliation is what catches it if it ever fails.
 *
 * Reverse (satellite → host) is SECURITY INVOKER and raises. It is the NEW path,
 * a client using it is new code, and refusing a write is strictly better than
 * letting the two representations disagree.
 *
 * The echo of each direction is suppressed by one transaction-local setting,
 * set immediately around the nested write and cleared immediately after — not
 * left set for the rest of the transaction, which would silently skip an
 * unrelated later statement in it.
 */

import { createHash } from 'node:crypto'
import { jwtClaimFunctionSql, serviceRoleClause, SERVICE_ROLE } from '@/lib/postgrest/rls-translation'
import { FAULT_TABLE } from '@/lib/autonomy/maintenance/primitives/dual-write'
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
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

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
  policies: { service: string; select: string; insert: string; update: string; delete: string }
  /** Custom GUC suppressing each direction's echo. */
  guc: string
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
    policies: { service: p('svc'), select: p('sel'), insert: p('ins'), update: p('upd'), delete: p('del') },
    guc: `bkn_evo.sync_${hash}`,
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
    svc: serviceRoleClause(target.schema),
  }
}

const rowOf = (alias: string, cols: string[]) => `ROW(${cols.map(c => `${alias}.${c}`).join(', ')})::text`
const allNull = (alias: string, cols: string[]) => cols.map(c => `${alias}.${c} IS NULL`).join(' AND ')
const anySet = (alias: string, cols: string[]) => `(${cols.map(c => `${alias}.${c} IS NOT NULL`).join(' OR ')})`

/** The parent-visibility predicate every satellite policy shares. */
function followsParent(x: ReturnType<typeof parts>): string {
  return `(${x.svc} OR EXISTS (SELECT 1 FROM ${x.host} h WHERE h.${x.pk} = ${x.satName}.${x.fk}))`
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
    jwtClaimFunctionSql(target.schema),
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
    `CREATE POLICY ${qi(n.policies.service)} ON ${x.sat} FOR ALL USING (${x.svc}) WITH CHECK (${x.svc})`,
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
  const body = [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    `RETURNS trigger`,
    `LANGUAGE plpgsql`,
    `SECURITY DEFINER`,
    `SET search_path = ${S}, pg_temp`,
    `AS $bkn$`,
    `DECLARE`,
    `  prev_claims text := current_setting('request.jwt.claims', true);`,
    `BEGIN`,
    `  -- The reverse direction is writing ${spec.host}; this is its echo.`,
    `  IF current_setting('${n.guc}', true) = '1' THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'UPDATE' AND ${rowOf('OLD', x.m)} IS NOT DISTINCT FROM ${rowOf('NEW', x.m)} THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  BEGIN`,
    `    PERFORM set_config('${n.guc}', '1', true);`,
    `    PERFORM set_config('request.jwt.claims', '{"role":"${SERVICE_ROLE}"}', true);`,
    `    IF ${allNull('NEW', x.m)} THEN`,
    `      DELETE FROM ${x.sat} WHERE ${x.fk} = NEW.${x.pk};`,
    `    ELSE`,
    `      INSERT INTO ${x.sat} AS s (${x.fk}, ${x.m.join(', ')})`,
    `      VALUES (NEW.${x.pk}, ${x.m.map(c => `NEW.${c}`).join(', ')})`,
    `      ON CONFLICT (${x.fk}) DO UPDATE SET ${x.m.map(c => `${c} = EXCLUDED.${c}`).join(', ')};`,
    `    END IF;`,
    `    PERFORM set_config('request.jwt.claims', COALESCE(prev_claims, ''), true);`,
    `    PERFORM set_config('${n.guc}', '', true);`,
    `  EXCEPTION WHEN OTHERS THEN`,
    `    -- The customer's write to ${spec.host} completes. Reconciliation is what`,
    `    -- notices the satellite fell behind; this only records that it knew.`,
    `    BEGIN`,
    `      INSERT INTO ${fq(target.schema, FAULT_TABLE)} AS f (object_name, faults, last_error, last_at)`,
    `      VALUES ('${n.forward}', 1, SQLERRM, now())`,
    `      ON CONFLICT (object_name) DO UPDATE`,
    `        SET faults = f.faults + 1, last_error = EXCLUDED.last_error, last_at = EXCLUDED.last_at;`,
    `    EXCEPTION WHEN OTHERS THEN`,
    `      NULL;`,
    `    END;`,
    `  END;`,
    `  RETURN NULL;`,
    `END;`,
    `$bkn$`,
  ].join('\n')
  return [
    `CREATE TABLE IF NOT EXISTS ${fq(target.schema, FAULT_TABLE)} (\n` +
      `  object_name text PRIMARY KEY,\n  faults bigint NOT NULL DEFAULT 0,\n  last_error text,\n  last_at timestamptz\n)`,
    body,
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${x.host}`,
    `CREATE TRIGGER ${qi(n.forward)} AFTER INSERT OR UPDATE OF ${x.m.join(', ')} ON ${x.host} ` +
      `FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  ]
}

/**
 * One backfill batch. `$1` is the cursor as text, NULL for the first batch.
 *
 * The batch's host rows are taken `FOR SHARE`. Without that a write landing
 * between this batch reading a row and upserting it would be overwritten by the
 * stale copy — the forward trigger would have mirrored the new value, and the
 * backfill would then mirror the old one over it. The lock makes such a writer
 * wait one batch, which is why batches are small.
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
    `   FOR SHARE OF h`,
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
    `       (SELECT k::text FROM batch ORDER BY k DESC LIMIT 1) AS next_cursor`,
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
    `BEGIN`,
    `  -- The forward direction is writing ${spec.satellite}; this is its echo.`,
    `  IF current_setting('${n.guc}', true) = '1' THEN`,
    `    RETURN NULL;`,
    `  END IF;`,
    `  IF TG_OP = 'UPDATE' AND NEW.${x.fk} IS DISTINCT FROM OLD.${x.fk} THEN`,
    `    RAISE EXCEPTION '${spec.satellite}.${n.fkColumn} cannot change while ${spec.host} still carries these columns; delete and insert instead'`,
    `      USING ERRCODE = '0A000';`,
    `  END IF;`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    k := OLD.${x.fk};`,
    `  ELSE`,
    `    k := NEW.${x.fk};`,
    `  END IF;`,
    `  PERFORM set_config('${n.guc}', '1', true);`,
    `  IF TG_OP = 'DELETE' THEN`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NULL`).join(', ')} WHERE ${x.pk} = k;`,
    `  ELSE`,
    `    UPDATE ${x.host} SET ${x.m.map(c => `${c} = NEW.${c}`).join(', ')} WHERE ${x.pk} = k;`,
    `  END IF;`,
    `  GET DIAGNOSTICS n = ROW_COUNT;`,
    `  PERFORM set_config('${n.guc}', '', true);`,
    `  -- Run as the caller, so ${spec.host}'s own update policy decided. Zero rows`,
    `  -- on a parent the caller can see means that policy said no. A DELETE whose`,
    `  -- parent is gone is the cascade from deleting the parent, and is fine.`,
    `  IF n = 0 AND (TG_OP <> 'DELETE' OR EXISTS (SELECT 1 FROM ${x.host} WHERE ${x.pk} = k)) THEN`,
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
    `DROP TRIGGER IF EXISTS ${qi(n.reverse)} ON ${x.sat}`,
    `CREATE TRIGGER ${qi(n.reverse)} AFTER INSERT OR UPDATE OR DELETE ON ${x.sat} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    `CREATE POLICY ${qi(n.policies.insert)} ON ${x.sat} FOR INSERT WITH CHECK ${parent}`,
    `CREATE POLICY ${qi(n.policies.update)} ON ${x.sat} FOR UPDATE USING ${parent} WITH CHECK ${parent}`,
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
    `ALTER TABLE ${x.host} ${x.m.map(c => `DROP COLUMN ${c}`).join(', ')}`,
  ]
}

// ── Rollback renderers ───────────────────────────────────────────────────────

export function dropSatelliteSql(spec: ExtractionSpec, target: RenderTarget): string[] {
  // RESTRICT, the default. Anything someone built on top of the satellite
  // makes this fail loudly rather than disappear with it.
  return [`DROP TABLE ${fq(target.schema, spec.satellite)}`]
}

export function dropForwardSyncSql(spec: ExtractionSpec, target: RenderTarget): string[] {
  const n = ladderNames(spec)
  return [
    `DROP TRIGGER IF EXISTS ${qi(n.forward)} ON ${fq(target.schema, spec.host)}`,
    `DROP FUNCTION IF EXISTS ${fq(target.schema, n.forward)}()`,
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
