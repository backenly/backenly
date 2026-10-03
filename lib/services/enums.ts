/**
 * ENUM TYPES AND DOMAINS, IN A PROJECT'S OWN SCHEMA
 * ================================================
 *
 * The last REAL_GAP in Postgres admin. A project could have a status column that
 * is `text` with a CHECK constraint, or an enum somebody created out of band, and
 * the dashboard could neither see it nor make one.
 *
 * ── Scoped to the workspace schema, like everything else ────────────────────
 *
 * Types are created in `workspace_<projectId>`, never in `public`. A type in
 * `public` is visible to every schema in the database, which on Cloud means
 * every tenant; the schema name is derived through `workspaceSchemaName`, which
 * validates the project id rather than interpolating it.
 *
 * ── What PostgreSQL can and cannot do, said plainly ─────────────────────────
 *
 * ADD VALUE       supported, and safe: it appends to the type.
 * RENAME VALUE    supported. Existing rows follow, because rows store an OID and
 *                 not the label, but any application code matching on the old
 *                 string stops matching — which is why it is reported as a
 *                 dependency-bearing change rather than a rename.
 * DROP VALUE      NOT SUPPORTED BY POSTGRESQL. There is no ALTER TYPE ... DROP
 *                 VALUE, at any version. The honest answer is to say so and
 *                 explain the real procedure, not to quietly emulate it by
 *                 recreating the type and rewriting every dependent column,
 *                 which is a data-rewriting migration wearing a button.
 * DROP TYPE       supported only when nothing depends on it, and the dependents
 *                 are listed first.
 *
 * ── ADD VALUE and transactions ──────────────────────────────────────────────
 *
 * Before PostgreSQL 12, `ALTER TYPE ... ADD VALUE` could not run inside a
 * transaction block at all. From 12 it can, but the new value cannot be USED in
 * the same transaction. Either way, running it outside an explicit transaction
 * is the only form that behaves the same across supported servers, so that is
 * what this does.
 */

import { queryWorkspaceSchema, executeInWorkspaceSchema } from './workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

/** A PostgreSQL identifier Backenly is willing to create. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Labels are user-facing strings, so they are far less constrained than
 * identifiers — but they still cannot contain a NUL, and a label long enough to
 * exceed PostgreSQL's 64-byte name limit is refused here rather than by a
 * confusing server error.
 */
const MAX_LABEL_BYTES = 63

export interface EnumType {
  name: string
  values: string[]
  /** Columns that use this type, as `table.column`. */
  usedBy: string[]
}

export interface DomainType {
  name: string
  baseType: string
  notNull: boolean
  default: string | null
  /** CHECK expressions attached to the domain. */
  constraints: string[]
  usedBy: string[]
}

export interface TypeInventory {
  enums: EnumType[]
  domains: DomainType[]
}

export class TypeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypeValidationError'
  }
}

function assertIdentifier(value: string, what: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new TypeValidationError(
      `${what} must be lower case, start with a letter or underscore, and contain only ` +
        `letters, digits and underscores. PostgreSQL would fold or quote anything else, ` +
        `and a type whose real name differs from the one you typed is a trap.`,
    )
  }
}

function assertLabel(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeValidationError('An enum value cannot be empty.')
  }
  if (value.includes('\0')) {
    throw new TypeValidationError('An enum value cannot contain a NUL byte.')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_LABEL_BYTES) {
    throw new TypeValidationError(
      `"${value.slice(0, 20)}…" is longer than PostgreSQL's ${MAX_LABEL_BYTES}-byte limit for an enum value.`,
    )
  }
}

/** Single-quote a string literal for SQL. Labels are values, not identifiers. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// ── Introspection ────────────────────────────────────────────────────────────

/**
 * Every enum and domain in the project's schema, with what uses them.
 *
 * `usedBy` is the load-bearing part. A type with dependents cannot be dropped
 * and should not be renamed casually, and an operator deciding that needs to see
 * the list rather than discover it from an error.
 */
