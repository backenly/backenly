/**
 * What the Functions page knows about a function and its runs, in words.
 *
 * Plain functions, no React, so the page, its panes and the tests read the
 * same answers: a trigger said the way a person says it ("On insert into
 * reviews", "Daily at 02:00 UTC"), a function's state as a glyph, the first
 * line of a run, and what a function's stored code reads (ctx.env) and calls
 * (ctx.integrations).
 */

import { cronInWords } from '@/lib/services/cron-expression'
import type { GlyphState } from '@/components/inspector/kit'

export interface AiFunction {
  id: string
  name: string
  description: string
  triggerType: string
  triggerTable: string | null
  status: 'active' | 'inactive' | 'error'
  lastRun: string | null
  lastError: string | null
  runCount: number
  createdAt: string
  /** The deployed source, exactly as stored: what actually runs. */
  generatedCode?: string | null
  /** 'generated' (Backenly's model) | 'agent' (deploy_code, stored verbatim). */
  codeOrigin?: string
  /**
   * Backenly generated it for one of the project's tables, as part of the
   * table's API (lib/services/domain-endpoints.ts). The server decides; the
   * page counts and groups by it, never by a name's shape.
   */
  generated?: boolean
}

export interface AiFunctionLog {
  id: string
  functionId: string
  success: boolean
  logs: string[]
  error: string | null
  durationMs: number
  triggerType: string
  createdAt: string
  function?: { name: string; triggerType: string }
}

/** GET /ai-functions `capture` (lib/webhooks/function-capture.ts). */
export interface FunctionsCapture {
  required: boolean
  healthy: boolean
  tables: string[]
  uncaptured: Array<{ id: string; name: string; table: string | null }>
}

export interface TestRunResult {
  success: boolean
  logs: string[]
  error?: string
  errorCode?: string
  requiredPlan?: string
  durationMs: number
  /** Route-endpoint functions return the handler's HTTP response here. */
  returnValue?: { status?: number; body?: unknown } | unknown
}

// ─── Triggers ────────────────────────────────────────────────────────────────
// HTTP-endpoint functions are stored with triggerType 'manual' and the route in
// triggerTable ("GET /api/v1/{id}/fn/{name}"); cron jobs store the cron
// expression there. Both are normalised so the page says what actually fires.

const HTTP_ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+\S/i

export type TriggerKind = 'http' | 'on_signup' | 'on_db_insert' | 'on_db_update' | 'on_db_delete' | 'cron' | 'manual' | 'on_webhook' | string

export function triggerKind(fn: Pick<AiFunction, 'triggerType' | 'triggerTable'>): TriggerKind {
  if (fn.triggerType === 'manual' && fn.triggerTable && HTTP_ENDPOINT_RE.test(fn.triggerTable)) return 'http'
  return fn.triggerType
}

/** "GET endpoint", "On insert into reviews", "On sign-up", "Daily at 02:00 UTC", "Run by hand". */
export function triggerWords(fn: Pick<AiFunction, 'triggerType' | 'triggerTable'>): string {
  const table = fn.triggerTable || 'a table'
  switch (triggerKind(fn)) {
    case 'http':
      return `${endpointOf(fn)?.method ?? 'HTTP'} endpoint`
    case 'on_signup':
      return 'On sign-up'
    case 'on_db_insert':
      return `On insert into ${table}`
    case 'on_db_update':
      return `On update of ${table}`
    case 'on_db_delete':
      return `On delete from ${table}`
    case 'cron':
      return cronInWords(fn.triggerTable) ?? 'On a schedule'
    case 'on_webhook':
      return 'On an incoming webhook'
    case 'manual':
      return 'POST / GET endpoint'
    default:
      return fn.triggerType
  }
}

/** The run's event, as the Test run dialog names its JSON field (route-module-runner.ts: body and query). */
export function payloadLabel(fn: Pick<AiFunction, 'triggerType' | 'triggerTable'>): string {
  switch (triggerKind(fn)) {
    case 'http':
      return 'Request body and query (JSON)'
    case 'on_db_insert':
      return 'Inserted row (JSON)'
    case 'on_db_update':
      return 'Updated row (JSON)'
    case 'on_db_delete':
      return 'Deleted row (JSON)'
    case 'on_signup':
      return 'New user (JSON)'
    default:
      return 'Event data (JSON)'
  }
}

export function endpointOf(fn: Pick<AiFunction, 'triggerType' | 'triggerTable'> & { name?: string }): { method: string; path: string } | null {
  if (fn.triggerType === 'manual' && fn.triggerTable && HTTP_ENDPOINT_RE.test(fn.triggerTable)) {
    const [method, path] = fn.triggerTable.trim().split(/\s+/)
    return path ? { method: method.toUpperCase(), path } : null
  }
  if (fn.triggerType === 'manual') {
    return { method: 'POST / GET', path: `/api/v1/:id/fn/${fn.name ?? 'function'}` }
  }
  return null
}

