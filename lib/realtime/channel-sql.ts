/**
 * Realtime channels — the SQL, in one place.
 *
 * Each project's realtime stream has its own PostgreSQL notification channel.
 * Its name is a random value kept by the platform, one row per workspace
 * schema, in `backenly_realtime.channel_secrets`. Only the application role
 * reads or writes that table.
 *
 * The functions that announce a change (`backenly_notify_realtime`,
 * `backenly_notify_presence`) live in the workspace schema and run as whoever
 * wrote the row, so they cannot carry the name in their source: they read it,
 * once per row, from the view `backenly_realtime.channels`. The view answers
 * for a table only to a role that may already write that table, or to one of
 * the API roles serving the table's schema (a write through a view or through
 * a partitioned parent runs the trigger as a role that holds no grant on the
 * table itself). A project's own write-capable roles can therefore read their
 * own project's channel, and the shared API roles and the application role can
 * read every channel; none of them learns anything about rows it could not
 * already read. When the view or the row is missing the functions announce
 * nothing and the write goes through: a trigger here never fails the write
 * that fired it.
 *
 * This module is SQL text only and imports nothing, so the application
 * (lib/realtime/channels.ts), the change history (lib/changes/plan.ts), the
 * disaster-recovery restore (lib/recovery/restore.ts) and the fleet script
 * (scripts/upgrade-realtime-channels.ts) all install the same definitions.
 */

export const REALTIME_SCHEMA = 'backenly_realtime'

/** What the notify functions read. Also how a current function body is recognised. */
export const CHANNEL_LOOKUP_MARKER = 'backenly_realtime.channels'

/** COMMENT on the view: the version of the platform objects below. */
export const REALTIME_PLATFORM_VERSION = 'backenly realtime channels v1'

/** COMMENT on `backenly_notify_realtime()`. */
export const REALTIME_FUNCTION_VERSION = 'backenly realtime notify v3'

/** COMMENT on `backenly_notify_presence()`. */
export const PRESENCE_FUNCTION_VERSION = 'backenly presence notify v2'

export const NOTIFY_FUNCTION_NAME = 'backenly_notify_realtime'
export const PRESENCE_FUNCTION_NAME = 'backenly_notify_presence'

/**
 * pg_notify refuses a payload of 8000 bytes or more. The notify function sends
 * the whole change while it fits under this, and less of it otherwise.
 */
export const MAX_PAYLOAD_BYTES = 7_500

/** A channel name: 55 characters, under PostgreSQL's 63-byte identifier limit. */
export const CHANNEL_RE = /^bkn_rt_[0-9a-f]{48}$/

/** True for a value that may be written into LISTEN / UNLISTEN. Nothing else ever is. */
export function isChannelName(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_RE.test(value)
}

/**
 * What is sent on a channel that has just been replaced, so every listener
 * reads the new one at once. It is never delivered to a subscriber.
 */
export const CHANNEL_CONTROL_TYPE = 'backenly.channel'
export const CHANNEL_ROTATED_FRAME = JSON.stringify({ type: CHANNEL_CONTROL_TYPE, event: 'rotated' })

