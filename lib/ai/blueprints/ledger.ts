/**
 * REQUIREMENTS LEDGER — coverage accounting for blueprint builds
 * ==============================================================
 * The piece that separates a funded-platform agent from a demo: the agent is
 * accountable to the REQUEST, not just to its own plan.
 *
 *   extractRequirements(prompt)  — deterministic parse of what the user asked
 *                                  for (tables + columns, automations,
 *                                  realtime, seeds, analytics, auth, storage)
 *   reconcileLedger(ledger, s)   — diff requested vs applied → per-line
 *                                  built / partial / missing verdicts
 *   renderLedgerReport(report)   — honest markdown checklist for the user
 *
 * Everything here is pure and deterministic — no LLM self-grading. An LLM
 * asked "did you do everything?" says yes; string-matching the applied schema
 * against the requested schema cannot lie.
 *
 * Used twice per build:
 *   • at PROPOSE time against the plan steps → "Not in this plan" honesty
 *     section, so the user sees gaps BEFORE approving
 *   • at EXECUTE time against the live proof + succeeded steps → the final
 *     coverage checklist
 */

import type { BlueprintStep } from './types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface RequestedTable {
  name: string
  columns: string[]
}

export interface RequirementsLedger {
  version: 1
  /** Tables the user explicitly enumerated (with their column lists). */
  tables: RequestedTable[]
  /** "when X happens do Y" sentences the user asked for. */
  automations: string[]
  /** Tables the user asked realtime updates for. */
  realtime: string[]
  seedsRequested: boolean
  analyticsRequested: boolean
  authRequested: boolean
  storageRequested: boolean
}

export type LedgerStatus = 'built' | 'partial' | 'missing'

export interface LedgerLine {
  requirement: string
  status: LedgerStatus
  note?: string
}

export interface LedgerReport {
  lines: LedgerLine[]
  built: number
  partial: number
  missing: number
}

/** What actually exists (or what the plan will create) — reconciliation input. */
export interface AppliedState {
  tables: string[]
  /** tableName → columns actually created (implicit id/created_at/updated_at excluded). */
  tableColumns: Map<string, string[]>
  authEnabled: boolean
  realtimeTables: string[]
  buckets: string[]
  /** Free text of applied function + cron steps (labels + descriptions). */
  automationTexts: string[]
  /** tableName → rows inserted by the seed runner (or planned). */
  seededTables: Map<string, number>
  aggregateApplied: boolean
}

// ── Extraction ──────────────────────────────────────────────────────────────

const TABLE_HEADING_RE = /^\s*\d+[.)]\s*([a-z_][a-z0-9_]*)\s*$/
const COLUMN_BULLET_RE = /^\s*[-*•]\s*([a-z_][a-z0-9_]*)\s*(?::.*)?$/
const IMPLICIT_COLUMNS = new Set(['id', 'created_at', 'updated_at'])

export function extractRequirements(prompt: string): RequirementsLedger {
  const text = (prompt ?? '').slice(0, 16000)
  const lines = text.split(/\r?\n/)

  // ── Tables + columns: numbered headings followed by contiguous bullets ──
  const tables: RequestedTable[] = []
  let current: RequestedTable | null = null
  for (const line of lines) {
    const heading = line.match(TABLE_HEADING_RE)
    if (heading) {
      current = { name: heading[1], columns: [] }
      tables.push(current)
      continue
    }
    if (current) {
      const col = line.match(COLUMN_BULLET_RE)
      if (col) {
        if (!IMPLICIT_COLUMNS.has(col[1])) current.columns.push(col[1])
      } else if (line.trim() !== '') {
        // Non-bullet, non-blank line ends the column list — the next bullets
        // belong to prose sections ("Create API endpoints for: - ..."), not
        // to this table.
        current = null
      }
    }
  }

  // ── Automations: "when X …, do Y" sentences ─────────────────────────────
  const automations: string[] = []
  for (const line of lines) {
    const t = line.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()
    if (/^when\b/i.test(t) && t.length > 20) automations.push(t.slice(0, 200))
  }

  // ── Realtime: lines mentioning realtime + a known table name ────────────
  const tableNames = new Set(tables.map(t => t.name))
  const realtime: string[] = []
  for (const line of lines) {
    if (!/realtime|real-time|live updates/i.test(line)) continue
    for (const tn of tableNames) {
      if (new RegExp(`\\b${tn}\\b`, 'i').test(line) && !realtime.includes(tn)) realtime.push(tn)
    }
  }

  return {
    version: 1,
    tables,
    automations: automations.slice(0, 20),
    realtime,
    seedsRequested: /\bseed\b|\bdemo data\b|\bsample data\b/i.test(text),
    analyticsRequested: /\banalytics\b|\bdashboard\b|\bstats\b|\bmetrics\b|\bkpis?\b/i.test(text),
    authRequested: /\bauth(entication)?\b|\blog ?in\b|\bsign ?up\b|\bsign ?in\b/i.test(text),
    storageRequested: /\bstorage\b|\bupload\b|\bfiles?\b|\bdocuments?\b/i.test(text),
  }
}