export async function listTypes(projectId: string): Promise<TypeInventory> {
  const schema = workspaceSchemaName(projectId)

  const enumRows = (await queryWorkspaceSchema(
    projectId,
    `SELECT t.typname AS name,
            -- ::text is load-bearing. enumlabel has the "name" type, so
            -- array_agg yields name[], for which node-pg has no array parser:
            -- the driver hands back the raw literal as a STRING instead of an
            -- array, and every caller silently gets the wrong shape.
            array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = $1
      GROUP BY t.typname
      ORDER BY t.typname`,
    schema,
  )) as Array<{ name: string; values: string[] }>

  const domainRows = (await queryWorkspaceSchema(
    projectId,
    `SELECT t.typname AS name,
            format_type(t.typbasetype, t.typtypmod) AS base_type,
            t.typnotnull AS not_null,
            pg_get_expr(t.typdefaultbin, 0) AS default_expr,
            COALESCE(
              array_agg(pg_get_constraintdef(c.oid)) FILTER (WHERE c.oid IS NOT NULL),
              '{}'
            ) AS constraints
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_constraint c ON c.contypid = t.oid
      WHERE n.nspname = $1 AND t.typtype = 'd'
      GROUP BY t.typname, t.typbasetype, t.typtypmod, t.typnotnull, t.typdefaultbin
      ORDER BY t.typname`,
    schema,
  )) as Array<{
    name: string
    base_type: string
    not_null: boolean
    default_expr: string | null
    constraints: string[]
  }>

  // Which columns use which type, in one query rather than per type.
  const usageRows = (await queryWorkspaceSchema(
    projectId,
    `SELECT t.typname AS type_name,
            c.relname AS table_name,
            a.attname AS column_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
      WHERE tn.nspname = $1
        AND n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    schema,
  )) as Array<{ type_name: string; table_name: string; column_name: string }>

  const usage = new Map<string, string[]>()
  for (const row of usageRows) {
    const list = usage.get(row.type_name) ?? []
    list.push(`${row.table_name}.${row.column_name}`)
    usage.set(row.type_name, list)
  }

  return {
    enums: enumRows.map(r => ({
      name: r.name,
      values: r.values ?? [],
      usedBy: (usage.get(r.name) ?? []).sort(),
    })),
    domains: domainRows.map(r => ({
      name: r.name,
      baseType: r.base_type,
      notNull: r.not_null,
      default: r.default_expr,
      constraints: r.constraints ?? [],
      usedBy: (usage.get(r.name) ?? []).sort(),
    })),
  }
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create an enum type.
 *
 * Duplicate values are refused here rather than by PostgreSQL, because its error
 * names the value but not the fact that the rest of the statement was discarded.
 */
export async function createEnum(
  projectId: string,
  name: string,
  values: string[],
): Promise<void> {
  assertIdentifier(name, 'An enum name')
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeValidationError('An enum needs at least one value.')
  }
  values.forEach(assertLabel)

  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeValidationError(`"${value}" appears more than once. Enum values must be unique.`)
    }
    seen.add(value)
  }

  const schema = workspaceSchemaName(projectId)
  await executeInWorkspaceSchema(
    projectId,
    `CREATE TYPE "${schema}"."${name}" AS ENUM (${values.map(quoteLiteral).join(', ')})`,
  )
}

/**
 * Append a value to an existing enum.
 *
 * The safe change, and the common one. `IF NOT EXISTS` so re-adding is not an
 * error, and `BEFORE`/`AFTER` is deliberately not offered: sort order is a
 * display concern that an ORDER BY expresses without rewriting a type.
 */
export async function addEnumValue(
  projectId: string,
  name: string,
  value: string,
): Promise<void> {
  assertIdentifier(name, 'An enum name')
  assertLabel(value)

  const schema = workspaceSchemaName(projectId)
  // Deliberately NOT wrapped in a transaction. Before PostgreSQL 12 this could
  // not run inside one at all, and from 12 the new value cannot be used in the
  // same transaction, so the un-wrapped form is the one that behaves the same
  // on every supported server.
  await executeInWorkspaceSchema(
    projectId,
    `ALTER TYPE "${schema}"."${name}" ADD VALUE IF NOT EXISTS ${quoteLiteral(value)}`,
  )
}

/**
 * Rename one value of an enum.
 *
 * Stored rows follow automatically — a row holds the OID, not the label — but
 * anything comparing the old string stops matching, which is why the route
 * surfaces the dependent columns before doing it.
 */
export async function renameEnumValue(
  projectId: string,
  name: string,
  from: string,
  to: string,
): Promise<void> {
  assertIdentifier(name, 'An enum name')
  assertLabel(from)
  assertLabel(to)

  const schema = workspaceSchemaName(projectId)
  await executeInWorkspaceSchema(
    projectId,
    `ALTER TYPE "${schema}"."${name}" RENAME VALUE ${quoteLiteral(from)} TO ${quoteLiteral(to)}`,
  )
}

/**
 * Why a value cannot be removed.
 *
 * Exported as a function returning a message rather than implemented as a
 * mutation, because the answer is a property of PostgreSQL and not a Backenly
 * policy. Emulating it would mean creating a replacement type, rewriting every
 * dependent column, and dropping the old one — a data-rewriting migration
 * presented as a button, which is exactly the "governed mutation" line this
 * product draws.
 */
export function explainDropValueUnsupported(name: string, value: string): string {
  return (
    `PostgreSQL has no ALTER TYPE ... DROP VALUE, at any version, so "${value}" cannot be ` +
    `removed from ${name} in place. Removing it means creating a new type without that ` +
    `value, converting every column that uses ${name}, and dropping the old type — a ` +
    `migration that rewrites data, not a settings change. Backenly does not do that behind ` +
    `a button. Rows already holding "${value}" would also need somewhere to go first.`
  )
}

// ── Domains ──────────────────────────────────────────────────────────────────

/**
 * Base types a domain may be built on.
 *
 * An allowlist for the same reason the extension list is one: `CREATE DOMAIN x
 * AS <anything>` takes a type expression, and a type expression from a request
 * is an injection point that no amount of quoting fixes, because the danger is
 * that it is a valid expression rather than that it is malformed.
 */
export const DOMAIN_BASE_TYPES = [
  'text',
  'varchar',
  'char',
  'integer',
  'bigint',
  'smallint',
  'numeric',
  'real',
  'double precision',
  'boolean',
  'date',
  'timestamp',
  'timestamptz',
  'time',
  'uuid',
  'jsonb',
  'json',
  'inet',
  'bytea',
] as const

export type DomainBaseType = (typeof DOMAIN_BASE_TYPES)[number]

export function isDomainBaseType(value: unknown): value is DomainBaseType {
  return typeof value === 'string' && (DOMAIN_BASE_TYPES as readonly string[]).includes(value)
}

export interface DomainSpec {
  name: string
  baseType: string
  notNull?: boolean
  /**
   * A CHECK expression over `VALUE`.
   *
   * Accepted as free text because a constraint IS an expression and there is no
   * useful allowlist for one — but see the guard below: it must mention VALUE,
   * and it is wrapped so it cannot close the statement and start another.
   */
  check?: string | null
}

/**
 * Create a domain.
 *
 * The CHECK expression is the one place here that takes SQL from the caller, and
 * it is bounded rather than trusted: PostgreSQL parses it as a single expression
 * inside parentheses, so a `;` cannot start a second statement. It must mention
 * VALUE, which is what makes it a constraint on the domain rather than an
 * arbitrary predicate, and it is length-capped.
 *
 * This is a narrower surface than "run SQL", which is what makes it acceptable
 * under the governed-mutation model. It is not a general expression evaluator.
 */
export async function createDomain(projectId: string, spec: DomainSpec): Promise<void> {
  assertIdentifier(spec.name, 'A domain name')

  if (!isDomainBaseType(spec.baseType)) {
    throw new TypeValidationError(
      `${String(spec.baseType).slice(0, 40)} is not a base type Backenly will build a domain on. ` +
        `Allowed: ${DOMAIN_BASE_TYPES.join(', ')}.`,
    )
  }

  const parts = [`CREATE DOMAIN "${workspaceSchemaName(projectId)}"."${spec.name}" AS ${spec.baseType}`]

  if (spec.notNull) parts.push('NOT NULL')

  if (spec.check != null && spec.check.trim() !== '') {
    const check = spec.check.trim()
    if (check.length > 500) {
      throw new TypeValidationError('A domain CHECK expression must be under 500 characters.')
    }
    if (!/\bVALUE\b/i.test(check)) {
      throw new TypeValidationError(
        'A domain CHECK must refer to VALUE — that is the column being checked. ' +
          'For example: VALUE > 0, or VALUE ~ \'^[a-z]+$\'.',
      )
    }
    if (check.includes('\0')) {
      throw new TypeValidationError('A CHECK expression cannot contain a NUL byte.')
    }
    // Parenthesised, so the parser treats it as one expression. A `;` inside
    // cannot terminate the statement and begin another.
    parts.push(`CHECK (${check})`)
  }

  await executeInWorkspaceSchema(projectId, parts.join(' '))
}

/**
 * Drop an enum or domain, only when nothing uses it.
 *
 * No CASCADE. CASCADE here would drop the columns typed by this type, which is
 * data, and the dashboard cannot show what that would take with it. The
 * dependent list is returned instead so an operator can deal with them
 * deliberately.
 */
export async function dropType(
  projectId: string,
  name: string,
): Promise<{ dropped: boolean; usedBy: string[] }> {
  assertIdentifier(name, 'A type name')

  const inventory = await listTypes(projectId)
  const existing =
    inventory.enums.find(e => e.name === name) ?? inventory.domains.find(d => d.name === name)

  if (!existing) return { dropped: false, usedBy: [] }
  if (existing.usedBy.length > 0) return { dropped: false, usedBy: existing.usedBy }

  await executeInWorkspaceSchema(
    projectId,
    `DROP TYPE "${workspaceSchemaName(projectId)}"."${name}"`,
  )
  return { dropped: true, usedBy: [] }
}