export function isChannelControlFrame(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { type?: unknown }).type === CHANNEL_CONTROL_TYPE
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`

// ── Platform objects ─────────────────────────────────────────────────────────

/** Serialises installs in one database. Transaction-scoped, so a pooler is fine. */
export const PLATFORM_INSTALL_LOCK_SQL =
  `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('backenly_realtime:install', 0))`

export interface RealtimePlatformStatus {
  has_schema: boolean
  has_table: boolean
  has_view: boolean
  view_version: string | null
  /** PUBLIC may look names up in the schema. */
  public_usage: boolean
  /** PUBLIC may read the view. */
  public_select: boolean
  /** PUBLIC holds any privilege on the table (it must hold none). */
  table_public: boolean
  table_owner: string | null
  view_owner: string | null
  connected_as: string
}

/**
 * What is installed. Catalog reads only: `to_regclass` raises for a schema the
 * caller may not use, and this has to answer for one that is half installed.
 */
export const PLATFORM_STATUS_SQL = `
SELECT n.oid IS NOT NULL AS has_schema,
       t.oid IS NOT NULL AS has_table,
       v.oid IS NOT NULL AS has_view,
       pg_catalog.obj_description(v.oid, 'pg_class') AS view_version,
       COALESCE(pg_catalog.has_schema_privilege('public'::name, n.oid, 'USAGE'), false) AS public_usage,
       COALESCE(pg_catalog.has_table_privilege('public'::name, v.oid, 'SELECT'), false) AS public_select,
       COALESCE(pg_catalog.has_table_privilege('public'::name, t.oid,
         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), false) AS table_public,
       pg_catalog.pg_get_userbyid(t.relowner)::text AS table_owner,
       pg_catalog.pg_get_userbyid(v.relowner)::text AS view_owner,
       current_user::text AS connected_as
  FROM (SELECT 1) one
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = '${REALTIME_SCHEMA}'
  LEFT JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = 'channel_secrets' AND t.relkind = 'r'
  LEFT JOIN pg_catalog.pg_class v ON v.relnamespace = n.oid AND v.relname = 'channels' AND v.relkind = 'v'
`

/**
 * Names in the schema resolve for everyone (the notify functions run as the
 * writer), and that is all PUBLIC gets on it. Granted in the transaction that
 * creates the schema, so no write ever meets a schema it may not use.
 */
const PLATFORM_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS ${REALTIME_SCHEMA};
REVOKE ALL ON SCHEMA ${REALTIME_SCHEMA} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${REALTIME_SCHEMA} TO PUBLIC;
`

/**
 * One row per workspace schema. `schema_name` is compared with a catalog name,
 * which sorts in "C": the same collation here keeps that an index lookup.
 */
