/**
 * MOVING A PROJECT INTO A DATABASE OF ITS OWN: THE RULES, WITHOUT A DATABASE
 * ===========================================================================
 * The parts of lib/data-plane/tenancy-migration.ts that decide rather than do:
 * what a run reports and how one line says it, how long each wait is, when two
 * catalogs are the same, and what the operator's script was asked
 * (scripts/migrate-project-databases.ts). Pure, so they are tested without a
 * database (tests/unit/tenancy-migration-rules.spec.ts).
 */

import { sameObject, tableSignature, type CatalogSnapshot } from '@/lib/changes/catalog'

// ── What a run reports ───────────────────────────────────────────────────────

/** The steps of a move, in order (the plan's 0 to 11), and the clean-up after one that stopped. */
export const MIGRATION_STEPS = [
  'preconditions',
  'create',
  'freeze',
  'lock',
  'snapshot',
  'dump',
  'replay',
  'verify',
  'flip',
  'fence',
  'resume',
  'smoke',
  'schedule_drop',
] as const
export type MigrationStep = (typeof MIGRATION_STEPS)[number]

/** Why a move did not start. Nothing was changed for any of them, unless `interrupted` says otherwise. */
export type RefusalCode =
  | 'invalid_project'
  | 'not_found'
  | 'deleted'
  | 'locked'
  | 'paused'
  | 'already_dedicated'
  | 'interrupted'
  | 'wrong_region'
  | 'not_configured'
  | 'unreachable'
  | 'no_template'
  | 'tools_missing'
  | 'import_running'
  | 'migration_running'
  | 'drift_pending'
  | 'no_recent_snapshot'
  | 'no_schema'
  | 'unknown_schema'
  | 'moved_schemas_present'
  | 'extension'

export type MigrationOutcome = 'moved' | 'dry_run_ok' | 'refused' | 'aborted'

/** One check of the verification, or of the smoke after the move. */
export interface MigrationCheck {
  id: string
  /** ok: passed; failed: did not; skipped: could not run here, and why is in `detail`. */
  state: 'ok' | 'failed' | 'skipped'
  detail: string
}

/** One table's rows on each side. Counts only: the checksums are compared, never kept. */
export interface TableComparison {
  schema: string
  table: string
  sourceRows: number
  targetRows: number
  checksumsEqual: boolean
}

export interface VerificationReport {
  ok: boolean
  checks: MigrationCheck[]
  tables: TableComparison[]
}

/** One line per step, as it is logged. */
export interface StepRecord {
  step: MigrationStep | 'abort'
  at: string
  detail: string
}

/** The record of one run: the job's result, what the operator's script prints from. */
export interface MigrationReport {
  projectId: string
  region: string | null
  dryRun: boolean
  outcome: MigrationOutcome
  /** The step a move stopped at, for `aborted`. */
  step?: MigrationStep
  code?: RefusalCode
  reason?: string
  /** The project's own database, once created (dropped again unless moved). */
  database?: string | null
  /** The epoch the move gave the project. */
  epoch?: number
  /** Every schema moved, and the name it was left under in the database it moved out of. */
  schemas: Array<{ name: string; leftAs?: string }>
  extensions: string[]
  verification?: VerificationReport
  smoke?: MigrationCheck[]
  /** What went wrong after the flip, which needs a person: the project is in its own database either way. */
  attention: string[]
  /** After a run that stopped: whether its database is gone again. */
  cleanup?: { databaseDropped: boolean; serving: boolean; detail: string }
  /** A move an earlier run left half done, finished by this one. */
  finishedInterrupted?: boolean
  steps: StepRecord[]
  startedAt: string
  finishedAt?: string
}

/**
 * The one line the operator's script prints for a run:
 *   moved / dry-run ok / refused <reason> / aborted <step> <reason>
 * with what needs a person after a move appended.
 */
