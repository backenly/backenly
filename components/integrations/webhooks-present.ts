/**
 * How the Webhooks page says what it shows: an endpoint's name, a delivery's
 * state, an agent trigger's event. Pure functions, so the words are tested
 * apart from the page (tests/unit/webhooks-present.spec.ts).
 *
 * A delivery is a log entry (project decision 6): one row, the result glyph
 * first, the receiver's status code as its result, and words only for the
 * states that ask for attention (Retrying, Failed, Gave up). "Delivered" is the
 * glyph alone, so it is never printed twenty-five times down a page.
 */

import { isRowEventType } from '@/lib/webhooks/events'
import type { GlyphState } from '@/components/inspector/kit'

/** An endpoint as GET /api/projects/[id]/webhooks lists it. */
export interface WebhookRow {
  id: string
  eventType: string
  targetUrl: string
  active: boolean
  /** Row events only: the tables it receives; empty means every table. */
  tables?: string[]
  createdAt: string
  updatedAt: string
  logCount: number
}

/** Whether row events are being captured, read from the database catalog. */
export interface CaptureState {
  tables: string[]
  required: boolean
  healthy: boolean
  readable: boolean
}

export interface WebhookPlanState {
  allowed: boolean
  currentPlan?: string
}

/** One delivery, as GET .../webhooks/[webhookId]/logs returns it. */
export interface DeliveryLog {
  id: string
  eventType: string
  status: string
  statusCode: number | null
  attemptCount: number
  error: string | null
  responseBody: string | null
  deliveredAt: string | null
  createdAt: string
  nextRetryAt: string | null
}

/** A webhook the agent wired over MCP (`webhooks { action: "create_trigger" }`). */
export interface TriggerWebhookRow {
  id: string
  name: string
  sourceTable: string
  event: string
  webhookUrl: string | null
  enabled: boolean
  createdAt: string
}

export interface TriggerDeliveryRow {
  id: string
  triggerId: string
  eventType: string
  table: string | null
  status: string
  attemptCount: number
  statusCode: number | null
  error: string | null
  deliveredAt: string | null
  createdAt: string
  trigger: { name: string; webhookUrl: string | null }
}

// ─── Names ───────────────────────────────────────────────────────────────────

/**
 * An endpoint's URL without its scheme, split where a line may break: the host
 * stays whole, the path breaks at its slashes. A URL that does not parse is
 * returned as it is, as the host.
 */