const PLATFORM_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${REALTIME_SCHEMA}.channel_secrets (
  schema_name text COLLATE "C" PRIMARY KEY,
  channel     text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE ${REALTIME_SCHEMA}.channel_secrets FROM PUBLIC;
`

/**
 * The channel of the table a trigger fired for, to a role that may know it:
 * one that can already write the table, or an API role serving its schema.
 * Owned by the application role, so it reads the table for the caller; the
 * barrier keeps a caller's own function from seeing rows the filter removes.
 */
const PLATFORM_VIEW_SQL = `
CREATE OR REPLACE VIEW ${REALTIME_SCHEMA}.channels WITH (security_barrier = true) AS
SELECT c.oid AS relid,
       (SELECT s.channel
          FROM ${REALTIME_SCHEMA}.channel_secrets s
         WHERE s.schema_name = (SELECT n.nspname::text
                                  FROM pg_catalog.pg_namespace n
                                 WHERE n.oid = c.relnamespace)) AS channel
  FROM pg_catalog.pg_class c
 WHERE c.relkind IN ('r', 'p', 'f')
   AND (pg_catalog.has_any_column_privilege(c.oid, 'INSERT, UPDATE')
        OR pg_catalog.has_table_privilege(c.oid, 'DELETE')
        OR (current_user IN ('anon', 'authenticated', 'service_role')
            AND pg_catalog.has_schema_privilege(c.relnamespace, 'USAGE')));
REVOKE ALL ON TABLE ${REALTIME_SCHEMA}.channels FROM PUBLIC;
GRANT SELECT ON TABLE ${REALTIME_SCHEMA}.channels TO PUBLIC;
COMMENT ON VIEW ${REALTIME_SCHEMA}.channels IS ${literal(REALTIME_PLATFORM_VERSION)};
`

/**
 * The statements that bring a database from `status` to the current platform
 * objects, in order; none when it is already there. Each group is run only
 * when something of its own is missing: replacing the view takes a lock every
 * write that announces a change would queue behind.
 */
export function platformInstallSql(status: RealtimePlatformStatus): string[] {
  const steps: string[] = []
  if (!status.has_schema || !status.public_usage) steps.push(PLATFORM_SCHEMA_SQL)
  if (!status.has_table || status.table_public) steps.push(PLATFORM_TABLE_SQL)
  if (!status.has_view || status.view_version !== REALTIME_PLATFORM_VERSION || !status.public_select) {
    steps.push(PLATFORM_VIEW_SQL)
  }
  return steps
}

/** Every statement, for a database that is known to have none of the objects. */
export const PLATFORM_INSTALL_SQL = [PLATFORM_SCHEMA_SQL, PLATFORM_TABLE_SQL, PLATFORM_VIEW_SQL].join('\n')

/** Whether the table of channels is there, without touching it. */
export const CHANNEL_TABLE_EXISTS_SQL = `
SELECT EXISTS (
  SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${REALTIME_SCHEMA}' AND c.relname = 'channel_secrets' AND c.relkind = 'r'
) AS present
`

// ── Channel rows ─────────────────────────────────────────────────────────────

/** $1 schema name, $2 a new channel. Keeps the row that is there. */
export const CREATE_CHANNEL_SQL = `
INSERT INTO ${REALTIME_SCHEMA}.channel_secrets (schema_name, channel)
VALUES ($1, $2)
ON CONFLICT (schema_name) DO NOTHING
`

/** As above, but only for a schema that exists. */
export const CREATE_CHANNEL_FOR_EXISTING_SCHEMA_SQL = `
INSERT INTO ${REALTIME_SCHEMA}.channel_secrets (schema_name, channel)
SELECT $1::text, $2::text
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = ($1::text)::name)
ON CONFLICT (schema_name) DO NOTHING
`

/** $1 schema name. */
export const READ_CHANNEL_SQL = `
SELECT channel FROM ${REALTIME_SCHEMA}.channel_secrets WHERE schema_name = $1
`

/** $1 schema names. */
export const READ_CHANNELS_SQL = `
SELECT schema_name, channel FROM ${REALTIME_SCHEMA}.channel_secrets WHERE schema_name = ANY($1::text[])
`

/**
 * $1 schema name, $2 payload. Sends on the schema's channel without the caller
 * ever holding its name; no row means no stream was ever opened for it.
 */
export const NOTIFY_CHANNEL_SQL = `
SELECT pg_catalog.pg_notify(s.channel, $2::text)
  FROM ${REALTIME_SCHEMA}.channel_secrets s
 WHERE s.schema_name = $1
`

/**
 * $1 schema name, $2 the new channel, $3 the frame for the channel it
 * replaces. One statement: the row is locked before it is read, so two
 * replacements at once each announce on the channel the other one left.
 */
export const ROTATE_CHANNEL_SQL = `
WITH previous AS (
  SELECT channel FROM ${REALTIME_SCHEMA}.channel_secrets WHERE schema_name = $1 FOR UPDATE
), moved AS (
  UPDATE ${REALTIME_SCHEMA}.channel_secrets s
     SET channel = $2
    FROM previous
   WHERE s.schema_name = $1
  RETURNING previous.channel AS replaced
)
SELECT pg_catalog.pg_notify(moved.replaced, $3::text) FROM moved
`

/** $1 schema names. Rows only; nothing else about the schemas is touched. */
export const DELETE_CHANNELS_SQL = `
DELETE FROM ${REALTIME_SCHEMA}.channel_secrets WHERE schema_name = ANY($1::text[])
`

// ── The functions in a workspace schema ──────────────────────────────────────

/**
 * Read the channel once, before anything is built. Missing view or missing
 * row: announce nothing. No exception block: one per row would cost more than
 * the rest of the trigger.
 */
const CHANNEL_LOOKUP_PLPGSQL = `
      IF pg_catalog.to_regclass('${CHANNEL_LOOKUP_MARKER}') IS NULL THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      SELECT c.channel INTO channel FROM ${CHANNEL_LOOKUP_MARKER} c WHERE c.relid = TG_RELID;
      IF channel IS NULL THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
