/**
 * ARCHITECT SPEC VALIDATOR + ENRICHER
 * ===================================
 * The deterministic kernel that turns the LLM architect's free-form JSON
 * spec into an executable Blueprint. Every funded agent platform has this
 * layer — the LLM is creative but unreliable, so the platform validates and
 * fills in the gaps:
 *
 *   • column types must come from the executor's vocabulary (else dropped)
 *   • FKs must resolve to a table actually being created (else dropped)
 *   • reserved column names (id / created_at / updated_at) are stripped
 *   • duplicate column names within a table are deduped
 *   • a table cannot be named 'users' (auth.users is platform-managed)
 *   • every table gets exactly one RLS policy — owner_read_write by default
 *   • owner_read_write tables MUST have a user_id column — added if missing
 *   • org_members tables MUST have an organization_id column — added if missing
 *   • needsAuth flips on whenever any owner_read_write / org_members RLS exists
 *   • realtimeTables / triggers / buckets are clamped to known shapes
 *   • aggregateApi defaults to 'summary' when omitted
 *
 * The output is a Blueprint with the exact same shape the keyword blueprints
 * use — the executor doesn't care whether the steps came from a curated file
 * or an LLM round-trip, which is the whole point.
 */

import type {
  Blueprint,
  BlueprintColumn,
  BlueprintRlsPolicy,
  BlueprintStep,
} from './types'

const COLUMN_TYPES = new Set<BlueprintColumn['type']>([
  'text', 'int', 'bigint', 'boolean', 'timestamp', 'uuid', 'jsonb', 'numeric',
])

const RLS_POLICIES = new Set<BlueprintRlsPolicy>([
  'owner_read_write', 'public_read', 'org_members', 'admin_only', 'all_access',
])

const TRIGGER_OPS = new Set(['insert', 'update', 'delete'])

const RESERVED_COLUMNS = new Set(['id', 'created_at', 'createdat', 'updated_at', 'updatedat'])

const RESERVED_TABLES = new Set(['users']) // auth.users is platform-managed

// ── Spec shape (what the LLM emits) ────────────────────────────────────────

export interface ArchitectColumnSpec {
  name: string
  type: string
  nullable?: boolean
  unique?: boolean
  fkTo?: string
}

export interface ArchitectTableSpec {
  name: string
  purpose?: string
  columns: ArchitectColumnSpec[]
}

export interface ArchitectRlsSpec {
  tableName: string
  policy: string
}

export interface ArchitectTriggerSpec {
  tableName: string
  on: string
}

export interface ArchitectBucketSpec {
  name: string
  isPublic?: boolean
}

/**
 * Event-driven / scheduled / callable backend function. Maps 1:1 onto the
 * brain's generate_function tool — the piece that lets a one-shot plan cover
 * "when X happens, do Y" automations instead of silently dropping them.
 */
export interface ArchitectFunctionSpec {
  name: string
  description: string
  trigger: string // on_signup | on_insert | on_update | on_delete | http | manual
  table?: string // required for on_insert / on_update / on_delete
  method?: string // for trigger=http
}

export interface ArchitectCronSpec {
  description: string
  schedule: string // "daily at 9am" / "every 15 minutes" / 5-field cron
}

/** Literal demo rows for one table — inserted by the deterministic seed runner. */
export interface ArchitectSeedSpec {
  tableName: string
  rows: Array<Record<string, unknown>>
}

export interface ArchitectSpec {
  domain: string
  title: string
  summary?: string
  needsAuth?: boolean
  needsTeams?: boolean
  tables: ArchitectTableSpec[]
  rls?: ArchitectRlsSpec[]
  realtimeTables?: string[]
  triggers?: ArchitectTriggerSpec[]
  buckets?: ArchitectBucketSpec[]
  aggregateApi?: string
  functions?: ArchitectFunctionSpec[]
  crons?: ArchitectCronSpec[]
  seeds?: ArchitectSeedSpec[]
}

export type ValidationResult =
  | { ok: true; blueprint: Blueprint }
  | { ok: false; errors: string[] }

// ── Helpers ────────────────────────────────────────────────────────────────

function isSnakeIdent(s: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(s)
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'item'
}

// ── Main entry ─────────────────────────────────────────────────────────────