export function hostAndPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url)
    const path = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return { host: u.host, path }
  } catch {
    return { host: url.replace(/^[a-z]+:\/\//i, ''), path: '' }
  }
}

/**
 * A short name for an endpoint, for a page title and a breadcrumb: host and
 * path, with a long path cut after the last whole segment that fits and "…"
 * in place of the rest. The full URL is always beside it, with Copy.
 */
export function shortEndpoint(url: string, max = 44): string {
  const { host, path } = hostAndPath(url)
  const full = `${host}${path}`
  if (full.length <= max) return full
  const segments = path.split('/').filter(Boolean)
  let out = host
  for (const s of segments) {
    if (`${out}/${s}`.length > max - 2) break
    out = `${out}/${s}`
  }
  return `${out}/…`
}

/** The tables a row event goes to, in words; nothing for a sign-up event. */
export function tablesWords(eventType: string, tables: readonly string[] | undefined): string | null {
  if (!isRowEventType(eventType)) return null
  return tables && tables.length > 0 ? tables.join(', ') : 'Every table'
}

const TRIGGER_EVENT: Record<string, (table: string) => string> = {
  insert: (t) => `On insert into ${t}`,
  update: (t) => `On update of ${t}`,
  delete: (t) => `On delete from ${t}`,
}

/** An agent trigger's event in words, as Functions says it: "On insert into follows". */
export function triggerEventWords(event: string, table: string): string {
  const say = TRIGGER_EVENT[event.toLowerCase()]
  return say ? say(table) : `On ${event} of ${table}`
}

// ─── Deliveries ──────────────────────────────────────────────────────────────

export interface DeliveryLook {
  glyph: GlyphState
  /** The state in words, for screen readers and, where it asks for attention, on screen. */
  label: string
  /** Written on the row: only for a state that asks for attention. */
  word?: string
}

/** How an endpoint delivery's state reads (WebhookLog.status, lib/webhooks/index.ts). */
export function deliveryLook(status: string): DeliveryLook {
  switch (status) {
    case 'SUCCESS':
      return { glyph: 'done', label: 'Delivered' }
    case 'RETRYING':
      return { glyph: 'busy', label: 'Retrying', word: 'Retrying' }
    case 'PENDING':
      return { glyph: 'busy', label: 'Sending', word: 'Sending' }
    case 'DEAD_LETTER':
      return { glyph: 'failed', label: 'Gave up', word: 'Gave up' }
    case 'FAILED':
      return { glyph: 'failed', label: 'Failed', word: 'Failed' }
    case 'CANCELLED':
      // Withdrawn because the project was paused: not the receiver's failure.
      return { glyph: 'idle', label: 'Not sent', word: 'Not sent' }
    default:
      return { glyph: 'idle', label: status, word: status }
  }
}

/** How an agent trigger delivery's state reads (TriggerDeliveryLog.status, lib/services/trigger-service.ts). */
export function triggerDeliveryLook(status: string): DeliveryLook {
  if (status === 'SUCCESS') return { glyph: 'done', label: 'Delivered' }
  if (status === 'DEAD') return { glyph: 'failed', label: 'Gave up', word: 'Gave up' }
  if (status === 'FAILED') return { glyph: 'failed', label: 'Failed', word: 'Failed' }
  return { glyph: 'idle', label: status, word: status }
}

/** A delivery that did not get through, or has not yet: what the Failed filter keeps. */
export function isFailedDelivery(log: Pick<DeliveryLog, 'status'>): boolean {
  return log.status === 'RETRYING' || log.status === 'FAILED' || log.status === 'DEAD_LETTER'
}

/**
 * A delivery Send again may send (replayRefusal in lib/webhooks/index.ts): one
 * that failed or gave up, of an endpoint that is on. Retrying ones are still
 * being sent, and a delivered one would arrive twice.
 */
export function canSendAgain(log: Pick<DeliveryLog, 'status'>, endpointActive: boolean): boolean {
  return endpointActive && (log.status === 'FAILED' || log.status === 'DEAD_LETTER')
}

/**
 * The error, when it says more than the status code beside it: the deliverer
 * writes "HTTP 500" for a 500, which the row already shows as its result.
 */
export function errorWorthShowing(log: Pick<DeliveryLog, 'error' | 'statusCode'>): string | null {
  const e = log.error?.trim()
  if (!e) return null
  if (log.statusCode !== null && log.statusCode !== undefined && e === `HTTP ${log.statusCode}`) return null
  if (e === 'project_paused') return 'The project was paused.'
  return e
}

/** A response body to read: JSON indented, anything else as it came. */
export function readableBody(body: string | null | undefined): string {
  if (!body) return ''
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2)
    } catch {
      return body
    }
  }
  return body
}

/** What an endpoint's recent deliveries say, for its row in the list. */
export interface RecentDeliveries {
  /** When the newest delivery was made. */
  lastAt: string | null
  /** Deliveries still being retried. */
  retrying: number
  /** The newest delivery failed or gave up. */
  lastFailed: boolean
}

export function recentDeliveries(logs: readonly Pick<DeliveryLog, 'status' | 'createdAt'>[]): RecentDeliveries {
  const newest = logs[0]
  return {
    lastAt: newest?.createdAt ?? null,
    retrying: logs.filter((l) => l.status === 'RETRYING').length,
    lastFailed: !!newest && (newest.status === 'FAILED' || newest.status === 'DEAD_LETTER'),
  }
}

/** The receiver's answer to a test or a resend, in a line. */
export function answerLine(
  r: { success: boolean; statusCode: number | null; error: string | null; blocked?: boolean },
  verb: 'test' | 'again',
): { ok: boolean; text: string } {
  const lead = verb === 'again' ? 'Sent again' : 'Delivered'
  if (r.success) return { ok: true, text: `${lead}. It answered ${r.statusCode ?? 200}.` }
  if (r.blocked) return { ok: false, text: `Not sent. ${r.error ?? 'The destination was refused.'}` }
  const answered = r.statusCode ? ` It answered ${r.statusCode}.` : ''
  const why = !r.statusCode || (r.error && r.error !== `HTTP ${r.statusCode}`) ? ` ${r.error ?? ''}` : ''
  return { ok: false, text: `Not delivered.${answered}${why}`.trim() }
}

// ─── Verifying ───────────────────────────────────────────────────────────────

/**
 * How a receiver checks a delivery: exactly what lib/webhooks/index.ts signs,
 * 'sha256=' + the hex HMAC-SHA256 of the raw body under the endpoint's secret.
 */
export const VERIFY_SNIPPET = `import crypto from 'node:crypto'

// rawBody: the exact bytes received, before any JSON parsing.
export function isFromBackenly(rawBody, signatureHeader, secret) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader ?? '')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}`