`

/**
 * `backenly_notify_realtime()` for one workspace schema: one notification per
 * changed row on the project's channel.
 *
 * A payload under the limit carries the whole change. Over it, as much as
 * fits, in this order: the new row with the old one reduced to its key
 * (`oldTruncated`), then the key alone (`truncated`), then no row at all.
 */
export function notifyFunctionSql(schemaName: string): string {
  return `
    CREATE OR REPLACE FUNCTION ${ident(schemaName)}.${NOTIFY_FUNCTION_NAME}()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      channel  text;
      payload  text;
      row_data json;
      old_data json;
      key_cols text[];
      row_key  json;
      old_key  json;
    BEGIN
${CHANNEL_LOOKUP_PLPGSQL}
      row_data := CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END;
      old_data := CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END;

      payload := json_build_object(
        'type',      lower(TG_OP),
        'table',     TG_TABLE_NAME,
        'data',      row_data,
        'old',       old_data,
        'timestamp', extract(epoch from clock_timestamp())
      )::text;
      IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
        PERFORM pg_catalog.pg_notify(channel, payload);
        RETURN COALESCE(NEW, OLD);
      END IF;

      SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum))
        INTO key_cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = TG_RELID AND i.indisprimary;

      IF key_cols IS NOT NULL THEN
        SELECT json_object_agg(k, row_data -> k) INTO row_key FROM unnest(key_cols) AS k;

        -- 1. The old row reduced to its key, the new row whole.
        IF TG_OP = 'UPDATE' THEN
          SELECT json_object_agg(k, old_data -> k) INTO old_key FROM unnest(key_cols) AS k;
          payload := json_build_object(
            'type',         lower(TG_OP),
            'table',        TG_TABLE_NAME,
            'data',         row_data,
            'old',          old_key,
            'oldTruncated', true,
            'timestamp',    extract(epoch from clock_timestamp())
          )::text;
          IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
            PERFORM pg_catalog.pg_notify(channel, payload);
            RETURN COALESCE(NEW, OLD);
          END IF;
        END IF;

        -- 2. The row reduced to its key: which row changed.
        payload := json_build_object(
          'type',      lower(TG_OP),
          'table',     TG_TABLE_NAME,
          'data',      row_key,
          'old',       old_key,
          'truncated', true,
          'timestamp', extract(epoch from clock_timestamp())
        )::text;
        IF octet_length(payload) <= ${MAX_PAYLOAD_BYTES} THEN
          PERFORM pg_catalog.pg_notify(channel, payload);
          RETURN COALESCE(NEW, OLD);
        END IF;
      END IF;

      -- 3. No key to name the row by.
      PERFORM pg_catalog.pg_notify(channel, json_build_object(
        'type',      lower(TG_OP),
        'table',     TG_TABLE_NAME,
        'data',      null,
        'truncated', true,
        'timestamp', extract(epoch from clock_timestamp())
      )::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$;
  `
}

/**
 * `backenly_notify_presence()` for one workspace schema: join, leave and a
 * change of metadata on `_backenly_presence`, on the project's channel. A
 * heartbeat moves `lastSeen` only and is not announced.
 */
export function presenceFunctionSql(schemaName: string): string {
  return `
    CREATE OR REPLACE FUNCTION ${ident(schemaName)}.${PRESENCE_FUNCTION_NAME}()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      channel text;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW."metadata"::text IS NOT DISTINCT FROM OLD."metadata"::text THEN
          RETURN NEW;
        END IF;
      END IF;
${CHANNEL_LOOKUP_PLPGSQL}
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_catalog.pg_notify(channel, json_build_object(
          'type', 'presence',
          'event', 'leave',
          'userId', OLD."userId",
          'timestamp', extract(epoch from clock_timestamp())
        )::text);
        RETURN OLD;
      ELSIF TG_OP = 'INSERT' THEN
        PERFORM pg_catalog.pg_notify(channel, json_build_object(
          'type', 'presence',
          'event', 'join',
          'userId', NEW."userId",
          'metadata', NEW."metadata",
          'timestamp', extract(epoch from clock_timestamp())
        )::text);
        RETURN NEW;
      ELSE
        PERFORM pg_catalog.pg_notify(channel, json_build_object(
          'type', 'presence',
          'event', 'update',
          'userId', NEW."userId",
          'metadata', NEW."metadata",
          'timestamp', extract(epoch from clock_timestamp())
        )::text);
        RETURN NEW;
      END IF;
    END;
    $$;
  `
}

export type RealtimeFunctionName = typeof NOTIFY_FUNCTION_NAME | typeof PRESENCE_FUNCTION_NAME

const FUNCTION_VERSION: Record<RealtimeFunctionName, string> = {
  [NOTIFY_FUNCTION_NAME]: REALTIME_FUNCTION_VERSION,
  [PRESENCE_FUNCTION_NAME]: PRESENCE_FUNCTION_VERSION,
}

/** The version comment that goes with each function's current body. */
export function functionCommentSql(schemaName: string, name: RealtimeFunctionName): string {
  return `COMMENT ON FUNCTION ${ident(schemaName)}.${name}() IS ${literal(FUNCTION_VERSION[name])};`
}

/**
 * The current definition and its comment, as one string of statements: sent
 * without parameters it is one transaction, so the comment never names a body
 * that is not there.
 */
export function currentFunctionSql(schemaName: string, name: RealtimeFunctionName): string {
  const body = name === NOTIFY_FUNCTION_NAME ? notifyFunctionSql(schemaName) : presenceFunctionSql(schemaName)
  return `${body}\n${functionCommentSql(schemaName, name)}`
}

/**
 * A function is current when its comment is the version above AND its body
 * reads the channel from the platform. Both, because an older release writes
 * its own body under its own comment, and a restore can put back either.
 */
export function isCurrentFunction(name: RealtimeFunctionName, comment: string | null, source: string | null): boolean {
  return comment === FUNCTION_VERSION[name] && typeof source === 'string' && source.includes(CHANNEL_LOOKUP_MARKER)
}

const CURRENT_FUNCTION_SQL = `(
  COALESCE(pg_catalog.obj_description(p.oid, 'pg_proc'), '') =
    CASE p.proname::text
      WHEN '${NOTIFY_FUNCTION_NAME}' THEN ${literal(REALTIME_FUNCTION_VERSION)}
      ELSE ${literal(PRESENCE_FUNCTION_VERSION)}
    END
  AND pg_catalog.strpos(p.prosrc, '${CHANNEL_LOOKUP_MARKER}') > 0
)`

export interface RealtimeFunctionRow {
  schema_name: string
  function_name: RealtimeFunctionName
  current: boolean
}

/** $1 schema names. The two functions of each schema that has them, and whether each is current. */
export const FUNCTION_STATE_SQL = `
SELECT n.nspname::text AS schema_name,
       p.proname::text AS function_name,
       ${CURRENT_FUNCTION_SQL} AS current
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY($1::name[])
   AND p.proname IN ('${NOTIFY_FUNCTION_NAME}', '${PRESENCE_FUNCTION_NAME}')
   AND p.pronargs = 0
`

/**
 * The same for every project schema in the database: a project's own, and the
 * schemas kept beside it (a branch, a restore's set-aside copy).
 */
export const ALL_FUNCTION_STATE_SQL = `
SELECT n.nspname::text AS schema_name,
       p.proname::text AS function_name,
       ${CURRENT_FUNCTION_SQL} AS current
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_[a-z0-9_]+)?$'
   AND p.proname IN ('${NOTIFY_FUNCTION_NAME}', '${PRESENCE_FUNCTION_NAME}')
   AND p.pronargs = 0
 ORDER BY 1, 2
`

/** A project's own schema, as PostgreSQL names it: `workspace_<uuid>` and nothing after. */
export const PROJECT_SCHEMA_SQL_RE = '^workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