export function validateAndEnrichSpec(spec: unknown): ValidationResult {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec is not an object'] }
  }
  const s = spec as ArchitectSpec

  if (!Array.isArray(s.tables) || s.tables.length === 0) {
    return { ok: false, errors: ['no tables in spec'] }
  }

  // ── Tables: dedupe, sanitise, strip reserved, type-coerce ───────────────
  const tableMap = new Map<string, ArchitectTableSpec>()
  for (const rawT of s.tables) {
    if (!rawT || typeof rawT !== 'object') continue
    let name = String(rawT.name ?? '').trim()
    if (!name) continue
    if (!isSnakeIdent(name)) name = slugify(name)
    if (RESERVED_TABLES.has(name)) {
      // Auto-rename 'users' → 'profiles' so the spec is not blocked outright.
      name = 'profiles'
    }
    if (tableMap.has(name)) {
      // Duplicate table — keep the first one, skip the rest.
      continue
    }

    const seenCols = new Set<string>()
    const cleanCols: BlueprintColumn[] = []
    for (const c of rawT.columns ?? []) {
      if (!c || typeof c !== 'object') continue
      let cname = String(c.name ?? '').trim()
      if (!cname) continue
      if (!isSnakeIdent(cname)) cname = slugify(cname)
      if (RESERVED_COLUMNS.has(cname)) continue
      if (seenCols.has(cname)) continue
      const ctype = String(c.type ?? '').toLowerCase().trim() as BlueprintColumn['type']
      const safeType: BlueprintColumn['type'] = COLUMN_TYPES.has(ctype) ? ctype : 'text'
      const col: BlueprintColumn = { name: cname, type: safeType }
      if (c.nullable === true) col.nullable = true
      if (c.unique === true) col.unique = true
      if (typeof c.fkTo === 'string' && c.fkTo.trim()) col.fkTo = c.fkTo.trim()
      seenCols.add(cname)
      cleanCols.push(col)
    }
    if (cleanCols.length === 0) continue

    tableMap.set(name, {
      name,
      purpose: typeof rawT.purpose === 'string' ? rawT.purpose.slice(0, 160) : undefined,
      columns: cleanCols as unknown as ArchitectColumnSpec[],
    })
  }

  if (tableMap.size === 0) {
    return { ok: false, errors: ['no usable tables after sanitisation'] }
  }

  // ── FK integrity: drop FKs pointing at tables not in the spec ───────────
  for (const t of tableMap.values()) {
    for (const c of t.columns as unknown as BlueprintColumn[]) {
      if (c.fkTo && !tableMap.has(c.fkTo)) {
        delete c.fkTo
      }
    }
  }

  // ── RLS: collect raw, validate, default missing to owner_read_write ─────
  const rlsByTable = new Map<string, BlueprintRlsPolicy>()
  for (const r of s.rls ?? []) {
    if (!r || typeof r !== 'object') continue
    const tn = String(r.tableName ?? '').trim()
    const policy = String(r.policy ?? '').toLowerCase().trim() as BlueprintRlsPolicy
    if (!tableMap.has(tn)) continue
    if (!RLS_POLICIES.has(policy)) continue
    rlsByTable.set(tn, policy)
  }
  for (const tn of tableMap.keys()) {
    if (!rlsByTable.has(tn)) rlsByTable.set(tn, 'owner_read_write')
  }

  // ── Identity columns required by RLS ────────────────────────────────────
  // owner_read_write needs user_id; org_members needs organization_id. The LLM
  // sometimes forgets one — quietly add it so RLS actually works at runtime.
  let needsAuth = !!s.needsAuth
  let needsTeams = !!s.needsTeams
  for (const [tn, policy] of rlsByTable) {
    const t = tableMap.get(tn)!
    const cols = t.columns as unknown as BlueprintColumn[]
    const has = (n: string) => cols.some(c => c.name === n)
    if (policy === 'owner_read_write') {
      needsAuth = true
      if (!has('user_id')) cols.unshift({ name: 'user_id', type: 'uuid' })
    } else if (policy === 'org_members') {
      needsAuth = true
      needsTeams = true
      if (!has('organization_id')) cols.unshift({ name: 'organization_id', type: 'uuid' })
    }
  }

  // ── Realtime / triggers / buckets ───────────────────────────────────────
  const realtimeTables = (s.realtimeTables ?? [])
    .filter(t => typeof t === 'string' && tableMap.has(t))
  const triggers = (s.triggers ?? [])
    .filter(t => t && typeof t === 'object')
    .filter(t => tableMap.has(String(t.tableName)))
    .filter(t => TRIGGER_OPS.has(String(t.on)))
    .map(t => ({ tableName: String(t.tableName), on: String(t.on) as 'insert' | 'update' | 'delete' }))
  const buckets = (s.buckets ?? [])
    .filter(b => b && typeof b === 'object' && typeof b.name === 'string' && b.name.trim())
    .map(b => ({ name: slugify(b.name), isPublic: b.isPublic !== false }))
  const aggregateApi = typeof s.aggregateApi === 'string' && s.aggregateApi.trim()
    ? slugify(s.aggregateApi)
    : 'summary'

  // ── Functions (event automations / http endpoints) ──────────────────────
  // Clamp to the generate_function tool's contract: valid trigger, table
  // present (and real) for row-event triggers, description long enough to
  // pass the dispatcher's preflight. A dropped automation is a silent lie to
  // the user, so we repair what we can (synthesise a description, resolve
  // singular/plural table names) and only drop what is truly unusable.
  const FN_TRIGGERS = new Set(['on_signup', 'on_insert', 'on_update', 'on_delete', 'http', 'manual'])
  const functions: Array<{ name: string; description: string; trigger: string; table?: string; method?: string }> = []
  const seenFnNames = new Set<string>()
  for (const rawF of (s.functions ?? []).slice(0, 20)) {
    if (!rawF || typeof rawF !== 'object') continue
    const name = slugify(String(rawF.name ?? ''))
    if (!name || seenFnNames.has(name)) continue
    const trigger = String(rawF.trigger ?? 'http').toLowerCase().trim()
    if (!FN_TRIGGERS.has(trigger)) continue
    let table: string | undefined
    if (trigger === 'on_insert' || trigger === 'on_update' || trigger === 'on_delete') {
      const tn = String(rawF.table ?? '').trim()
      // Resolve loose naming: exact → plural → singular.
      table = tableMap.has(tn) ? tn
        : tableMap.has(`${tn}s`) ? `${tn}s`
        : tableMap.has(tn.replace(/s$/, '')) ? tn.replace(/s$/, '')
        : undefined
      if (!table) continue // row-event function without a real table cannot fire
    }
    let description = typeof rawF.description === 'string' ? rawF.description.trim() : ''
    if (description.length < 12) {
      description = `${name.replace(/_/g, ' ')} — fires ${trigger.replace('on_', 'on row ')}${table ? ` on ${table}` : ''}.`
    }
    const method = trigger === 'http' && typeof rawF.method === 'string'
      ? rawF.method.toUpperCase()
      : undefined
    seenFnNames.add(name)
    functions.push({ name, description: description.slice(0, 500), trigger, table, method })
  }

  // ── Cron jobs (scheduled automations) ────────────────────────────────────
  const crons: Array<{ description: string; schedule: string }> = []
  for (const rawC of (s.crons ?? []).slice(0, 10)) {
    if (!rawC || typeof rawC !== 'object') continue
    const description = typeof rawC.description === 'string' ? rawC.description.trim() : ''
    const schedule = typeof rawC.schedule === 'string' ? rawC.schedule.trim() : ''
    if (description.length < 12 || !schedule) continue
    crons.push({ description: description.slice(0, 500), schedule: schedule.slice(0, 100) })
  }

  // ── Seed data (literal demo rows) ────────────────────────────────────────
  // Values are clamped to columns that exist in the spec; the seed runner
  // resolves FK / user_id columns at insert time, so those are dropped here.
  const seeds: Array<{ tableName: string; rows: Array<Record<string, unknown>> }> = []
  const seededTables = new Set<string>()
  for (const rawS of (s.seeds ?? []).slice(0, 10)) {
    if (!rawS || typeof rawS !== 'object') continue
    const tn = String(rawS.tableName ?? '').trim()
    const t = tableMap.get(tn)
    if (!t || seededTables.has(tn)) continue
    const specCols = new Map(
      (t.columns as unknown as BlueprintColumn[]).map(c => [c.name, c]),
    )
    const rows: Array<Record<string, unknown>> = []
    for (const rawRow of (Array.isArray(rawS.rows) ? rawS.rows : []).slice(0, 15)) {
      if (!rawRow || typeof rawRow !== 'object') continue
      const row: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawRow)) {
        const col = specCols.get(k)
        if (!col) continue
        if (col.fkTo || col.name === 'user_id') continue // runner resolves these
        if (v === null || v === undefined) continue
        row[k] = v
      }
      if (Object.keys(row).length > 0) rows.push(row)
    }
    if (rows.length === 0) continue
    seededTables.add(tn)
    seeds.push({ tableName: tn, rows })
  }

  // ── Build the executable step list (ORDER MATTERS) ──────────────────────
  const steps: BlueprintStep[] = []
  if (needsAuth) steps.push({ label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} })
  if (needsTeams) steps.push({ label: 'Wire team multi-tenancy (orgs + members + invitations)', tool: 'enable_teams', args: {} })

  // Tables — emit FK-free columns first to avoid forward-reference issues at
  // create time, then add FKs in a second pass via ADD_COLUMN if needed. The
  // executor accepts FKs at create time when the target table already exists,
  // so we order tables by FK dependency depth.
  const ordered = orderTablesByDependency(tableMap)
  for (const t of ordered) {
    steps.push({
      label: `Create ${t.name}${t.purpose ? `: ${t.purpose}` : ''}`,
      tool: 'create_table',
      args: { tableName: t.name, columns: t.columns },
    })
  }

  for (const t of ordered) {
    steps.push({
      label: `Generate REST API for ${t.name}`,
      tool: 'generate_api',
      args: { tableName: t.name },
    })
  }

  for (const [tn, policy] of rlsByTable) {
    const label = policy === 'public_read'
      ? `Lock down ${tn} (public read, owner-only write)`
      : `Apply ${policy} RLS to ${tn}`
    steps.push({ label, tool: 'add_rls', args: { tableName: tn, policy } })
  }

  for (const tn of realtimeTables) {
    steps.push({ label: `Stream realtime changes on ${tn}`, tool: 'enable_realtime', args: { tableName: tn } })
  }

  for (const trg of triggers) {
    steps.push({
      label: `Add ${trg.on} trigger on ${trg.tableName} (in-app notifications)`,
      tool: 'create_trigger',
      args: { tableName: trg.tableName, on: trg.on, kind: 'notify' },
    })
  }

  // Functions after tables/APIs/RLS — event functions reference live tables.
  for (const f of functions) {
    const what =
      f.trigger === 'http' ? `HTTP endpoint /fn/${f.name}`
      : f.trigger === 'manual' ? `manual function ${f.name}`
      : f.trigger === 'on_signup' ? `signup hook ${f.name}`
      : `${f.trigger.replace('on_', 'on ')} automation ${f.name} (${f.table})`
    steps.push({
      label: `Create ${what}`,
      tool: 'generate_function',
      args: {
        name: f.name,
        description: f.description,
        trigger: f.trigger,
        ...(f.table ? { table: f.table } : {}),
        ...(f.method ? { method: f.method } : {}),
      },
    })
  }

  for (const c of crons) {
    steps.push({
      label: `Schedule recurring job (${c.schedule}): ${c.description.slice(0, 80)}`,
      tool: 'create_cron_job',
      args: { description: c.description, schedule: c.schedule },
    })
  }

  for (const b of buckets) {
    steps.push({
      label: `Create ${b.name} bucket (${b.isPublic ? 'public-read' : 'private'})`,
      tool: 'create_bucket',
      args: { bucketName: b.name, isPublic: b.isPublic },
    })
  }

  steps.push({
    label: `Generate aggregate /stats/${aggregateApi} endpoint`,
    tool: 'generate_aggregate_api',
    args: { name: aggregateApi },
  })

  // Seeds run LAST — after automations exist, so on_insert functions and
  // notify triggers fire for demo rows exactly as they would in production.
  // `seed_rows` is a blueprint-executor step (not an LLM tool): the
  // deterministic seed runner resolves FK / user_id values at insert time.
  for (const sd of seeds) {
    steps.push({
      label: `Seed ${sd.rows.length} demo row${sd.rows.length === 1 ? '' : 's'} into ${sd.tableName}`,
      tool: 'seed_rows',
      args: { tableName: sd.tableName, rows: sd.rows },
    })
  }

  const blueprint: Blueprint = {
    domain: typeof s.domain === 'string' && s.domain.trim() ? slugify(s.domain) : 'custom',
    title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : 'Custom Backend',
    summary: typeof s.summary === 'string' && s.summary.trim()
      ? s.summary.trim()
      : `${ordered.length} tables, ${realtimeTables.length} realtime surface(s), ${buckets.length} bucket(s).`,
    steps,
    warnings: [
      'RLS is on. Unauthenticated tests against owner-only tables return permission-denied (Postgres 42501). That is correct security, not a failure.',
      ...(buckets.some(b => !b.isPublic)
        ? ['One or more buckets are private. Use generate_signed_url to share files.']
        : []),
    ],
  }

  return { ok: true, blueprint }
}

/**
 * Topo-order tables so that a table being created references no FK target
 * that hasn't been created yet. Cycles (rare) are broken by emitting the
 * cycle's first node with FKs intact — Postgres will defer them at create.
 */
function orderTablesByDependency(map: Map<string, ArchitectTableSpec>): ArchitectTableSpec[] {
  const remaining = new Map(map)
  const out: ArchitectTableSpec[] = []
  // Loop until stable.
  let safetyTicks = remaining.size * 2 + 5
  while (remaining.size > 0 && safetyTicks-- > 0) {
    let progress = false
    for (const [name, t] of [...remaining]) {
      const cols = t.columns as unknown as BlueprintColumn[]
      const fkTargets = cols.map(c => c.fkTo).filter((x): x is string => !!x)
      // Self-FK is fine (e.g. parent_id on a comments table); ignore it.
      const unresolved = fkTargets.filter(fk => fk !== name && remaining.has(fk))
      if (unresolved.length === 0) {
        out.push(t)
        remaining.delete(name)
        progress = true
      }
    }
    if (!progress) break // cycle — emit the rest as-is
  }
  for (const t of remaining.values()) out.push(t)
  return out
}