export function describeOutcome(report: Pick<MigrationReport, 'outcome' | 'step' | 'code' | 'reason' | 'attention'>): string {
  const reason = (report.reason ?? '').replace(/\s+/g, ' ').trim()
  switch (report.outcome) {
    case 'moved':
      return report.attention.length > 0 ? `moved, needs attention: ${report.attention.join('; ')}` : 'moved'
    case 'dry_run_ok':
      return 'dry-run ok'
    case 'refused':
      return `refused ${report.code ?? 'unknown'}${reason ? `: ${reason}` : ''}`
    case 'aborted':
      return `aborted ${report.step ?? 'unknown'}${reason ? `: ${reason}` : ''}`
  }
}

// ── How long it waits ────────────────────────────────────────────────────────

/**
 * The longest any one piece of work on a project's data can still be running
 * after the doors close: the data API's upstream (15 s,
 * server/routes/postgrest-handler.ts), a function run's hard limit (15 s,
 * lib/services/ai-functions/route-module-runner.ts), a workspace statement
 * (5 s by default, lib/services/workspace-pool.ts), a change waiting for its
 * lock (30 s, lib/changes/lock.ts) and a realtime stream's re-check of its
 * project (every 25 s, server/routes/realtime.ts), with room to spare.
 */
export const LONGEST_REQUEST_MS = 60_000

export interface MigrationWaits {
  /** After the freeze, before the copy: until no door can still be serving from a cached answer. */
  freezeMs: number
  /** After the flip, before the old schemas are renamed and the project serves again. */
  flipMs: number
  /** How long sessions of the project's logins are given to end once they are ended. */
  sessionsMs: number
  /** How long the project's own PostgREST is given to answer when it is first asked. */
  probeMs: number
}

/**
 * The waits, from the bounds they cover:
 *
 *   freeze  the serving-state cache's freshness and its stale grace
 *           (FRESH_MS + STALE_SERVING_GRACE_MS, lib/projects/serving-state.ts),
 *           then the longest request already running (LONGEST_REQUEST_MS);
 *   flip    a schema PostgREST served must stay until any cache rebuild that
 *           read the old list has finished (DROP_AFTER_MS,
 *           lib/postgrest/retire-schema.ts), and no process may still hold the
 *           project's old placement (SHARED_PLACEMENT_MAX_AGE_MS,
 *           lib/data-plane/regional.ts, plus FRESH_MS for the serving read that
 *           carries the epoch): the longer of the two.
 */
export function defaultWaits(bounds: {
  freshMs: number
  staleServingGraceMs: number
  dropAfterMs: number
  placementMaxAgeMs: number
}): MigrationWaits {
  return {
    freezeMs: bounds.freshMs + bounds.staleServingGraceMs + LONGEST_REQUEST_MS,
    flipMs: Math.max(bounds.dropAfterMs, bounds.placementMaxAgeMs + bounds.freshMs),
    sessionsMs: 10_000,
    probeMs: 30_000,
  }
}

// ── When two catalogs are the same ───────────────────────────────────────────

/**
 * The differences between a schema's catalog in the database it leaves and in
 * the one it moved to, as lines; none when they are the same. Tables compare
 * by tableSignature (lib/changes/catalog.ts), which leaves out grants, oids,
 * column order and what the data plane and direct access add on their own;
 * owners are not in a catalog snapshot at all. Objects compare by sameObject.
 */
export function catalogDifferences(source: CatalogSnapshot, target: CatalogSnapshot): string[] {
  const out: string[] = []
  const sourceTables = Object.keys(source.tables).sort()
  const targetTables = Object.keys(target.tables).sort()
  for (const name of sourceTables) {
    const there = target.tables[name]
    if (!there) {
      out.push(`table ${name} is missing`)
      continue
    }
    if (tableSignature(source.tables[name]) !== tableSignature(there)) out.push(`table ${name} differs`)
  }
  for (const name of targetTables) if (!source.tables[name]) out.push(`table ${name} is extra`)

  const sourceObjects = source.objects ?? {}
  const targetObjects = target.objects ?? {}
  for (const id of Object.keys(sourceObjects).sort()) {
    const there = targetObjects[id]
    if (!there) out.push(`${sourceObjects[id].kind} ${id} is missing`)
    else if (!sameObject(sourceObjects[id], there)) out.push(`${sourceObjects[id].kind} ${id} differs`)
  }
  for (const id of Object.keys(targetObjects).sort()) {
    if (!sourceObjects[id]) out.push(`${targetObjects[id].kind} ${id} is extra`)
  }
  return out
}

