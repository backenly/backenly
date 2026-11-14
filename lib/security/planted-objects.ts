/**
 * CODE A PROJECT PLANTED IN ITS SCHEMA, FOUND AND SWITCHED OFF
 * ============================================================
 *
 * Until a read-write direct-access login was held to rows on a shared database
 * (scripts/setup-direct-access.sql, section 5c), one whose admin allowed schema
 * changes could create code in its workspace schema: functions, triggers,
 * policies, views, rules, operators, column defaults. That code runs in
 * whichever session touches those objects, and on a database shared by several
 * projects the sessions that touch every project's tables are shared: the
 * application role, a member of every project's owner role, and PostgREST's
 * authenticated and service_role, which hold DML on every workspace it serves.
 * A trigger a project planted on its own table therefore ran with access to all
 * the others whenever the platform wrote that table, and switching role inside
 * it does not help: PostgreSQL checks SET ROLE against the session user.
 *
 * This finds that code in each project schema of a database (the project's
 * own, its preview branches, its change vaults) and switches it off without
 * dropping a table, a column or a row:
 *
 *   triggers   on a table, disabled (ALTER TABLE ... DISABLE TRIGGER); on a
 *              view, where PostgreSQL cannot disable one, dropped.
 *   rules      the same: disabled on a table, dropped on a view.
 *   routines   EXECUTE taken from PUBLIC, from their owner and from every role
 *              granted it, so a shared session that reaches one fails with
 *              "permission denied for function" instead of running it.
 *              PostgreSQL checks that privilege when a policy, a view, a column
 *              default, a constraint, an index expression, a rule or an operator
 *              calls the function, but not when a trigger fires it, hence the
 *              triggers above. One that is SECURITY DEFINER and would run as a
 *              role reaching other projects is made SECURITY INVOKER too.
 *
 * Whatever else calls such a routine (a policy, a view, a default, a
 * constraint, an index, an operator, a cast) is reported: it now fails closed
 * rather than runs.
 *
 * ── Expressions that call something no privilege of the project's can stop ──
 *
 * A column default, a generated column, a check constraint, a domain's default
 * or check, a policy, a view or a trigger's WHEN condition runs its functions
 * in whichever session reaches it, and a function of the platform's runs there
 * with the platform's role: a default calling
 * public.backenly_direct_sync_schema('workspace_B', NULL, '<A's login>', NULL)
 * gave project A's login project B's tables the moment the platform inserted a
 * row. Revoking the project's own routines cannot stop that, so each such
 * expression is read in the catalog (its stored tree names every function and
 * relation it reaches by object id) and is planted when it calls a function
 * outside what may run there, or reads a relation outside its own project:
 *
 *   - a built-in PostgreSQL declares immutable or stable, except those that
 *     run SQL handed to them as text (the *_to_xml family, two-argument
 *     ts_rewrite, ts_stat) or read other sessions, files or objects by name
 *     (pg_stat_*, pg_get_*, pg_read_*, pg_ls_*, lo_*);
 *   - a volatile built-in that only makes a value (nextval, gen_random_uuid,
 *     random, clock_timestamp and the like), and nothing else volatile:
 *     set_config, pg_notify, setval and the rest change something;
 *   - the immutable and stable functions of extensions that only compute
 *     (citext, pg_trgm, vector...), and every function of pgcrypto and
 *     uuid-ossp;
 *   - a function in one of the project's own schemas: Backenly's claim reader,
 *     or the project's own routines, which are switched off above.
 *
 * Switched off as a person would want a table left: a default is dropped, a
 * generated column becomes an ordinary one with its values kept, a check is
 * dropped, a policy's expression becomes `false` (its table held to Backenly's
 * closed rule, service-role keys only, when no rule of Backenly's is left on
 * it), and a view is replaced by an empty one with the same columns. A
 * materialized view, which runs its query only when refreshed, as its owner,
 * is reported for a person.
 *
 * ── Who wrote it ─────────────────────────────────────────────────────────────
 *
 * Backenly's own code in a workspace schema is a closed set, made by the
 * platform's role: set_updated_at and the trg_set_updated_at_<table> triggers
 * that run it (lib/ai/minimal-executor.ts), backenly_jwt_claim
 * (lib/postgrest/rls-translation.ts), the realtime, presence and webhook-capture
 * functions and triggers (lib/realtime/channel-sql.ts, lib/changes/catalog.ts),
 * and the bkn_dw_, bkn_sync_ and bkn_evo_ objects of the maintenance ladder,
 * derived columns and architecture changes. It makes no rule, and a view only
 * when a restore puts back one that was there. So an object is a project's when:
 *
 *   - a direct-access or function login (bkn_ro_, bkn_rw_, bkn_fn_) owns it;
 *   - the project's owner role (bkn_own_) owns it and it is a routine: the sync
 *     hands that role tables and views, never code, so a routine it owns was
 *     made by a login acting as it;
 *   - a role that is neither Backenly's nor a superuser owns it;
 *   - Backenly's role owns it and it is not in Backenly's set. Ownership alone
 *     cannot say who wrote it: revoking a login hands what it owned to the
 *     platform role (backenly_direct_drop_role), a branch copies a schema as
 *     the platform role, and a snapshot restore replays one as it;
 *   - the drift ledger (public.schema_drift_events) records a direct-access
 *     login creating it.
 *
 * A trigger is a project's unless it is one of Backenly's by name, runs the
 * function of Backenly's its name goes with, and has no WHEN condition (an
 * architecture change's bkn_evo_ triggers excepted, whose condition must call
 * nothing above). A rule is always a project's.
 *
 * Definitions are read and matched in the database that holds them: what
 * leaves it is kinds, names, owners and the names of the functions and
 * relations found, never a definition (lib/changes/residency.ts says why a
 * regional project's words stay in its region). scripts/neutralize-planted-objects.ts
 * runs this in every region, and a snapshot restore runs it again for the
 * project it restored (lib/services/workspace-backup.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { CAPTURE_TRIGGER, PLATFORM_OBJECTS } from '@/lib/changes/catalog'
import { SECURITY_CHANGE_GROUP } from '@/lib/changes/recovery'
import { JWT_CLAIM_FN, jwtClaimFunctionSql, serviceRoleClause } from '@/lib/postgrest/rls-translation'
import { NOTIFY_FUNCTION_NAME, PRESENCE_FUNCTION_NAME } from '@/lib/realtime/channel-sql'
import { LADDER_OBJECT_PREFIX } from '@/lib/structural-evolution/facts'
import { projectIdOfWorkspaceSchema, quoteIdent } from '@/lib/security/workspace-schema'
import type { CloudRegionId } from '@/lib/regions'

/** One connection; a pg Client or PoolClient. Scans run on it in one transaction. */
export interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
}