/** True when the ledger carries anything worth reconciling. */
export function ledgerHasContent(ledger: RequirementsLedger | null | undefined): boolean {
  if (!ledger) return false
  return (
    ledger.tables.length > 0 ||
    ledger.automations.length > 0 ||
    ledger.realtime.length > 0 ||
    ledger.seedsRequested
  )
}

// ── AppliedState builders ───────────────────────────────────────────────────

/**
 * Derive AppliedState from plan steps alone (propose-time: assume every step
 * lands). `onlySteps` lets execute-time callers pass just the steps that
 * actually succeeded.
 */
export function appliedStateFromSteps(steps: BlueprintStep[]): AppliedState {
  const state: AppliedState = {
    tables: [],
    tableColumns: new Map(),
    authEnabled: false,
    realtimeTables: [],
    buckets: [],
    automationTexts: [],
    seededTables: new Map(),
    aggregateApplied: false,
  }
  for (const s of steps) {
    const a = s.args as Record<string, unknown>
    const tn = typeof a.tableName === 'string' ? a.tableName : undefined
    switch (s.tool) {
      case 'create_table':
        if (tn) {
          state.tables.push(tn)
          const cols = Array.isArray(a.columns)
            ? (a.columns as Array<{ name?: unknown }>).map(c => String(c?.name ?? '')).filter(Boolean)
            : []
          state.tableColumns.set(tn, cols)
        }
        break
      case 'enable_auth':
        state.authEnabled = true
        break
      case 'enable_realtime':
        if (tn) state.realtimeTables.push(tn)
        break
      case 'create_bucket':
        state.buckets.push(String(a.bucketName ?? ''))
        break
      case 'generate_function':
        state.automationTexts.push(`${a.name ?? ''} ${a.trigger ?? ''} ${a.table ?? ''} ${a.description ?? ''}`)
        break
      case 'create_cron_job':
        state.automationTexts.push(`${a.schedule ?? ''} ${a.description ?? ''}`)
        break
      case 'seed_rows':
        if (tn) {
          state.seededTables.set(tn, Array.isArray(a.rows) ? (a.rows as unknown[]).length : 0)
        }
        break
      case 'generate_aggregate_api':
        state.aggregateApplied = true
        break
    }
  }
  return state
}

// ── Reconciliation ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'when', 'then', 'that', 'this', 'with', 'into', 'from', 'happens', 'happen',
  'should', 'must', 'will', 'the', 'and', 'any', 'all', 'row', 'rows', 'table',
  'tables', 'backend', 'important', 'create', 'insert', 'automatically', 'event',
  'operation', 'user', 'users', 'every', 'each', 'their', 'them', 'they',
])

function significantTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z_]{4,}/g) ?? []).filter(t => !STOPWORDS.has(t))
}

/**
 * Deterministic automation matcher: a requested automation counts as covered
 * when some applied function/cron shares ≥2 significant tokens with it (table
 * names, status values, verbs like "overdue" / "followup"). Transparent and
 * conservative — a near-miss shows as missing, never silently as done.
 */
function automationCovered(requirement: string, automationTexts: string[]): boolean {
  const reqTokens = new Set(significantTokens(requirement))
  if (reqTokens.size === 0) return false
  for (const text of automationTexts) {
    let shared = 0
    for (const tok of significantTokens(text)) {
      if (reqTokens.has(tok)) shared++
      if (shared >= 2) return true
    }
  }
  return false
}

