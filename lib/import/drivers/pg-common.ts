/**
 * The flow both Postgres drivers share (Supabase is a Postgres with Auth and
 * Storage beside it): connect safely, read one snapshot, plan, create the
 * tables through the governed kernel, copy the rows, verify the counts, then
 * the keys rows could not satisfy while arriving, and the access rules held
 * for approval. lib/import/drivers/supabase.ts adds users and files.
 */

import { randomBytes } from 'crypto'
import type { ImportPreview, ImportPreviewBucket, ImportProgressTable, ImportSourceId } from '../contract'
import { ImportInputError, type DriverContext, type RunContext, type RunResult } from '../driver'
import { connectSource, isSupabaseHost, parsePostgresUrl, readSnapshot, supabaseRefOf, type ParsedPgUrl, type SourceConnection, type SourceReader } from '../net'
import { authShape, countAuthUsers, countRows, existingSchemas, readCatalog, schemaBytes, type AuthCounts, type AuthShape } from '../pg-source'
import { buildPlan, type ImportPlan, type SourceCatalog } from '../pg-plan'
import { previewRules, proposeRules, recordRulesForApproval, type RuleProposal } from '../rules'
import { fileRefusal, formatBytes, rowRefusal } from '../limits'
import { addDeferredKeys, copyRows, createTables, destinationCounts, throwIfAborted } from '../pg-engine'
import { copyAuthUsers, prepareUsersTable } from '../supabase-auth'
import { copyFiles, createBuckets, walkObjects, type StorageSource, type SupabaseBucket } from '../supabase-storage'

export interface OpenedSource {
  conn: SourceConnection
  parsed: ParsedPgUrl
}

/** Parse and connect. A Supabase host is only ever reached encrypted, whichever source was picked. */
export async function openSource(connectionString: string, secrets: readonly string[]): Promise<OpenedSource> {
  const parsed = parsePostgresUrl(connectionString)
  const conn = await connectSource(parsed, { requireTls: isSupabaseHost(parsed.host), secrets })
  return { conn, parsed }
}

/** The name to prefill the new project with. */
export async function sourceLabelOf(db: SourceReader, parsed: ParsedPgUrl, source: ImportSourceId): Promise<string> {
  if (source === 'supabase') {
    const ref = supabaseRefOf(parsed)
    if (ref) return ref
  }
  const r = await db.query<{ db: string }>('SELECT current_database() AS db')
  const name = r.rows[0]?.db ?? parsed.database
  if (name && name !== 'postgres') return name
  const host = parsed.host.split('.')[0]
  return host && !/^\d+$/.test(host) ? host : 'postgres'
}

export interface Analysis {
  catalog: SourceCatalog
  plan: ImportPlan
  schemas: string[]
  proposals: RuleProposal[]
  ruleWarnings: string[]
  auth: { shape: AuthShape; counts: AuthCounts } | null
  rowBytes: number
  /** Tables whose rows RLS hides from the connecting user. */
  hidden: string[]
}

/** Read the catalog, count, plan and translate the rules, inside the caller's snapshot. */
export async function analyze(
  db: SourceReader,
  opts: { source: 'supabase' | 'postgres'; schemas: string[]; usersMoving: boolean; withAuth: boolean; countAll: boolean },
): Promise<Analysis> {
  const present = await existingSchemas(db, opts.schemas)
  const missing = opts.schemas.filter((s) => !present.includes(s))
  if (present.length === 0) {
    throw new ImportInputError(`This database has no schema named ${opts.schemas.join(', ')}.`, 'schemas')
  }
  const catalog = await readCatalog(db, present)
  await countRows(db, catalog.tables, opts.countAll ? { all: true } : undefined)

  let auth: Analysis['auth'] = null
  if (opts.withAuth) {
    const shape = await authShape(db)
    if (shape.present) auth = { shape, counts: await countAuthUsers(db, shape) }
  }
  const plan = buildPlan(catalog, { source: opts.source, usersMoving: opts.usersMoving && !!auth, schemas: present })
  if (missing.length) plan.warnings.push(`No schema named ${missing.join(', ')} in this database; nothing from ${missing.length === 1 ? 'it' : 'them'} moves.`)
  const rls = new Map(catalog.tables.map((t) => [`${t.schema}.${t.name}`, t.rlsEnabled]))
  const { proposals, warnings } = proposeRules(plan, catalog.policies, rls, opts.source)
  const rowBytes = plan.tables.reduce((s, t) => s + t.bytes, 0)
  const hidden = catalog.tables.filter((t) => t.rowsHidden).map((t) => (t.schema === present[0] ? t.name : `${t.schema}.${t.name}`))
  return { catalog, plan, schemas: present, proposals, ruleWarnings: warnings, auth, rowBytes, hidden }
}

