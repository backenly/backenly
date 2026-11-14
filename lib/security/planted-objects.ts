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
 * rather than runs. So is a definition that calls a built-in which runs SQL or
 * changes the session (query_to_xml, pg_notify, set_config and the like): no
 * privilege can take those back, so a person reviews it.
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
 *     platform role (backenly_direct_drop_role), and a branch copies a schema as
 *     the platform role;
 *   - the drift ledger (public.schema_drift_events) records a direct-access
 *     login creating it.
 *
 * A trigger is a project's unless it is one of Backenly's by name, runs the
 * function of Backenly's its name goes with, and has no WHEN condition (an
 * architecture change's bkn_evo_ triggers excepted). A rule is always a
 * project's.
 *
 * Definitions are read and matched in the database that holds them: what
 * leaves it is kinds, names, owners and the names of built-ins found, never a
 * definition (lib/changes/residency.ts says why a regional project's words stay
 * in its region). scripts/neutralize-planted-objects.ts runs this in every
 * region.
 */

import { prisma } from '@/lib/db/prisma'
import { CAPTURE_TRIGGER, PLATFORM_OBJECTS } from '@/lib/changes/catalog'
import { SECURITY_CHANGE_GROUP } from '@/lib/changes/recovery'
import { JWT_CLAIM_FN } from '@/lib/postgrest/rls-translation'
import { NOTIFY_FUNCTION_NAME, PRESENCE_FUNCTION_NAME } from '@/lib/realtime/channel-sql'
import { LADDER_OBJECT_PREFIX } from '@/lib/structural-evolution/facts'
import { projectIdOfWorkspaceSchema, quoteIdent } from '@/lib/security/workspace-schema'

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

/**
 * Built-ins that run SQL handed to them as text, or change the session or the
 * server, matched as a word followed by `(` in a definition. A privilege on a
 * project's routine cannot stop these, since everyone may run them, so what
 * calls one is reported for a person.
 */
const SIDE_EFFECT_BUILTINS = String.raw`\m(query_to_xml(?:_and_xmlschema)?|query_to_xmlschema|cursor_to_xml(?:schema)?|table_to_xml(?:_and_xmlschema)?|table_to_xmlschema|schema_to_xml(?:_and_xmlschema)?|schema_to_xmlschema|database_to_xml(?:_and_xmlschema)?|database_to_xmlschema|pg_notify|set_config|setval|dblink[a-z_]*|lo_import|lo_export|lo_from_bytea|lo_put|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_sleep[a-z_]*|pg_advisory[a-z_]*|pg_logical_emit_message)\s*\(`

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

export type PlantedKind = 'function' | 'procedure' | 'aggregate' | 'trigger' | 'rule'

export interface Planted {
  kind: PlantedKind
  schema: string
  projectId: string | null
  /** A routine's signature, or `name on table`. */
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
  // Triggers and rules.
  /** The trigger's or rule's own name. */
  objectName?: string
  table?: string
  onView?: boolean
  enabled?: boolean
}

/** Something that calls a planted routine, and now fails closed instead. */
export interface CallsPlanted {
  projectId: string | null
  /** As pg_identify_object names it: `policy`, `default value`, `table constraint`, `index`, `view`... */
  type: string
  identity: string
  calls: string
}

/** A definition that calls a built-in no privilege can take back, for a person to review. */
export interface ForReview {
  projectId: string | null
  schema: string
  kind: string
  name: string
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

/**
 * Everything in `schemas` a project planted, what calls it, and what calls a
 * built-in a person should look at. Read in one transaction, with names
 * resolved against pg_catalog alone so every signature comes back qualified.
 */
export async function findPlanted(db: PgClient, schemas: string[], facts: DatabaseFacts): Promise<PlantedReport> {
  if (schemas.length === 0) return { planted: [], callers: [], review: [] }
  await db.query('BEGIN READ ONLY')
  try {
    await db.query(`SET LOCAL search_path = pg_catalog`)
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
    for (const t of triggers) {
      const why = triggerAuthor(t, plantedRoutines, facts)
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

    const review = (await db.query(
      `WITH defs AS (
         SELECT 'policy'::text AS kind, n.nspname::text AS schema, (pol.polname || ' on ' || c.relname)::text AS name,
                coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS def
           FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[])
         UNION ALL
         SELECT CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END, n.nspname::text, c.relname::text,
                pg_get_viewdef(c.oid)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[]) AND c.relkind IN ('v', 'm')
         UNION ALL
         SELECT 'trigger', n.nspname::text, (t.tgname || ' on ' || c.relname)::text, pg_get_triggerdef(t.oid)
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[]) AND NOT t.tgisinternal AND t.tgqual IS NOT NULL
         UNION ALL
         SELECT 'rule', n.nspname::text, (r.rulename || ' on ' || c.relname)::text, pg_get_ruledef(r.oid)
           FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[]) AND r.rulename <> '_RETURN'
         UNION ALL
         SELECT 'default', n.nspname::text, (c.relname || '.' || a.attname)::text, pg_get_expr(ad.adbin, ad.adrelid)
           FROM pg_attrdef ad
           JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
           JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[])
         UNION ALL
         SELECT 'constraint', n.nspname::text, (con.conname || ' on ' || c.relname)::text, pg_get_constraintdef(con.oid)
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($1::text[]) AND con.contype = 'c'
       )
       SELECT kind, schema, name, array_agg(DISTINCT m[1] ORDER BY m[1]) AS builtins
         FROM defs CROSS JOIN LATERAL regexp_matches(lower(def), $2, 'g') AS m
        GROUP BY kind, schema, name
        ORDER BY 2, 1, 3`,
      [schemas, SIDE_EFFECT_BUILTINS],
    )).rows.map((r): ForReview => ({
      projectId: projectIdOfWorkspaceSchema(r.schema),
      schema: r.schema,
      kind: r.kind,
      name: r.name,
      builtins: r.builtins,
    }))

    await db.query('COMMIT')
    return { planted, callers, review }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
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

/**
 * The statements that switch off what was planted: a routine's privileges,
 * then its security; a trigger or a rule. Each action stands alone, so one
 * that fails leaves the rest to run and is reported.
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
 * routine PUBLIC or a shared role can execute, or a definer that runs as a role
 * reaching other projects; a trigger or a rule still enabled, or still there on
 * a view. Empty when everything is off. Read before acting, so a run acts only
 * on what is still on, and after, so what could not be switched off is said.
 */
export async function stillRunning(
  db: PgClient,
  planted: Planted[],
  facts: DatabaseFacts,
): Promise<Array<{ object: Planted; what: string }>> {
  const left: Array<{ object: Planted; what: string }> = []
  const byOid = new Map<string, Planted>(
    planted.map((p): [string, Planted] => [`${p.kind === 'trigger' ? 't' : p.kind === 'rule' ? 'r' : 'p'}${p.oid}`, p]),
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
    const { rows: definers } = await db.query(
      `SELECT oid::text AS oid, pg_get_userbyid(proowner)::text AS owner FROM pg_proc WHERE oid = ANY ($1::oid[]) AND prosecdef`,
      [routines.map((p) => p.oid)],
    )
    for (const d of definers) {
      if (!LOGIN_ROLE.test(d.owner) && !OWNER_ROLE.test(d.owner)) {
        left.push({ object: byOid.get(`p${d.oid}`)!, what: `runs as ${d.owner} whoever calls it` })
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