export function reconcileLedger(ledger: RequirementsLedger, applied: AppliedState): LedgerReport {
  const lines: LedgerLine[] = []
  const appliedTables = new Set(applied.tables)

  // ── Tables + columns ─────────────────────────────────────────────────────
  for (const req of ledger.tables) {
    // 'users' is platform-managed: end-user auth owns it; extra identity
    // fields live on profiles. Requested users ⇒ satisfied by auth/profiles.
    if (req.name === 'users') {
      if (applied.authEnabled || appliedTables.has('profiles')) {
        lines.push({
          requirement: 'table users',
          status: 'built',
          note: 'managed by end-user auth; extra fields on profiles',
        })
      } else {
        lines.push({ requirement: 'table users', status: 'missing' })
      }
      continue
    }

    if (!appliedTables.has(req.name)) {
      lines.push({ requirement: `table ${req.name}`, status: 'missing' })
      continue
    }
    const appliedCols = new Set(applied.tableColumns.get(req.name) ?? [])
    const missingCols = req.columns.filter(c => !appliedCols.has(c))
    if (missingCols.length === 0 || appliedCols.size === 0) {
      // appliedCols empty ⇒ we know the table exists but not its columns
      // (proof-based reconcile) — report the table, stay silent on columns.
      lines.push({
        requirement: `table ${req.name}`,
        status: 'built',
        note: req.columns.length ? `${req.columns.length} requested columns` : undefined,
      })
    } else {
      lines.push({
        requirement: `table ${req.name}`,
        status: 'partial',
        note: `missing column${missingCols.length === 1 ? '' : 's'}: ${missingCols.join(', ')}`,
      })
    }
  }

  // ── Automations ──────────────────────────────────────────────────────────
  for (const auto of ledger.automations) {
    lines.push({
      requirement: `automation: "${auto.slice(0, 90)}${auto.length > 90 ? '…' : ''}"`,
      status: automationCovered(auto, applied.automationTexts) ? 'built' : 'missing',
    })
  }

  // ── Realtime ─────────────────────────────────────────────────────────────
  const appliedRealtime = new Set(applied.realtimeTables)
  for (const tn of ledger.realtime) {
    lines.push({
      requirement: `realtime on ${tn}`,
      status: appliedRealtime.has(tn) ? 'built' : 'missing',
    })
  }

  // ── Seeds ────────────────────────────────────────────────────────────────
  if (ledger.seedsRequested) {
    const total = [...applied.seededTables.values()].reduce((a, b) => a + b, 0)
    lines.push({
      requirement: 'demo / seed data',
      status: applied.seededTables.size > 0 ? 'built' : 'missing',
      note: applied.seededTables.size > 0
        ? `${total} rows across ${applied.seededTables.size} tables`
        : undefined,
    })
  }

  // ── Cross-cutting asks ───────────────────────────────────────────────────
  if (ledger.authRequested) {
    lines.push({ requirement: 'end-user authentication', status: applied.authEnabled ? 'built' : 'missing' })
  }
  if (ledger.storageRequested) {
    lines.push({
      requirement: 'file storage',
      status: applied.buckets.length > 0 ? 'built' : 'missing',
      note: applied.buckets.length ? `bucket: ${applied.buckets.join(', ')}` : undefined,
    })
  }
  if (ledger.analyticsRequested) {
    lines.push({
      requirement: 'dashboard analytics',
      status: applied.aggregateApplied ? 'built' : 'missing',
      note: applied.aggregateApplied ? 'aggregate /stats endpoint' : undefined,
    })
  }

  return {
    lines,
    built: lines.filter(l => l.status === 'built').length,
    partial: lines.filter(l => l.status === 'partial').length,
    missing: lines.filter(l => l.status === 'missing').length,
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const STATUS_ICON: Record<LedgerStatus, string> = {
  built: '✅',
  partial: '⚠️',
  missing: '❌',
}

/**
 * Render the checklist. `mode` tweaks framing: 'plan' = pre-approval ("not in
 * this plan"), 'result' = post-build ("not built").
 */
export function renderLedgerReport(report: LedgerReport, mode: 'plan' | 'result'): string {
  if (report.lines.length === 0) return ''

  const header =
    mode === 'plan'
      ? `**Request coverage (this plan)** · ${report.built} covered · ${report.partial} partial · ${report.missing} not covered`
      : `**Request coverage** · ${report.built} built · ${report.partial} partial · ${report.missing} not built`

  // Perfect coverage → one line, no 40-row checklist to scroll past.
  if (report.partial === 0 && report.missing === 0) {
    return `${header}\n${STATUS_ICON.built} Every requested item is ${mode === 'plan' ? 'in the plan' : 'built'} (${report.built} requirements).`
  }

  const shown = [
    // Problems first — that's what the user needs to see.
    ...report.lines.filter(l => l.status !== 'built'),
    ...report.lines.filter(l => l.status === 'built'),
  ].slice(0, 30)

  const body = shown.map(l =>
    `${STATUS_ICON[l.status]} ${l.requirement}${l.note ? ` — ${l.note}` : ''}`,
  )
  const hidden = report.lines.length - shown.length
  if (hidden > 0) body.push(`… and ${hidden} more built items`)

  return [header, ...body].join('\n')
}