// ── What the operator asked ──────────────────────────────────────────────────

export type MigrationCommand =
  | { mode: 'migrate'; region: string; projects: string[] | 'all'; batch: number; dryRun: boolean }
  | { mode: 'report'; region: string }
  | { mode: 'revoke_public_connect'; region: string; extraRoles: string[] }

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const MIGRATION_USAGE = [
  'Usage:',
  '  npx tsx scripts/migrate-project-databases.ts --region <region> --project <id> [--dry-run]',
  '  npx tsx scripts/migrate-project-databases.ts --region <region> --all [--batch <n>] [--dry-run]',
  '  npx tsx scripts/migrate-project-databases.ts --region <region> --report',
  '  npx tsx scripts/migrate-project-databases.ts --region <region> --revoke-public-connect [--grant-connect <role,...>]',
].join('\n')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * The operator script's arguments. Exactly one of --project (repeatable),
 * --all, --report or --revoke-public-connect, always with --region. --batch
 * (default 1, at most 20) is how many moves run at once in the region;
 * --dry-run moves nothing.
 */
export function parseMigrationArgs(argv: string[], knownRegions: readonly string[]): MigrationCommand {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  const TAKES_VALUE = new Set(['--region', '--project', '--batch', '--grant-connect'])
  const FLAGS = new Set(['--all', '--dry-run', '--report', '--revoke-public-connect'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (TAKES_VALUE.has(arg)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      values.set(arg, [...(values.get(arg) ?? []), value])
      i++
    } else if (FLAGS.has(arg)) {
      flags.add(arg)
    } else {
      throw new UsageError(`Unknown argument: ${arg}`)
    }
  }

  const regions = values.get('--region') ?? []
  if (regions.length !== 1) throw new UsageError('--region is required, once')
  const region = regions[0]
  if (!knownRegions.includes(region)) throw new UsageError(`Unknown region ${region}: one of ${knownRegions.join(', ')}`)

  const projects = values.get('--project') ?? []
  const modes = [projects.length > 0, flags.has('--all'), flags.has('--report'), flags.has('--revoke-public-connect')].filter(Boolean)
  if (modes.length !== 1) throw new UsageError('Give exactly one of --project <id>, --all, --report or --revoke-public-connect')

  if (flags.has('--report')) {
    if (flags.has('--dry-run') || values.has('--batch') || values.has('--grant-connect')) throw new UsageError('--report takes only --region')
    return { mode: 'report', region }
  }
  if (flags.has('--revoke-public-connect')) {
    if (flags.has('--dry-run') || values.has('--batch')) throw new UsageError('--revoke-public-connect takes only --region and --grant-connect')
    const extraRoles = (values.get('--grant-connect') ?? []).flatMap((v) => v.split(',')).map((r) => r.trim()).filter(Boolean)
    for (const role of extraRoles) if (!ROLE.test(role)) throw new UsageError(`Not a role name: ${role}`)
    return { mode: 'revoke_public_connect', region, extraRoles: [...new Set(extraRoles)] }
  }
  if (values.has('--grant-connect')) throw new UsageError('--grant-connect goes with --revoke-public-connect')

  for (const id of projects) if (!UUID.test(id)) throw new UsageError(`Not a project id: ${id}`)
  const batchValues = values.get('--batch') ?? []
  if (batchValues.length > 1) throw new UsageError('--batch is given once')
  const batch = batchValues.length === 0 ? 1 : Number(batchValues[0])
  if (!Number.isInteger(batch) || batch < 1 || batch > 20) throw new UsageError('--batch is a whole number from 1 to 20')
  return {
    mode: 'migrate',
    region,
    projects: flags.has('--all') ? 'all' : [...new Set(projects)],
    batch,
    dryRun: flags.has('--dry-run'),
  }
}

// ── The replay's order ───────────────────────────────────────────────────────

/**
 * A project database is cloned from a template whose event triggers act as
 * tables change: the data plane adds its soft-delete policy to every table in a
 * served schema that has row level security on and a deleted_at column
 * (backenly_pgrst_on_ddl, scripts/sql/postgrest-ddl-sync.sql). Replayed in the
 * dump's own order, `ALTER TABLE … ENABLE ROW LEVEL SECURITY` makes that policy,
 * and the dump's own `CREATE POLICY` for it then fails, so every table Backenly
 * made (each has deleted_at and starts closed) stopped a move at replay.
 *
 * So the replay restores every entry but the policies, then drops whatever
 * policy the triggers made in the moved schemas (dropPoliciesSql), then
 * restores the source's policies exactly as they were, with the comments on
 * them. The target ends with the source's policies, no more and no fewer, and
 * the verification compares them as before.
 *
 * `pg_restore --list` prints one entry a line, `<id>; <tableoid> <oid> <type>
 * <schema> <name> <owner>` (PostgreSQL 16, pg_backup_archiver.c
 * PrintTOCSummary), and lines starting with `;` are comments. A policy's type
 * is POLICY; a comment on one is type COMMENT with a name starting `POLICY `.
 * The moved schemas are Backenly's own names, so the schema is one word.
 */
export function splitRestoreList(list: string): { rest: string; policies: string } {
  const rest: string[] = []
  const policies: string[] = []
  for (const line of list.split('\n')) {
    const entry = /^\d+; \d+ \d+ (.*)$/.exec(line)?.[1]
    if (entry === undefined) {
      rest.push(line)
      policies.push(line)
    } else if (entry.startsWith('POLICY ') || /^COMMENT \S+ POLICY /.test(entry)) {
      policies.push(line)
    } else {
      rest.push(line)
    }
  }
  return { rest: rest.join('\n'), policies: policies.join('\n') }
}

/**
 * Between the two halves of the replay (splitRestoreList): every policy in the
 * moved schemas is dropped. They are only what the template's event triggers
 * made as the tables were restored; the source's follow.
 */
export function dropPoliciesSql(schemas: string[]): string {
  if (schemas.length === 0) throw new Error('dropPoliciesSql needs the moved schemas')
  const names = schemas.map((schema) => `'${schema.replace(/'/g, "''")}'`).join(', ')
  return [
    '',
    "-- Backenly: the policies the project database's own event triggers made as the tables above were restored,",
    "-- dropped, so that the source's policies, which follow, are restored exactly as they were.",
    'DO $backenly_replay$',
    'DECLARE p record;',
    'BEGIN',
    '  FOR p IN SELECT schemaname, tablename, policyname FROM pg_catalog.pg_policies',
    `           WHERE schemaname = ANY (ARRAY[${names}]::text[])`,
    '  LOOP',
    "    EXECUTE pg_catalog.format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);",
    '  END LOOP;',
    'END',
    '$backenly_replay$;',
    '',
  ].join('\n')
}

// ── The verification's read through the project's own PostgREST ──────────────

/**
 * The table the verification reads through the project's own PostgREST, as the
 * service role: the first of the canonical schema's tables, in the order given,
 * whose name PostgREST takes as it is and which the service role may read in
 * the database the project moves out of. Null when there is none: then the
 * root is read.
 *
 * Only a table the service role reads at the source, because Backenly closes
 * some on purpose: `users` (the project's end users, behind the auth routes)
 * and every table whose name starts with `_` (backenly_pgrst_revoke_internal,
 * scripts/sql/postgrest-schema-registry.sql). Reading one of those answers 403
 * in both databases, which said nothing about the copy and stopped every move
 * of a project whose first table was `users`. A 403 on a table the service
 * role reads at the source does mean the copy lost something.
 */
export function postgrestProbeTable(tables: readonly string[], readableAtSource: ReadonlySet<string>): string | null {
  return tables.find((table) => /^[A-Za-z][A-Za-z0-9_]*$/.test(table) && readableAtSource.has(table)) ?? null
}

// ── The API roles' privileges, carried exactly ──────────────────────────────

/** Whose privileges a move carries: PUBLIC and the roles the REST API serves requests as. */
export const CARRIED_GRANTEES = ['PUBLIC', 'anon', 'authenticated', 'service_role'] as const

/** One relation's or routine's privileges for CARRIED_GRANTEES, as `grantee PRIVILEGE` lines, sorted. */
export interface ObjectPrivileges {
  /** `table` (a table, view, materialized view or foreign table), `sequence` or `routine`. */
  kind: 'table' | 'sequence' | 'routine'
  /** Quoted and schema-qualified: format('%I.%I') for a relation, regprocedure for a routine. */
  identity: string
  grants: string[]
}

/**
 * A move restores the dump without privileges: the project database's own
 * event triggers grant the API roles what they grant a new table, at the moment
 * each table is made, so a serial column's sequence (made after its table) and
 * a change-vault table come out without the grants they had, and a routine gets
 * PostgreSQL's default, EXECUTE for PUBLIC, though it was closed. So the replay
 * ends by giving every object exactly the source's privileges for these
 * grantees (privilegeStatements), and the verification compares them
 * (privilegeDifferences). Objects only one side has are the catalog check's.
 *
 * A table grant narrowed in the canonical schema is carried too, and then lasts
 * as long as it would have at the source: registering the schema (every resume,
 * the move's own included) and making a table in it give the API roles its
 * tables again, in both databases (backenly_pgrst_prepare_schema).
 */
export function privilegeDifferences(source: Map<string, ObjectPrivileges>, target: Map<string, ObjectPrivileges>): string[] {
  const out: string[] = []
  for (const [key, a] of [...source].sort(([x], [y]) => x.localeCompare(y))) {
    const b = target.get(key)
    if (!b) continue
    const missing = a.grants.filter((g) => !b.grants.includes(g))
    const extra = b.grants.filter((g) => !a.grants.includes(g))
    if (missing.length || extra.length) {
      out.push(`${a.kind} ${a.identity}:${missing.length ? ' lacks ' + missing.join(', ') : ''}${extra.length ? ' has ' + extra.join(', ') + ' it did not' : ''}`)
    }
  }
  return out
}

/** The statements that give `target` exactly the privileges `source` holds for CARRIED_GRANTEES. */
export function privilegeStatements(source: ObjectPrivileges): string[] {
  const on = `${source.kind === 'routine' ? 'ROUTINE' : source.kind === 'sequence' ? 'SEQUENCE' : 'TABLE'} ${source.identity}`
  const out = [`REVOKE ALL ON ${on} FROM ${CARRIED_GRANTEES.join(', ')}`]
  const byGrantee = new Map<string, string[]>()
  for (const line of source.grants) {
    const [grantee, privilege] = line.split(' ')
    if (!(CARRIED_GRANTEES as readonly string[]).includes(grantee) || !/^[A-Z]+$/.test(privilege ?? '')) {
      throw new Error(`not a carried privilege: ${line}`)
    }
    byGrantee.set(grantee, [...(byGrantee.get(grantee) ?? []), privilege])
  }
  for (const grantee of CARRIED_GRANTEES) {
    const privileges = byGrantee.get(grantee)
    if (privileges) out.push(`GRANT ${privileges.join(', ')} ON ${on} TO ${grantee}`)
  }
  return out
}