/** The History group of the change that switches a project's planted code off: never restored. */
export const PLANTED_CHANGE_GROUP = `${SECURITY_CHANGE_GROUP}planted-objects`

/** The maintenance ladder's dual-write objects (lib/autonomy/maintenance/primitives/dual-write.ts). */
const DUAL_WRITE_PREFIX = 'bkn_dw_'
/** Derived columns' sync objects (lib/services/derived-columns.ts). */
const DERIVED_PREFIX = 'bkn_sync_'
const UPDATED_AT_FUNCTION = 'set_updated_at'
const UPDATED_AT_TRIGGER_PREFIX = 'trg_set_updated_at_'

/** Functions Backenly installs in a workspace schema, by exact name. */
const BACKENLY_FUNCTIONS = new Set<string>([
  UPDATED_AT_FUNCTION,
  JWT_CLAIM_FN,
  NOTIFY_FUNCTION_NAME,
  PRESENCE_FUNCTION_NAME,
  ...PLATFORM_OBJECTS.functions,
])
const BACKENLY_FUNCTION_PREFIXES = [DUAL_WRITE_PREFIX, DERIVED_PREFIX, LADDER_OBJECT_PREFIX]

/**
 * A trigger Backenly installs, by name: the function it runs (the same name for
 * the per-column bkn_dw_ and bkn_sync_ objects), and whether it may carry a
 * WHEN condition. Null for any other name.
 */
function backenlyTrigger(name: string): { runs: (fn: string) => boolean; when: boolean } | null {
  if (name.startsWith(UPDATED_AT_TRIGGER_PREFIX)) return { runs: (fn) => fn === UPDATED_AT_FUNCTION, when: false }
  if (name === 'backenly_realtime') return { runs: (fn) => fn === NOTIFY_FUNCTION_NAME, when: false }
  if (name === 'backenly_presence_notify') return { runs: (fn) => fn === PRESENCE_FUNCTION_NAME, when: false }
  if (name === CAPTURE_TRIGGER) return { runs: (fn) => fn === 'backenly_capture_webhook_event', when: false }
  if (name.startsWith(DUAL_WRITE_PREFIX) || name.startsWith(DERIVED_PREFIX)) return { runs: (fn) => fn === name, when: false }
  if (name.startsWith(LADDER_OBJECT_PREFIX)) return { runs: (fn) => fn.startsWith(LADDER_OBJECT_PREFIX), when: true }
  return null
}

// ── What an expression may call ─────────────────────────────────────────────

/**
 * Built-ins PostgreSQL declares immutable or stable that still run SQL handed
 * to them as text, or read other sessions, files or objects by name: an
 * expression calling one runs it as whoever reaches the expression.
 */
export const DENIED_BUILTINS = String.raw`^((query|table|schema|database|cursor)_to_xml(schema|_and_xmlschema)?|ts_stat|pg_stat_.*|pg_get_.*|pg_read_.*|pg_ls_.*|pg_stat_file|lo_.*)$`
/** ts_rewrite(query, select text) runs the SELECT it is handed; the three-argument form only rewrites. */
const TEXT_RUNNING_TS_REWRITE_ARGS = 2

/** Volatile built-ins that only make a value, as a default does. Every other volatile one changes something. */
export const VALUE_BUILTINS = [
  'nextval', 'currval', 'lastval', 'gen_random_uuid', 'random', 'random_normal', 'clock_timestamp', 'timeofday',
  'txid_current', 'txid_current_if_assigned', 'pg_current_xact_id', 'pg_current_xact_id_if_assigned', 'uuidv4', 'uuidv7',
]
/** Extensions whose immutable and stable functions compute from their arguments alone. */
export const COMPUTING_EXTENSIONS = [
  'citext', 'pg_trgm', 'unaccent', 'fuzzystrmatch', 'hstore', 'ltree', 'btree_gin', 'btree_gist', 'vector',
  'cube', 'earthdistance', 'intarray', 'isn',
]
/** Extensions every function of which computes, or makes a random value. */
export const VALUE_EXTENSIONS = ['pgcrypto', 'uuid-ossp']

const LOGIN_ROLE = /^bkn_(ro|rw|fn)_[0-9a-f]{12}$/
const OWNER_ROLE = /^bkn_own_[0-9a-f]{12}$/

// ── What a database is ──────────────────────────────────────────────────────

export interface DatabaseFacts {
  /**
   * public.backenly_direct_shared_database(); null where the direct-access
   * helpers predate it, or this connection may not ask (only the application's
   * role may).
   */
  shared: boolean | null
  /** Whether the helper that strips read-write logins is installed (scripts/setup-direct-access.sql, 5c). */
  stripInstalled: boolean
  /**
   * Backenly's own roles here: the application's, the installer's, this
   * connection's, every superuser and every role that may create roles (an
   * administrator such as the RDS master, which owns what the application made
   * before it had a role of its own).
   */
  platformRoles: string[]
  /**
   * The roles requests are served as, which must not be able to run a
   * project's code, and `public`. Superusers are left out: no privilege binds them.
   */
  sharedRoles: string[]
  /** Identities the drift ledger records a direct-access login creating, as pg_identify_object writes them. */
  createdByLogins: Set<string>
  /** False when the drift ledger is here but this connection may not read it: authorship then rests on owners and names. */
  driftReadable: boolean
}

const DRIFT_CREATES = [
  'CREATE FUNCTION', 'CREATE PROCEDURE', 'CREATE AGGREGATE', 'CREATE TRIGGER', 'CREATE CONSTRAINT',
  'CREATE RULE', 'CREATE POLICY', 'CREATE VIEW', 'CREATE MATERIALIZED VIEW', 'CREATE OPERATOR', 'CREATE CAST',
  'ALTER FUNCTION', 'ALTER PROCEDURE', 'ALTER POLICY',
]