/**
 * Row-level security hides rows of these tables from the user Backenly
 * connected as, so a copy would be partial. Said, never copied around.
 */
export function hiddenRowsRefusal(hidden: string[], user: string): string | null {
  if (hidden.length === 0) return null
  const list = hidden.slice(0, 4).join(', ') + (hidden.length > 4 ? ` and ${hidden.length - 4} more` : '')
  return (
    `Row-level security hides rows of ${list} from the user ${user}, so Backenly would move only part of them. ` +
    `Connect as the tables' owner or a user with BYPASSRLS (on Supabase, the postgres user).`
  )
}

export function authWarnings(counts: AuthCounts): string[] {
  const out: string[] = []
  const n = (x: number, one: string, many: string) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`
  if (counts.providerOnly > 0) {
    out.push(`${n(counts.providerOnly, 'user signs', 'users sign')} in with Google, GitHub or another provider: they sign in the same way once you set that provider up in Backenly.`)
  }
  if (counts.emailOnly > 0) {
    out.push(`${n(counts.emailOnly, 'user has', 'users have')} no password (magic link): they sign in with a magic link, or set a password with Forgot password.`)
  }
  if (counts.phoneOnly > 0) out.push(`${n(counts.phoneOnly, 'phone-only user does', 'phone-only users do')} not move: Backenly signs users in by email.`)
  if (counts.anonymous > 0) out.push(`${n(counts.anonymous, 'anonymous user does', 'anonymous users do')} not move.`)
  return out
}

/** The Review step, from an analysis. */
export function previewOf(
  a: Analysis,
  input: {
    source: ImportSourceId
    sourceLabel: string
    buckets: ImportPreviewBucket[] | null
    warnings: string[]
    ctx: DriverContext
    /** The user Backenly connected as, for a refusal that names it. */
    user: string
  },
): ImportPreview {
  const tables = a.plan.tables.map((t) => ({
    sourceName: t.sourceSchema === a.schemas[0] ? t.sourceName : `${t.sourceSchema}.${t.sourceName}`,
    name: t.name,
    rows: t.rows,
    columns: a.catalog.tables.find((c) => c.schema === t.sourceSchema && c.name === t.sourceName)?.columns.length ?? t.columns.length,
    notes: t.rowsExact ? t.notes : [`About ${t.rows.toLocaleString('en-US')} rows (estimated)`, ...t.notes],
  }))
  const fileBytes = (input.buckets ?? []).reduce((s, b) => s + b.bytes, 0)
  const refusal =
    hiddenRowsRefusal(a.hidden, input.user) ?? rowRefusal(a.rowBytes, input.ctx.limits) ?? (input.buckets ? fileRefusal(fileBytes, input.ctx.limits) : null)
  const users = a.auth
    ? { total: a.auth.counts.total, withPassword: a.auth.counts.withPassword, providerOnly: a.auth.counts.providerOnly, skipped: a.auth.counts.skipped }
    : null
  return {
    source: input.source,
    sourceLabel: input.sourceLabel,
    tables,
    users,
    buckets: input.buckets,
    rules: previewRules(a.proposals),
    warnings: [...a.plan.warnings, ...a.ruleWarnings, ...(a.auth ? authWarnings(a.auth.counts) : []), ...input.warnings],
    refusal,
  }
}

/** The quick check before a project is created: the connection works and the source fits. */
export async function checkPg(
  connectionString: string,
  opts: { secrets: readonly string[]; schemas: string[]; ctx: DriverContext },
): Promise<void> {
  const { conn } = await openSource(connectionString, opts.secrets)
  try {
    await readSnapshot(conn, async (db) => {
      const present = await existingSchemas(db, opts.schemas)
      if (present.length === 0) throw new ImportInputError(`This database has no schema named ${opts.schemas.join(', ')}.`, 'schemas')
      // Partitions counted under their tables: a partitioned table alone measures 0.
      const refusal = rowRefusal(await schemaBytes(db, present), opts.ctx.limits)
      if (refusal) throw new ImportInputError(refusal)
    })
  } finally {
    await conn.end()
  }
}

// ── The run ───────────────────────────────────────────────────────────────────

export interface RunPgInput {
  source: 'supabase' | 'postgres'
  /** "Supabase" / "Postgres", for History and the rules' words. */
  label: string
  connectionString: string
  schemas: string[]
  secrets: readonly string[]
  /** Supabase only: move auth.users. */
  users: boolean
  /** Supabase only: move Storage files from here. */
  storage: StorageSource | null
  buckets: SupabaseBucket[] | null
  ctx: RunContext
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

export async function runPg(input: RunPgInput): Promise<RunResult> {
  const { ctx } = input
  const secret = randomBytes(32)
  const warnings: string[] = []
  const ledger = new Map<string, ImportProgressTable>()
  const push = (name: string) => ctx.progress({ tables: [{ ...ledger.get(name)! }] })

  const opened = await openSource(input.connectionString, input.secrets)
  const { conn } = opened
  let usersCopied: number | undefined
  let analysis: Analysis
  try {
    analysis = await readSnapshot(
      conn,
      async (db) => {
        const a = await analyze(db, {
          source: input.source,
          schemas: input.schemas,
          usersMoving: input.users,
          withAuth: input.source === 'supabase' && input.users,
          countAll: true,
        })
        const refusal = hiddenRowsRefusal(a.hidden, opened.parsed.user) ?? rowRefusal(a.rowBytes, ctx.limits)
        if (refusal) throw new ImportInputError(refusal, 'connectionString')
        if (a.plan.tables.length === 0 && !a.auth) throw new ImportInputError('There are no tables to move in this database.', 'connectionString')
        warnings.push(...a.plan.warnings, ...a.ruleWarnings, ...(a.auth ? authWarnings(a.auth.counts) : []))

        for (const t of a.plan.tables) ledger.set(t.name, { name: t.name, sourceRows: t.rows, copiedRows: 0, verified: false })
        const movingUsers = a.auth ? a.auth.counts.withPassword + a.auth.counts.providerOnly + a.auth.counts.emailOnly : 0
        ctx.progress({
          phase: 'tables',
          tables: [...ledger.values()],
          users: a.auth ? { total: movingUsers, copied: 0 } : null,
        })

        // The opening change: every table (and the users table), closed to all but the server key.
        await createTables(ctx.projectId, a.plan, {
          title: `Move in from ${input.label}: ${plural(a.plan.tables.length, 'table')}`,
          signal: ctx.signal,
          extra: a.auth ? () => prepareUsersTable(ctx.projectId, { social: a.auth!.counts.providerOnly > 0 }) : undefined,
        })

        ctx.progress({ phase: 'rows' })
        await copyRows(db, ctx.projectId, a.plan, {
          signal: ctx.signal,
          secret,
          onRows: (name, n) => {
            const row = ledger.get(name)
            if (!row) return
            row.copiedRows = n
            push(name)
          },
        })

        if (a.auth) {
          ctx.progress({ phase: 'users' })
          usersCopied = await copyAuthUsers(db, ctx.projectId, a.auth.shape, {
            signal: ctx.signal,
            onUsers: (n) => ctx.progress({ users: { total: movingUsers, copied: n } }),
          })
          if (usersCopied < movingUsers) {
            warnings.push(`${plural(movingUsers - usersCopied, 'user')} shared an address with another user (differing in case) and arrived once.`)
          }
        }

        ctx.progress({ phase: 'verifying' })
        const dest = await destinationCounts(ctx.projectId, a.plan.tables.map((t) => t.name))
        const short: string[] = []
        for (const t of a.plan.tables) {
          const row = ledger.get(t.name)!
          const n = dest.get(t.name) ?? 0
          row.copiedRows = n
          row.verified = n === t.rows
          push(t.name)
          if (!row.verified) short.push(`${t.name} has ${n.toLocaleString('en-US')} of ${t.rows.toLocaleString('en-US')} rows`)
        }
        if (short.length) throw new Error(`The rows did not all arrive: ${short.slice(0, 3).join('; ')}${short.length > 3 ? '; …' : ''}.`)
        return a
      },
      // The copy holds one snapshot for as long as it runs; each statement still has a limit.
      {},
    )
  } finally {
    await conn.end()
  }

  // The closing change: keys rows could not satisfy while arriving, and the buckets.
  const deferred = analysis.plan.tables.reduce((s, t) => s + t.deferredForeignKeys.length, 0)
  const buckets = input.storage && input.buckets ? input.buckets : null
  let targets: Map<string, { id: string; maxBytes: number }> | null = null
  if (deferred > 0 || (buckets && buckets.length > 0)) {
    const { withGovernedChange } = await import('@/lib/changes/ledger')
    const what = [deferred ? plural(deferred, 'foreign key') : null, buckets?.length ? plural(buckets.length, 'bucket') : null].filter(Boolean).join(' and ')
    await withGovernedChange({ projectId: ctx.projectId, title: `Move in from ${input.label}: ${what}` }, async () => {
      if (deferred) warnings.push(...(await addDeferredKeys(ctx.projectId, analysis.plan, ctx.signal)))
      if (buckets?.length) targets = await createBuckets(ctx.projectId, buckets)
    })
  }

  // Files: data, outside any change. Counted first, so the ledger can say "of".
  let filesCopied: number | undefined
  if (buckets && input.storage && targets) {
    ctx.progress({ phase: 'files' })
    let totalFiles = 0
    let totalBytes = 0
    for (const b of buckets) {
      for await (const o of walkObjects(input.storage, b, ctx.signal)) {
        totalFiles++
        totalBytes += o.size
      }
    }
    ctx.progress({ files: { total: totalFiles, copied: 0, bytes: totalBytes, copiedBytes: 0 } })
    const files = await copyFiles(input.storage, ctx.projectId, buckets, targets, {
      signal: ctx.signal,
      userId: ctx.userId,
      onFile: (copied, copiedBytes) => ctx.progress({ files: { total: totalFiles, copied, bytes: totalBytes, copiedBytes } }),
    })
    filesCopied = files.copied
    if (files.skipped.length) {
      const sample = files.skipped.slice(0, 3).map((s) => `${s.path} (${s.why})`).join(', ')
      warnings.push(`${plural(files.skipped.length, 'file')} did not move: ${sample}${files.skipped.length > 3 ? ', …' : ''}.`)
    }
    if (files.stoppedForQuota) warnings.push(`Files stopped at ${formatBytes(files.bytes)}: the plan's file storage is full.`)
  }

  throwIfAborted(ctx.signal)
  const rulesPending = await recordRulesForApproval(ctx.projectId, analysis.proposals, { sourceLabel: input.label, jobId: ctx.jobId ?? '' })
  ctx.progress({ rulesPending, phase: 'finished' })

  const rows = [...ledger.values()].reduce((s, t) => s + t.copiedRows, 0)
  return {
    importedFrom: {
      source: input.source,
      at: new Date().toISOString(),
      tables: analysis.plan.tables.length,
      rows,
      ...(usersCopied !== undefined ? { users: usersCopied } : {}),
      ...(filesCopied !== undefined ? { files: filesCopied } : {}),
      rulesPending,
    },
    warnings,
  }
}