/** Admin-gated business endpoints authenticate with the project's x-admin-key. */
export function isAdminGated(fn: Pick<AiFunction, 'name'>): boolean {
  return /^admin[-_]/i.test(fn.name)
}

// Generated schema-query helpers: no business logic, never run yet. They are
// real endpoints, just noise in the list, and the one kind "Remove" offers.
//
// The server's `generated` flag is the gate that keeps the cleanup honest. A
// name pattern alone matched any function named like `*-schema` with no run
// yet, and the bulk cleanup deleted it as an "auto-generated endpoint": code an
// agent deployed, or an endpoint an agent asked Backenly to write. Only what
// Backenly generated for a table qualifies, and a helper something already
// calls is never offered.
const SCHEMA_FN_RE = /(-schema|-full|_schema|_full)$|(^workspaces?-|^workspace_)/i
export function isSchemaQueryFunction(fn: AiFunction): boolean {
  return fn.generated === true && SCHEMA_FN_RE.test(fn.name) && fn.runCount === 0
}

/**
 * Endpoint-style functions only get the bulk "test untested" run. An
 * event-triggered handler (insert/update/sign-up/cron) run with an EMPTY event
 * executes its real body (database writes, emails, quota) against a payload
 * shape it will never see in production; those are tested one at a time, with
 * a payload, from their own page.
 */
export function isBulkRunnable(fn: AiFunction): boolean {
  const kind = triggerKind(fn)
  return kind === 'manual' || kind === 'http'
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface FnState {
  glyph: GlyphState
  /** Said to screen readers always; shown only for Off and Failed. */
  label: string
  show: boolean
}

/** ● ran fine · ○ never run · ‖ Off · ✕ Failed (the server's `status: 'error'`: the last run failed). */
export function fnState(fn: Pick<AiFunction, 'status' | 'lastRun' | 'runCount'>): FnState {
  if (fn.status === 'inactive') return { glyph: 'paused', label: 'Off', show: true }
  if (fn.status === 'error') return { glyph: 'failed', label: 'Failed', show: true }
  if (!fn.lastRun && fn.runCount === 0) return { glyph: 'idle', label: 'Never run', show: false }
  return { glyph: 'live', label: 'Ran fine', show: false }
}

/** Failed first, then the most recently run, then the never run. */
export function byAttention(a: AiFunction, b: AiFunction): number {
  const rank = (f: AiFunction) => (f.status === 'error' ? 0 : f.lastRun ? 1 : 2)
  const r = rank(a) - rank(b)
  if (r !== 0) return r
  if (a.lastRun && b.lastRun) return a.lastRun < b.lastRun ? 1 : a.lastRun > b.lastRun ? -1 : 0
  return a.name.localeCompare(b.name)
}

// ─── Runs ────────────────────────────────────────────────────────────────────

/** A run's one line: the error when it failed, else its first log line. */
export function runLine(run: Pick<AiFunctionLog, 'success' | 'logs' | 'error'>): string {
  if (!run.success && run.error) return run.error
  return run.logs.find((l) => l.trim()) ?? (run.error ?? '')
}

/** Everything a run printed, for its expanded well. */
export function runOutput(run: Pick<AiFunctionLog, 'logs' | 'error'>): string {
  return [...run.logs, ...(run.error ? [run.error] : [])].join('\n')
}

// ─── Code ────────────────────────────────────────────────────────────────────

const ENV_DOT = /ctx\s*\.\s*env\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g
const ENV_BRACKET = /ctx\s*\.\s*env\s*\??\.?\s*\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g
const ENV_DESTRUCTURE = /\{([^{}]+)\}\s*=\s*ctx\s*\.\s*env\b/g

/** The secrets the code reads as ctx.env.NAME, first seen first. A computed name is missed. */
export function envReads(code: string | null | undefined): string[] {
  if (!code) return []
  const found: Array<{ at: number; name: string }> = []
  for (const m of code.matchAll(ENV_DOT)) found.push({ at: m.index ?? 0, name: m[1] })
  for (const m of code.matchAll(ENV_BRACKET)) found.push({ at: m.index ?? 0, name: m[2] })
  for (const m of code.matchAll(ENV_DESTRUCTURE)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) found.push({ at: m.index ?? 0, name })
    }
  }
  const out: string[] = []
  for (const { name } of found.sort((a, b) => a.at - b.at)) if (!out.includes(name)) out.push(name)
  return out
}

/** "a162ca5c…f37495c": a hash short enough to compare by eye. */
export function shortHash(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-7)}` : hex
}