export async function readDatabaseFacts(db: PgClient): Promise<DatabaseFacts> {
  const [base] = (await db.query(
    `SELECT current_user::text AS me,
            array_remove(ARRAY[
              current_user::text,
              session_user::text,
              (SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p
                WHERE p.oid = to_regprocedure('public.backenly_direct_sync_schema(text,text,text,text)')),
              (SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p
                WHERE p.oid = to_regprocedure('public.backenly_pgrst_register_schema(text)'))
            ] || ARRAY(SELECT r.rolname::text FROM pg_roles r
                        -- A login of a project's never has CREATEROLE; the
                        -- installer does (the RDS master), as a superuser would.
                        WHERE r.rolsuper OR r.rolcreaterole OR r.rolname IN ('backenly_app', 'backenly_user')),
            NULL) AS platform,
            coalesce(has_function_privilege(to_regprocedure('public.backenly_app_role()'), 'EXECUTE'), false) AS has_app_role,
            coalesce(has_function_privilege(to_regprocedure('public.backenly_direct_shared_database()'), 'EXECUTE'), false) AS has_shared,
            to_regprocedure('public.backenly_direct_strip_schema_changes(text,text,text)') IS NOT NULL AS has_strip,
            to_regclass('public.schema_drift_events') IS NOT NULL AS has_drift,
            CASE WHEN to_regclass('public.schema_drift_events') IS NOT NULL
                 THEN has_table_privilege(to_regclass('public.schema_drift_events'), 'SELECT') END AS can_read_drift,
            coalesce(nullif(current_setting('backenly.backup_role', true), ''), 'backenly_backup') AS backup_role`,
  )).rows
  const platform = new Set<string>(base.platform as string[])
  let appRole: string | null = null
  if (base.has_app_role) {
    const [{ role }] = (await db.query(`SELECT public.backenly_app_role()::text AS role`)).rows
    appRole = role ?? null
    if (appRole) platform.add(appRole)
  }
  const shared = base.has_shared
    ? ((await db.query(`SELECT public.backenly_direct_shared_database() AS shared`)).rows[0].shared as boolean)
    : null
  // The roles requests are served as: the application's (this connection's,
  // which is how the script runs), PostgREST's, and the groups and backup role
  // every project's data is read through. Not an administrator's.
  const candidates = [
    base.me as string, appRole, 'backenly_app', 'backenly_user',
    'anon', 'authenticated', 'service_role', 'backenly_authenticator', 'backenly_external', base.backup_role as string,
  ].filter((r): r is string => !!r)
  const { rows: served } = await db.query(
    `SELECT DISTINCT r.rolname::text AS role FROM pg_roles r
      WHERE r.rolname = ANY ($1::text[]) AND NOT r.rolsuper ORDER BY 1`,
    [candidates],
  )
  const createdByLogins = new Set<string>()
  if (base.has_drift && base.can_read_drift) {
    const { rows } = await db.query(
      `SELECT DISTINCT e."objectIdentity" AS identity
         FROM public.schema_drift_events e
        WHERE e."roleName" ~ '^bkn_(ro|rw|fn)_[0-9a-f]{12}$'
          AND e."commandTag" = ANY ($1::text[])
          AND e."objectIdentity" IS NOT NULL`,
      [DRIFT_CREATES],
    )
    for (const r of rows) createdByLogins.add(r.identity as string)
  }
  return {
    shared,
    stripInstalled: base.has_strip === true,
    platformRoles: [...platform].sort(),
    sharedRoles: ['public', ...served.map((r) => r.role as string)],
    createdByLogins,
    driftReadable: !base.has_drift || base.can_read_drift === true,
  }
}

/** Every project schema in the database: a project's own, its branches, its vaults. */
export async function projectSchemas(db: PgClient, projectId?: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT nspname::text AS schema FROM pg_namespace
      WHERE nspname ~ '^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(_[A-Za-z0-9_]+)?$'
      ORDER BY 1`,
  )
  const schemas = rows.map((r) => r.schema as string)
  return projectId ? schemas.filter((s) => projectIdOfWorkspaceSchema(s) === projectId) : schemas
}

// ── What a project planted ───────────────────────────────────────────────────

/** An expression that runs in whichever session reaches it, and calls or reads what it must not. */
export type ExpressionKind = 'default' | 'generated column' | 'check' | 'domain default' | 'domain check' | 'policy' | 'view'
export type PlantedKind = 'function' | 'procedure' | 'aggregate' | 'trigger' | 'rule' | ExpressionKind

const EXPRESSION_KINDS = new Set<string>(['default', 'generated column', 'check', 'domain default', 'domain check', 'policy', 'view'])
const isExpression = (p: Planted) => EXPRESSION_KINDS.has(p.kind)

export interface Planted {
  kind: PlantedKind
  schema: string
  projectId: string | null
  /** A routine's signature, `name on table`, or for an expression what it belongs to. */
  name: string
  /** Why it is read as the project's rather than Backenly's. */
  why: string
  oid: string
  // Routines.
  signature?: string
  owner?: string
  definer?: boolean
  /** Roles holding an explicit grant on it, `PUBLIC` included. */
  grantees?: string[]
  // Triggers, rules and expressions.
  /** The trigger's, rule's, constraint's, policy's or column's own name. */
  objectName?: string
  /** The table, view or domain it is on. */
  table?: string
  onView?: boolean
  enabled?: boolean
  // Expressions.
  /** The catalog the expression is kept in, as an oid: with `oid`, how it is found again. */
  classid?: string
  /** pg_class.relkind of `table`. */
  relkind?: string
  /** A policy's command (pg_policy.polcmd). */
  command?: string
  /** Functions it calls that may not run there. */
  calls?: string[]
  /** Relations outside its project it reads. */
  reads?: string[]
  /** A policy whose table has no rule of Backenly's left, so switching it off holds the table to Backenly's closed rule. */
  closesTable?: boolean
  /** A view's columns, for the empty view that replaces it. */
  columns?: Array<{ name: string; type: string; collation: string | null }>
}

/** Something that calls a planted routine, and now fails closed instead. */
export interface CallsPlanted {
  projectId: string | null
  /** As pg_identify_object names it: `policy`, `default value`, `table constraint`, `index`, `view`... */
  type: string
  identity: string
  calls: string
}

/** Something that reaches what it must not and is not switched off here, for a person to review. */
export interface ForReview {
  projectId: string | null
  schema: string
  kind: string
  name: string
  /** The functions it calls and the relations outside its project it reads. */
  builtins: string[]
}

export interface PlantedReport {
  planted: Planted[]
  callers: CallsPlanted[]
  review: ForReview[]
}

/** Why a routine is the project's, or null when it is Backenly's. */
function routineAuthor(r: any, facts: DatabaseFacts): string | null {
  const owner = r.owner as string
  if (LOGIN_ROLE.test(owner)) return `owned by the login ${owner}`
  if (OWNER_ROLE.test(owner)) return `owned by the project's owner role ${owner}, which Backenly never makes code as`
  if (!r.owner_super && !facts.platformRoles.includes(owner)) return `owned by ${owner}, which is not one of Backenly's roles`
  const name = r.name as string
  const backenlys =
    (BACKENLY_FUNCTIONS.has(name) && (name !== UPDATED_AT_FUNCTION || r.backenly_body === true)) ||
    BACKENLY_FUNCTION_PREFIXES.some((p) => name.startsWith(p))
  if (!backenlys) return 'not a function Backenly installs'
  if (facts.createdByLogins.has(r.identity)) return 'created over a direct-access login (drift ledger)'
  return null
}

/** Why a trigger is the project's, or null when it is Backenly's. */
function triggerAuthor(t: any, planted: Map<string, Planted>, facts: DatabaseFacts): string | null {
  const fn = planted.get(t.fn_oid)
  if (fn) return `runs ${fn.signature}, which the project made`
  if (facts.createdByLogins.has(t.identity)) return 'created over a direct-access login (drift ledger)'
  const ours = backenlyTrigger(t.name)
  if (!ours) return 'not a trigger Backenly installs'
  // Backenly's function lives in the same project's schemas (a branch may run its project's own).
  const sameProject = projectIdOfWorkspaceSchema(t.fn_schema) !== null &&
    projectIdOfWorkspaceSchema(t.fn_schema) === projectIdOfWorkspaceSchema(t.schema)
  if (!ours.runs(t.fn_name) || !sameProject) return `named like one of Backenly's, but runs ${t.fn_schema}.${t.fn_name}`
  if (t.has_when && !ours.when) return 'carries a WHEN condition, which this trigger of Backenly\'s never has'
  return null
}

/** What an expression reaches that it must not, in words: names only. */
function reachOf(calls: string[], reads: string[]): string {
  return [
    calls.length ? `calls ${calls.join(', ')}, which is not a function that only computes a value` : '',
    reads.length ? `reads ${reads.join(', ')}, outside its project` : '',
  ].filter(Boolean).join('; ')
}

interface ExpressionRow {
  kind: string
  classid: string
  oid: string
  schema: string
  rel: string
  relkind: string | null
  item: string | null
  cmd: string | null
  calls: string[]
  reads: string[]
  rls: boolean | null
  backenly_rules: number | null
  columns: Array<{ name: string; type: string; collation: string | null }> | null
}

/**
 * Every expression in `schemas` that calls a function outside what may run in
 * a shared session, or reads a relation outside its own project. Read from the
 * stored trees, in which a function is `:funcid`, `:opfuncid` and the like and
 * a relation `:relid`, and from pg_depend, which names the relations an
 * expression's constants point at (nextval('...'::regclass)). The caller sets
 * search_path to pg_catalog, so every name comes back qualified.
 */
async function scanExpressions(db: PgClient, schemas: string[]): Promise<ExpressionRow[]> {
  if (schemas.length === 0) return []
  const { rows } = await db.query(
    `WITH exprs AS (
       SELECT CASE WHEN a.attgenerated <> '' THEN 'generated column' ELSE 'default' END AS kind,
              'pg_attrdef'::regclass::oid AS classid, ad.oid AS objid, c.oid AS relid,
              n.nspname::text AS schema, c.relname::text AS rel, c.relkind::text AS relkind,
              a.attname::text AS item, ad.adbin::text AS tree, NULL::text AS cmd
         FROM pg_attrdef ad
         JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
         JOIN pg_class c ON c.oid = ad.adrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[])
          -- An inherited generation expression is its parent's, switched off there.
          AND NOT (a.attgenerated <> '' AND a.attinhcount > 0)
       UNION ALL
       SELECT 'check', 'pg_constraint'::regclass::oid, con.oid, c.oid, n.nspname::text, c.relname::text,
              c.relkind::text, con.conname::text, con.conbin::text, NULL
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[]) AND con.contype = 'c' AND con.coninhcount = 0
       UNION ALL
       SELECT 'domain check', 'pg_constraint'::regclass::oid, con.oid, NULL::oid, n.nspname::text, t.typname::text,
              NULL, con.conname::text, con.conbin::text, NULL
         FROM pg_constraint con
         JOIN pg_type t ON t.oid = con.contypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ANY ($1::text[]) AND con.contype = 'c'
       UNION ALL
       SELECT 'domain default', 'pg_type'::regclass::oid, t.oid, NULL::oid, n.nspname::text, t.typname::text,
              NULL, NULL, t.typdefaultbin::text, NULL
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ANY ($1::text[]) AND t.typtype = 'd' AND t.typdefaultbin IS NOT NULL
       UNION ALL
       SELECT 'policy', 'pg_policy'::regclass::oid, pol.oid, c.oid, n.nspname::text, c.relname::text, c.relkind::text,
              pol.polname::text, coalesce(pol.polqual::text, '') || ' ' || coalesce(pol.polwithcheck::text, ''),
              pol.polcmd::text
         FROM pg_policy pol
         JOIN pg_class c ON c.oid = pol.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[])
       UNION ALL
       SELECT CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END, 'pg_rewrite'::regclass::oid, r.oid,
              c.oid, n.nspname::text, c.relname::text, c.relkind::text, NULL, r.ev_action::text, NULL
         FROM pg_rewrite r
         JOIN pg_class c ON c.oid = r.ev_class
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[]) AND r.rulename = '_RETURN' AND c.relkind IN ('v', 'm')
       UNION ALL
       SELECT 'trigger condition', 'pg_trigger'::regclass::oid, t.oid, c.oid, n.nspname::text, c.relname::text,
              c.relkind::text, t.tgname::text, t.tgqual::text, NULL
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[]) AND NOT t.tgisinternal AND t.tgparentid = 0 AND t.tgqual IS NOT NULL
     ),
     refs AS (
       SELECT e.classid, e.objid, m[1] AS field, m[2]::oid AS ref
         FROM exprs e
         CROSS JOIN LATERAL regexp_matches(e.tree, ':(funcid|opfuncid|aggfnoid|winfnoid|opno|hashfuncid|negfuncid|relid) ([0-9]+)', 'g') AS m
     ),
     fns AS (
       SELECT DISTINCT r.classid, r.objid, CASE WHEN r.field = 'opno' THEN o.oprcode::oid ELSE r.ref END AS fn
         FROM refs r
         LEFT JOIN pg_operator o ON r.field = 'opno' AND o.oid = r.ref
        WHERE r.field <> 'relid' AND r.ref <> 0
     ),
     calls AS (
       SELECT f.classid, f.objid, p.oid::regprocedure::text AS name
         FROM fns f
         JOIN exprs e ON e.classid = f.classid AND e.objid = f.objid
         JOIN pg_proc p ON p.oid = f.fn
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
         LEFT JOIN LATERAL (
           SELECT x.extname::text AS ext
             FROM pg_depend d JOIN pg_extension x ON x.oid = d.refobjid
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
              AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
            LIMIT 1) x ON true
        -- Each test is false, never null, where it does not apply: NOT of a null
        -- would drop the row, and with it what the expression calls.
        WHERE NOT (
          coalesce(x.ext IS NULL AND pn.nspname IN ('pg_catalog', 'information_schema')
             AND ((p.provolatile IN ('i', 's') AND p.proname !~ $2
                   AND NOT (p.proname = 'ts_rewrite' AND p.pronargs = $3))
                  OR p.proname = ANY ($4::text[])), false)
          OR coalesce(x.ext = ANY ($5::text[]) AND p.provolatile IN ('i', 's'), false)
          OR coalesce(x.ext = ANY ($6::text[]), false)
          -- The project's own: Backenly's claim reader, or a routine switched off on its own.
          OR coalesce(substring(pn.nspname FROM '^workspace_([0-9a-fA-F-]{36})')
                      = substring(e.schema FROM '^workspace_([0-9a-fA-F-]{36})'), false)
        )
     ),
     rels AS (
       SELECT r.classid, r.objid, r.ref AS rel FROM refs r WHERE r.field = 'relid' AND r.ref <> 0
       UNION
       SELECT d.classid, d.objid, d.refobjid
         FROM pg_depend d JOIN exprs e ON e.classid = d.classid AND e.objid = d.objid
        WHERE d.refclassid = 'pg_class'::regclass AND d.deptype = 'n'
     ),
     reads AS (
       SELECT r.classid, r.objid, c.oid::regclass::text AS name
         FROM rels r
         JOIN exprs e ON e.classid = r.classid AND e.objid = r.objid
         JOIN pg_class c ON c.oid = r.rel
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
        WHERE substring(cn.nspname FROM '^workspace_([0-9a-fA-F-]{36})')
              IS DISTINCT FROM substring(e.schema FROM '^workspace_([0-9a-fA-F-]{36})')
     )
     SELECT e.kind, e.classid::text AS classid, e.objid::text AS oid, e.schema, e.rel, e.relkind, e.item, e.cmd,
            coalesce((SELECT array_agg(DISTINCT c.name ORDER BY c.name) FROM calls c
                       WHERE c.classid = e.classid AND c.objid = e.objid), '{}'::text[]) AS calls,
            coalesce((SELECT array_agg(DISTINCT r.name ORDER BY r.name) FROM reads r
                       WHERE r.classid = e.classid AND r.objid = e.objid), '{}'::text[]) AS reads,
            CASE WHEN e.kind = 'policy' THEN (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = e.relid) END AS rls,
            -- Backenly's rules left on a policy's table once what is switched off here is.
            CASE WHEN e.kind = 'policy' THEN (
              SELECT count(*)::int FROM pg_policy p2
               WHERE p2.polrelid = e.relid AND p2.polname LIKE 'backenly\\_%'
                 AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.classid = 'pg_policy'::regclass AND c.objid = p2.oid)
                 AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.classid = 'pg_policy'::regclass AND r.objid = p2.oid))
            END AS backenly_rules,
            CASE WHEN e.kind = 'view' THEN (
              SELECT coalesce(json_agg(json_build_object(
                       'name', a.attname,
                       'type', format_type(a.atttypid, a.atttypmod),
                       'collation', CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                                         THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END)
                     ORDER BY a.attnum), '[]'::json)
                FROM pg_attribute a
                JOIN pg_type t ON t.oid = a.atttypid
                LEFT JOIN pg_collation co ON co.oid = a.attcollation
                LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
               WHERE a.attrelid = e.relid AND a.attnum > 0 AND NOT a.attisdropped)
            END AS columns
       FROM exprs e
      WHERE EXISTS (SELECT 1 FROM calls c WHERE c.classid = e.classid AND c.objid = e.objid)
         OR EXISTS (SELECT 1 FROM reads r WHERE r.classid = e.classid AND r.objid = e.objid)
      ORDER BY e.schema, e.kind, e.rel, e.item`,
    [schemas, DENIED_BUILTINS, TEXT_RUNNING_TS_REWRITE_ARGS, VALUE_BUILTINS, COMPUTING_EXTENSIONS, VALUE_EXTENSIONS],
  )
  return rows as ExpressionRow[]
}

/** Run `fn` in a read-only transaction resolving names against pg_catalog alone, so every name comes back qualified. */
async function inCatalog<T>(db: PgClient, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN READ ONLY')
  try {
    await db.query(`SET LOCAL search_path = pg_catalog`)
    const out = await fn()
    await db.query('COMMIT')
    return out
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

function expressionName(r: ExpressionRow): string {
  switch (r.kind) {
    case 'default':
    case 'generated column':
      return `${r.rel}.${r.item}`
    case 'domain default':
    case 'view':
    case 'materialized view':
      return r.rel
    default:
      return `${r.item} on ${r.rel}`
  }
}

/**
 * Everything in `schemas` a project planted, what calls it, and what a person
 * should look at. Read in one transaction, with names resolved against
 * pg_catalog alone so every signature comes back qualified.
 */
export async function findPlanted(db: PgClient, schemas: string[], facts: DatabaseFacts): Promise<PlantedReport> {
  if (schemas.length === 0) return { planted: [], callers: [], review: [] }
  return inCatalog(db, async () => {
    const routines = (await db.query(
      `SELECT p.oid::text AS oid, n.nspname::text AS schema, p.proname::text AS name, p.prokind::text AS kind,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner)::text AS owner, o.rolsuper AS owner_super,
              p.oid::regprocedure::text AS signature,
              (p.proname = 'set_updated_at' AND p.prosrc LIKE '%updatedAt%') AS backenly_body,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                          FROM aclexplode(p.proacl) a), '{}'::text[]) AS grantees,
              (pg_identify_object('pg_proc'::regclass, p.oid, 0)).identity AS identity
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = ANY ($1::text[])
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 2, 3`,
      [schemas],
    )).rows
    const triggers = (await db.query(
      `SELECT t.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS "table", c.relkind::text AS relkind,
              t.tgname::text AS name, t.tgenabled::text AS enabled, (t.tgqual IS NOT NULL) AS has_when,
              t.tgfoid::text AS fn_oid, fp.proname::text AS fn_name, fn.nspname::text AS fn_schema,
              (pg_identify_object('pg_trigger'::regclass, t.oid, 0)).identity AS identity
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc fp ON fp.oid = t.tgfoid
         JOIN pg_namespace fn ON fn.oid = fp.pronamespace
        WHERE n.nspname = ANY ($1::text[]) AND NOT t.tgisinternal
          -- A partition's copy of a trigger follows the one on its parent.
          AND t.tgparentid = 0
        ORDER BY 2, 3, 5`,
      [schemas],
    )).rows
    const rules = (await db.query(
      `SELECT r.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS "table", c.relkind::text AS relkind,
              r.rulename::text AS name, r.ev_enabled::text AS enabled
         FROM pg_rewrite r
         JOIN pg_class c ON c.oid = r.ev_class
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1::text[]) AND r.rulename <> '_RETURN'
        ORDER BY 2, 3, 5`,
      [schemas],
    )).rows
    const expressions = await scanExpressions(db, schemas)

    const planted: Planted[] = []
    const plantedRoutines = new Map<string, Planted>()
    for (const r of routines) {
      const why = routineAuthor(r, facts)
      if (!why) continue
      const p: Planted = {
        kind: r.kind === 'p' ? 'procedure' : r.kind === 'a' ? 'aggregate' : 'function',
        schema: r.schema,
        projectId: projectIdOfWorkspaceSchema(r.schema),
        name: r.signature,
        why,
        oid: r.oid,
        signature: r.signature,
        owner: r.owner,
        definer: r.definer === true,
        grantees: r.grantees ?? [],
      }
      planted.push(p)
      plantedRoutines.set(r.oid, p)
    }
    // A trigger whose WHEN condition calls or reads what it must not is the
    // project's, whatever its name.
    const conditions = new Map(
      expressions.filter((e) => e.kind === 'trigger condition').map((e): [string, ExpressionRow] => [e.oid, e]),
    )
    for (const t of triggers) {
      const condition = conditions.get(t.oid)
      const why = triggerAuthor(t, plantedRoutines, facts) ??
        (condition ? `its WHEN condition ${reachOf(condition.calls, condition.reads)}` : null)
      if (!why) continue
      planted.push({
        kind: 'trigger',
        schema: t.schema,
        projectId: projectIdOfWorkspaceSchema(t.schema),
        name: `${t.name} on ${t.table}`,
        why,
        oid: t.oid,
        objectName: t.name,
        table: t.table,
        onView: t.relkind === 'v',
        enabled: t.enabled !== 'D',
      })
    }
    for (const r of rules) {
      planted.push({
        kind: 'rule',
        schema: r.schema,
        projectId: projectIdOfWorkspaceSchema(r.schema),
        name: `${r.name} on ${r.table}`,
        why: 'a rule, which Backenly never makes',
        oid: r.oid,
        objectName: r.name,
        table: r.table,
        onView: r.relkind === 'v' || r.relkind === 'm',
        enabled: r.enabled !== 'D',
      })
    }
    const review: ForReview[] = []
    for (const e of expressions) {
      if (e.kind === 'trigger condition') continue
      if (e.kind === 'materialized view') {
        // Runs its query when refreshed, as its owner: nothing here replaces it.
        review.push({
          projectId: projectIdOfWorkspaceSchema(e.schema),
          schema: e.schema,
          kind: e.kind,
          name: e.rel,
          builtins: [...e.calls, ...e.reads],
        })
        continue
      }
      planted.push({
        kind: e.kind as ExpressionKind,
        schema: e.schema,
        projectId: projectIdOfWorkspaceSchema(e.schema),
        name: expressionName(e),
        why: reachOf(e.calls, e.reads),
        oid: e.oid,
        classid: e.classid,
        objectName: e.item ?? undefined,
        table: e.rel,
        relkind: e.relkind ?? undefined,
        command: e.cmd ?? undefined,
        calls: e.calls,
        reads: e.reads,
        closesTable: e.kind === 'policy' ? e.rls === true && e.backenly_rules === 0 : undefined,
        columns: e.kind === 'view' ? (e.columns ?? []) : undefined,
      })
    }

    // What calls a planted routine, other than what is listed above already.
    const callers: CallsPlanted[] = []
    if (plantedRoutines.size > 0) {
      const { rows } = await db.query(
        `SELECT DISTINCT d.refobjid::text AS fn_oid, o.type, o.identity
           FROM pg_depend d
           CROSS JOIN LATERAL pg_identify_object(d.classid, d.objid, d.objsubid) o
          WHERE d.refclassid = 'pg_proc'::regclass
            AND d.refobjid = ANY ($1::oid[])
            AND d.deptype = 'n'
            AND d.classid NOT IN ('pg_trigger'::regclass, 'pg_proc'::regclass)
            AND NOT (d.classid = 'pg_rewrite'::regclass
                     AND (SELECT rulename FROM pg_rewrite WHERE oid = d.objid) <> '_RETURN')
          ORDER BY 2, 3`,
        [[...plantedRoutines.keys()]],
      )
      for (const r of rows) {
        const fn = plantedRoutines.get(r.fn_oid)!
        const view = r.type === 'rule' && /^"?_RETURN"? on /.test(r.identity)
        callers.push({
          projectId: fn.projectId,
          type: view ? 'view' : r.type,
          identity: view ? String(r.identity).replace(/^"?_RETURN"? on /, '') : r.identity,
          calls: fn.signature!,
        })
      }
    }

    return { planted, callers, review }
  })
}

// ── Switching it off ─────────────────────────────────────────────────────────

export interface Action {
  object: Planted
  /** What it does, in a few words, for the report. */
  does: string
  /** One statement each: the workspace client runs one per call. */
  statements: string[]
}

const qualified = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`
const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`

/** What ALTER calls a relation of this kind. */
function relationWord(relkind: string | undefined): string {
  switch (relkind) {
    case 'v': return 'VIEW'
    case 'm': return 'MATERIALIZED VIEW'
    case 'f': return 'FOREIGN TABLE'
    default: return 'TABLE'
  }
}

/**
 * Backenly's closed rule, as the admin_only template installs it
 * (lib/services/workspace-rls.ts): row-level security on and forced, and one
 * policy letting service-role keys alone through. Idempotent.
 */
function closedRuleStatements(schema: string, table: string): string[] {
  const on = qualified(schema, table)
  return [
    jwtClaimFunctionSql(schema),
    `ALTER TABLE ${on} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY`,
    `DO $close$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ${sqlLiteral(on)}::regclass AND polname = 'backenly_admin_only') THEN
         CREATE POLICY backenly_admin_only ON ${on} FOR ALL USING (${serviceRoleClause(schema)});
       END IF;
     END $close$`,
  ]
}

/** The actions that switch off one expression. */
function expressionActions(p: Planted): Action[] {
  const on = qualified(p.schema, p.table!)
  const name = quoteIdent(p.objectName ?? '')
  switch (p.kind) {
    case 'default':
      return [{ object: p, does: 'default dropped', statements: [`ALTER ${relationWord(p.relkind)} ${on} ALTER COLUMN ${name} DROP DEFAULT`] }]
    case 'generated column':
      return [{ object: p, does: 'made an ordinary column, its values kept', statements: [`ALTER TABLE ${on} ALTER COLUMN ${name} DROP EXPRESSION`] }]
    case 'check':
      return [{ object: p, does: 'check dropped', statements: [`ALTER TABLE ${on} DROP CONSTRAINT ${name}`] }]
    case 'domain default':
      return [{ object: p, does: 'default dropped', statements: [`ALTER DOMAIN ${on} DROP DEFAULT`] }]
    case 'domain check':
      return [{ object: p, does: 'check dropped', statements: [`ALTER DOMAIN ${on} DROP CONSTRAINT ${name}`] }]
    case 'policy': {
      // A policy without a USING (an INSERT one) takes only WITH CHECK, and one
      // without a WITH CHECK (SELECT, DELETE) only USING.
      const clause = p.command === 'a' ? 'WITH CHECK (false)'
        : p.command === 'r' || p.command === 'd' ? 'USING (false)'
          : 'USING (false) WITH CHECK (false)'
      return [{
        object: p,
        does: p.closesTable
          ? 'made false, and its table held to Backenly\'s closed rule (service-role keys only)'
          : 'made false',
        statements: [`ALTER POLICY ${name} ON ${on} ${clause}`, ...(p.closesTable ? closedRuleStatements(p.schema, p.table!) : [])],
      }]
    }
    case 'view': {
      const columns = (p.columns ?? [])
        .map((c) => `NULL::${c.type}${c.collation ? ` COLLATE ${c.collation}` : ''} AS ${quoteIdent(c.name)}`)
        .join(', ')
      return [{
        object: p,
        does: 'replaced by an empty view with the same columns',
        statements: [`CREATE OR REPLACE VIEW ${on} AS SELECT ${columns} WHERE false`],
      }]
    }
    default:
      return []
  }
}

/**
 * The statements that switch off what was planted: a routine's privileges,
 * then its security; a trigger or a rule; an expression. Each action stands
 * alone, so one that fails leaves the rest to run and is reported.
 */
export function actionsFor(planted: Planted[]): Action[] {
  const actions: Action[] = []
  for (const p of planted) {
    if (p.signature) {
      const holders = [...new Set([p.owner!, ...(p.grantees ?? []).filter((g) => g !== 'PUBLIC')])]
      actions.push({
        object: p,
        does: `EXECUTE taken from PUBLIC, ${holders.join(', ')}`,
        statements: [
          `REVOKE ALL ON ROUTINE ${p.signature} FROM PUBLIC CASCADE`,
          ...holders.map((h) => `REVOKE ALL ON ROUTINE ${p.signature} FROM ${quoteIdent(h)} CASCADE`),
        ],
      })
      // A definer runs as its owner whoever calls it. One a platform role owns
      // reaches every project; one a login or the owner role owns reaches no
      // further than the project.
      if (p.definer && p.kind !== 'aggregate' && !LOGIN_ROLE.test(p.owner!) && !OWNER_ROLE.test(p.owner!)) {
        actions.push({ object: p, does: 'made SECURITY INVOKER', statements: [`ALTER ROUTINE ${p.signature} SECURITY INVOKER`] })
      }
      continue
    }
    if (isExpression(p)) {
      actions.push(...expressionActions(p))
      continue
    }
    const on = qualified(p.schema, p.table!)
    const name = quoteIdent(p.objectName!)
    if (p.kind === 'trigger' && p.onView) {
      actions.push({ object: p, does: 'dropped (a trigger on a view cannot be disabled)', statements: [`DROP TRIGGER ${name} ON ${on}`] })
    } else if (p.kind === 'trigger' && p.enabled) {
      actions.push({ object: p, does: 'disabled', statements: [`ALTER TABLE ${on} DISABLE TRIGGER ${name}`] })
    } else if (p.kind === 'rule' && p.onView) {
      actions.push({ object: p, does: 'dropped (a rule on a view cannot be disabled)', statements: [`DROP RULE ${name} ON ${on}`] })
    } else if (p.kind === 'rule' && p.enabled) {
      actions.push({ object: p, does: 'disabled', statements: [`ALTER TABLE ${on} DISABLE RULE ${name}`] })
    }
  }
  return actions
}

/**
 * What of `planted` still runs, read from the catalog rather than assumed: a
 * routine PUBLIC or a shared role can execute, a definer that runs as a role
 * reaching other projects, or one whose owner a direct-access login acts as
 * (it could grant its use again); a trigger or a rule still enabled, or still
 * there on a view; an expression that still calls or reads what it must not.
 * Empty when everything is off. Read before acting, so a run acts only on what
 * is still on, and after, so what could not be switched off is said.
 */
export async function stillRunning(
  db: PgClient,
  planted: Planted[],
  facts: DatabaseFacts,
): Promise<Array<{ object: Planted; what: string }>> {
  const left: Array<{ object: Planted; what: string }> = []
  const byOid = new Map<string, Planted>(
    planted.map((p): [string, Planted] => [
      isExpression(p) ? `x${p.classid}:${p.oid}` : `${p.kind === 'trigger' ? 't' : p.kind === 'rule' ? 'r' : 'p'}${p.oid}`,
      p,
    ]),
  )
  const routines = planted.filter((p) => p.signature)
  if (routines.length > 0) {
    const { rows } = await db.query(
      `SELECT p.oid::text AS oid, string_agg(r.role, ', ' ORDER BY r.role) AS roles
         FROM unnest($1::oid[]) AS p(oid)
         CROSS JOIN unnest($2::text[]) AS r(role)
        WHERE EXISTS (SELECT 1 FROM pg_proc x WHERE x.oid = p.oid)
          AND has_function_privilege(r.role, p.oid, 'EXECUTE')
        GROUP BY p.oid`,
      [routines.map((p) => p.oid), facts.sharedRoles],
    )
    for (const r of rows) left.push({ object: byOid.get(`p${r.oid}`)!, what: `can be run by ${r.roles}` })
    const { rows: owned } = await db.query(
      `SELECT p.oid::text AS oid, pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
              (pg_get_userbyid(p.proowner) ~ '^bkn_(ro|rw|fn)_[0-9a-f]{12}$'
               OR pg_get_userbyid(p.proowner) = 'backenly_external'
               OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles l ON l.oid = m.member
                           WHERE m.roleid = p.proowner AND l.rolname ~ '^bkn_(ro|rw)_[0-9a-f]{12}$')) AS login_owns
         FROM pg_proc p WHERE p.oid = ANY ($1::oid[])`,
      [routines.map((p) => p.oid)],
    )
    for (const d of owned) {
      if (d.definer && !LOGIN_ROLE.test(d.owner) && !OWNER_ROLE.test(d.owner)) {
        left.push({ object: byOid.get(`p${d.oid}`)!, what: `runs as ${d.owner} whoever calls it` })
      }
      if (d.login_owns) {
        left.push({
          object: byOid.get(`p${d.oid}`)!,
          what: `is owned by ${d.owner}, which a direct-access login acts as, so the login can grant its use again: ` +
            'install scripts/setup-direct-access.sql, whose strip gives it to the project\'s owner role',
        })
      }
    }
  }
  const triggers = planted.filter((p) => p.kind === 'trigger')
  if (triggers.length > 0) {
    const { rows } = await db.query(
      `SELECT t.oid::text AS oid, t.tgenabled::text AS enabled FROM pg_trigger t WHERE t.oid = ANY ($1::oid[])`,
      [triggers.map((p) => p.oid)],
    )
    for (const r of rows) {
      const t = byOid.get(`t${r.oid}`)!
      if (t.onView) left.push({ object: t, what: 'is on a view, where it fires' })
      else if (r.enabled !== 'D') left.push({ object: t, what: 'fires' })
    }
  }
  const rules = planted.filter((p) => p.kind === 'rule')
  if (rules.length > 0) {
    const { rows } = await db.query(
      `SELECT r.oid::text AS oid, r.ev_enabled::text AS enabled FROM pg_rewrite r WHERE r.oid = ANY ($1::oid[])`,
      [rules.map((p) => p.oid)],
    )
    for (const r of rows) {
      const rule = byOid.get(`r${r.oid}`)!
      if (rule.onView) left.push({ object: rule, what: 'is on a view, where it applies' })
      else if (r.enabled !== 'D') left.push({ object: rule, what: 'applies' })
    }
  }
  const expressions = planted.filter(isExpression)
  if (expressions.length > 0) {
    const rows = await inCatalog(db, () => scanExpressions(db, [...new Set(expressions.map((p) => p.schema))]))
    for (const r of rows) {
      const p = byOid.get(`x${r.classid}:${r.oid}`)
      if (p) left.push({ object: p, what: reachOf(r.calls, r.reads) })
    }
  }
  return left
}

export interface Switched {
  done: Action[]
  failed: Array<{ action: Action; error: string }>
  /** The History entry the project's own schema's changes made, if they changed what History reads. */
  changeSeq: number | null
}

/**
 * Run the actions for one project. Those on its own schema run as one governed
 * change attributed to Backenly, in a group History never restores
 * (PLANTED_CHANGE_GROUP); those on its branches and vaults run as they are, as
 * scripts/force-admin-only-tables.ts does. `execute` runs one statement as the
 * platform: the project's workspace client in production. Each action stands
 * alone; every failure is returned. `governed` is false for a schema whose
 * project has no record at home, which has no History to write to.
 */
export async function switchOff(
  projectId: string,
  actions: Action[],
  opts: { execute: (sql: string) => Promise<unknown>; governed: boolean; mainSchema: string },
): Promise<Switched> {
  const done: Action[] = []
  const failed: Switched['failed'] = []
  const run = async (list: Action[]) => {
    for (const a of list) {
      try {
        for (const sql of a.statements) await opts.execute(sql)
        done.push(a)
      } catch (err) {
        failed.push({ action: a, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  const own = actions.filter((a) => a.object.schema === opts.mainSchema)
  const elsewhere = actions.filter((a) => a.object.schema !== opts.mainSchema)
  let changeSeq: number | null = null
  if (own.length > 0 && opts.governed) {
    const { withChangeAttribution, withGovernedChange } = await import('@/lib/changes/ledger')
    const objects = new Set(own.map((a) => a.object)).size
    const count = objects === 1 ? '1 database object' : `${objects} database objects`
    const { change } = await withChangeAttribution({ source: 'system', groupId: PLANTED_CHANGE_GROUP }, () =>
      withGovernedChange(
        { projectId, title: `Switched off ${count} made over a direct database connection`, autoRecover: false },
        () => run(own),
      ),
    )
    changeSeq = change?.seq ?? null
  } else {
    await run(own)
  }
  await run(elsewhere)
  return { done, failed, changeSeq }
}

/**
 * The project's own record of what was switched off: kinds and names, never a
 * definition or the database's words, so it may sit at home for a project kept
 * in another region. REVOKE leaves nothing History reads, so this is where
 * those are written down.
 */
export async function recordSwitchedOff(projectId: string, report: PlantedReport, result: Switched): Promise<void> {
  const mine = (p: { projectId: string | null }) => p.projectId === projectId
  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'PLANTED_OBJECTS_SWITCHED_OFF',
      type: 'security',
      details: JSON.stringify({
        switchedOff: result.done.map((a) => ({ kind: a.object.kind, schema: a.object.schema, name: a.object.name, did: a.does })),
        notSwitchedOff: result.failed.map((f) => ({ kind: f.action.object.kind, schema: f.action.object.schema, name: f.action.object.name })),
        nowFailClosed: report.callers.filter(mine).map((c) => ({ type: c.type, name: c.identity })),
        forReview: report.review.filter(mine).map((r) => ({ kind: r.kind, schema: r.schema, name: r.name, builtins: r.builtins })),
        changeSeq: result.changeSeq,
      }),
      timestamp: new Date(),
    },
  })
}

/** What the report holds for one project. */
export function ofProject(report: PlantedReport, projectId: string): PlantedReport {
  return {
    planted: report.planted.filter((p) => p.projectId === projectId),
    callers: report.callers.filter((c) => c.projectId === projectId),
    review: report.review.filter((r) => r.projectId === projectId),
  }
}

/** A pool of connections to one region's database, as lib/data-plane/regional.ts regionPool gives. */
export interface PgPool {
  connect(): Promise<PgClient & { release(): void }>
}

export interface ProjectSwitchOff {
  actions: Action[]
  result: Switched
  /** What is still on once the actions ran, read back from the catalog. */
  left: Array<{ object: Planted; what: string }>
  governed: boolean
}

/**
 * Switch off what `live` holds of one project's, in the region `pool` reaches:
 * as one change on its History where its record says this region holds it,
 * written down in its audit log where it has a record, and read back after.
 * What scripts/neutralize-planted-objects.ts does with --apply, project by
 * project, and what a snapshot restore does for the project it restored.
 */
export async function switchOffProject(opts: {
  region: CloudRegionId
  projectId: string
  report: PlantedReport
  live: Array<{ object: Planted; what: string }>
  facts: DatabaseFacts
  pool: PgPool
}): Promise<ProjectSwitchOff> {
  const { region, projectId, report, facts, pool } = opts
  const targets = [...new Set(opts.live.filter((l) => l.object.projectId === projectId).map((l) => l.object))]
  const actions = actionsFor(targets)
  if (actions.length === 0) return { actions, result: { done: [], failed: [], changeSeq: null }, left: [], governed: false }

  const [{ projectRegion, regionRawClient }, { resolveWorkspaceSchema }] = await Promise.all([
    import('@/lib/data-plane/regional'),
    import('@/lib/services/workspace-pool'),
  ])
  // Governed only where the project's record says this region holds it: its
  // History and its change lock are about that database.
  const record = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
  const governed = !!record && (await projectRegion(projectId)) === region
  const mainSchema = governed ? await resolveWorkspaceSchema(projectId) : `workspace_${projectId}`
  const db = regionRawClient(region, projectId)
  const result = await switchOff(projectId, actions, {
    execute: (sql) => db.$executeRawUnsafe(sql),
    governed,
    mainSchema,
  })

  const after = await pool.connect()
  let left: Array<{ object: Planted; what: string }>
  try {
    left = await stillRunning(after, targets, facts)
  } finally {
    after.release()
  }
  if (record) await recordSwitchedOff(projectId, ofProject(report, projectId), result)
  return { actions, result, left, governed }
}
