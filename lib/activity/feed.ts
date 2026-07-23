/**
 * Shared activity-feed builder.
 *
 * One source of truth for "what changed in this project", consumed by:
 *   • the dashboard "Recent Activity" card  → last 8, last 30 days
 *   • the full History page                 → all-time, paginated
 *
 * It merges two tables by timestamp:
 *   • audit_logs        — human-driven changes (the owner / the AI chat)
 *   • correction_events — the runtime fixing things autonomously
 *
 * Every row is labelled in plain English. The product must never surface a
 * raw SCREAMING_SNAKE_CASE action like "HEALTH_FIX_EXECUTED" to a non-dev
 * (see commit 542b73f). Keeping the labeller here — one copy, not duplicated
 * per route — is what stops that regression from coming back.
 */

import { prisma } from '@/lib/db/prisma'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

export type ActivityKind =
  | 'api_key' | 'user' | 'file' | 'table' | 'auth' | 'deploy'
  | 'auto_fix' | 'webhook' | 'rls' | 'autonomy' | 'general'

export interface ActivityRow {
  /** Stable id (source-prefixed) — safe for React keys and client de-dup. */
  id: string
  kind: ActivityKind
  label: string
  /** ISO timestamp. */
  ts: string
}

export interface ActivityFeedOptions {
  /** Max rows to return. Clamped to 1‥100. Default 8. */
  limit?: number
  /** Cursor — return only rows strictly older than this ISO timestamp. */
  before?: string | null
  /** Restrict to the last N days. null/omitted = all time. */
  sinceDays?: number | null
}

export interface ActivityFeed {
  rows: ActivityRow[]
  /** Pass back as `before` to fetch the next page. null = no more rows. */
  nextCursor: string | null
}

/**
 * Build a chronological (newest-first) activity feed for one project.
 *
 * Pagination is cursor-based on timestamp: each page returns `nextCursor`
 * (the timestamp of its last row) which the caller passes back as `before`.
 * Callers should de-dup appended pages by `id` — timestamp collisions across
 * the two source tables are rare but possible.
 */
export async function buildActivityFeed(
  projectId: string,
  opts: ActivityFeedOptions = {},
): Promise<ActivityFeed> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 100)
  const before = opts.before ? new Date(opts.before) : null
  const since = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000)
    : null

  // Time-window filter shared by both sources: `gte` for the optional
  // sinceDays window, `lt` for the pagination cursor. Undefined keys are
  // ignored by Prisma, so an all-time first page just omits both.
  const timeFilter = { gte: since ?? undefined, lt: before ?? undefined }

  // Fetch `limit` from each source so the merged page can be filled even
  // when one source dominates the other.
  const [audits, fixes] = await Promise.all([
    prisma.auditLog.findMany({
      where: { projectId, timestamp: timeFilter },
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: { id: true, action: true, type: true, timestamp: true, details: true, metadata: true },
    }),
    prisma.correctionEvent.findMany({
      where: { projectId, createdAt: timeFilter },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, correctionDetail: true, createdAt: true, originalActionType: true },
    }),
  ])

  const auditRows: ActivityRow[] = audits.map(a => ({
    id: `audit_${a.id}`,
    ...labelForAudit(a.action, a.type, parseJson(a.metadata), parseJson(a.details)),
    ts: a.timestamp.toISOString(),
  }))

  const fixRows: ActivityRow[] = fixes.map(f => ({
    id: `fix_${f.id}`,
    kind: 'auto_fix' as ActivityKind,
    label: labelForCorrection(f.correctionDetail as Record<string, any> | null, f.originalActionType),
    ts: f.createdAt.toISOString(),
  }))

  const merged = [...auditRows, ...fixRows].sort(
    (a, b) => +new Date(b.ts) - +new Date(a.ts),
  )

  const rows = merged.slice(0, limit)
  // More rows likely remain if the merged set filled the page exactly — the
  // last row's timestamp becomes the next cursor.
  const hasMore = merged.length > limit
  const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].ts : null

  return { rows, nextCursor }
}

/**
 * AuditLog stores `details` as a JSON string and `metadata` as a Json column;
 * either may be null or malformed on legacy rows. Normalise both to a plain
 * object so label builders can read fields without crashing the feed.
 */
function parseJson(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object') return value as Record<string, any>
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return null }
  }
  return null
}

/**
 * Turn one audit row into a sentence a non-developer can read at a glance.
 * Every branch must return plain English — the feed must never surface a raw
 * SCREAMING_SNAKE_CASE action like "HEALTH_FIX_EXECUTED" to the user.
 */
function labelForAudit(
  action: string,
  type: string,
  meta: Record<string, any> | null,
  detail: Record<string, any> | null,
): { kind: ActivityKind; label: string } {
  const a = action.toLowerCase()
  const t = type.toLowerCase()
  const d = detail ?? {}

  // ── Autonomous fix events FIRST ──────────────────────────────────────────
  // These rows are written with type='autonomy' AND action='AGENT_AUTO_FIXED'
  // / 'HEALTH_AUTO_FIXED' / 'FIX_PLAN_AUTO_EXECUTED'. The previous order
  // checked type='autonomy' first and routed every fix row into "Autonomy
  // level updated" — a pre-existing labelling bug. Fix-event actions get the
  // "what because why" sentence; only LEVEL-CHANGE rows fall to the dial branch.
  if (a.includes('auto_fixed') || a.includes('auto_executed')) {
    return { kind: 'auto_fix', label: explainAutonomyEvent(d).full }
  }

  // Autonomy dial — the owner changed how much Backenly may do on its own.
  if (a === 'autonomy_level_changed' || (t.includes('autonomy') && (a.includes('level') || a === 'autonomy_change_freeze' || a === 'autonomy_circuit_open' || a === 'autonomy_shadow_decision' || a === 'autonomy_live_run' || a === 'autonomy_tick'))) {
    if (a === 'autonomy_change_freeze')    return { kind: 'autonomy', label: 'Autonomous changes paused — Backenly is watching an active incident' }
    if (a === 'autonomy_circuit_open')     return { kind: 'autonomy', label: 'Safety circuit tripped — autonomous changes paused for this window' }
    if (a === 'autonomy_shadow_decision')  return { kind: 'autonomy', label: 'Backenly recorded what it would do (shadow mode)' }
    if (a === 'autonomy_live_run')         return { kind: 'autonomy', label: 'Autonomy loop completed a tick' }
    if (a === 'autonomy_tick')             return { kind: 'autonomy', label: 'Autonomy loop completed a tick' }
    // Product mode labels (3-mode dial, 2026-07-18) — never the internal
    // enum names. Legacy BALANCED events read as Autopilot.
    const level = typeof d.level === 'string' ? d.level.toUpperCase() : null
    const label =
      level === 'OFF'            ? 'Autonomy turned off — Backenly will only suggest changes'
      : level === 'CONSERVATIVE' ? 'Autonomy set to Review-only'
      : level === 'BALANCED'     ? 'Autonomy set to Autopilot'
      : level === 'AGGRESSIVE'   ? 'Autonomy set to Autopilot'
      :                            'Autonomy level updated'
    return { kind: 'autonomy', label }
  }

  // ── MCP receipts — the user's own coding agent operated the backend ──────
  // Written by lib/mcp/guard.ts (mutations) and lib/mcp/approvals.ts
  // (escalations). Named "your coding agent" because that is who it was —
  // agent identity is the point of the receipt.
  if (t === 'mcp') {
    const tool = typeof d.tool === 'string' ? d.tool : null
    const target = typeof d.target === 'string' ? d.target : null
    if (a === 'agent_approval_requested') {
      return {
        kind: 'general',
        label: target
          ? `Your coding agent asked to run a destructive change on ${target} — waiting on you`
          : 'Your coding agent asked for a destructive change — waiting on you',
      }
    }
    if (a === 'agent_approval_granted') {
      return { kind: 'general', label: target ? `You approved the agent's change to ${target} — executed with a restore point` : "You approved your coding agent's request" }
    }
    if (a === 'agent_approval_rejected') {
      return { kind: 'general', label: target ? `You rejected the agent's change to ${target}` : "You rejected your coding agent's request" }
    }
    const summary = typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim() : null
    return {
      kind: 'general',
      label: summary
        ? `Your coding agent (via MCP): ${summary.length > 90 ? summary.slice(0, 90) + '…' : summary}`
        : tool
          ? `Your coding agent made a change via MCP (${tool.replace(/_/g, ' ')})`
          : 'Your coding agent made a change via MCP',
    }
  }

  // Self-healing engine — health-check rows that aren't direct fix events.
  if (t.includes('health') || a.includes('health_fix')) {
    if (a.includes('rolled_back')) return { kind: 'auto_fix', label: 'Undid a previous fix' }
    if (a.includes('failed'))      return { kind: 'auto_fix', label: "A fix couldn't be applied — needs another look" }
    if (a.includes('approved'))    return { kind: 'auto_fix', label: 'Approved a recommended fix' }
    if (a.includes('executed'))    return { kind: 'auto_fix', label: 'Applied a fix to your backend' }
    return { kind: 'auto_fix', label: 'Ran a health check' }
  }

  if (t.includes('api_key') || a.includes('api_key')) return { kind: 'api_key', label: 'API key created' }
  if (t.includes('user') && a.includes('register'))   return { kind: 'user',    label: 'New user registered' }
  if (t.includes('file') || t.includes('upload'))     return { kind: 'file',    label: meta?.bucket ? `File uploaded to ${meta.bucket} bucket` : 'File uploaded' }
  if (t.includes('table') || a.includes('create_table')) return { kind: 'table', label: meta?.tableName ? `Table "${meta.tableName}" created` : 'Table created' }
  if (t.includes('auth'))                              return { kind: 'auth',    label: 'Auth setting updated' }
  if (t.includes('deploy')) {
    if (a.includes('fail'))                                          return { kind: 'deploy', label: 'Deployment failed' }
    if (a.includes('rollback') || a.includes('rolled_back'))         return { kind: 'deploy', label: 'Deployment rolled back' }
    if (a.includes('succe') || a.includes('complete') || a.includes('live')) return { kind: 'deploy', label: 'Deployed successfully' }
    if (a.includes('start'))                                         return { kind: 'deploy', label: 'Deployment started' }
    return { kind: 'deploy', label: 'Deployment update' }
  }
  if (t.includes('webhook'))                           return { kind: 'webhook', label: 'Webhook configured' }
  if (t.includes('rls') || t.includes('permission'))   return { kind: 'rls',     label: 'Permission policy updated' }

  // Fallback: any action we don't have a hand-written label for becomes a
  // readable sentence — "SOME_NEW_ACTION" → "Some new action" — never raw caps.
  return { kind: 'general', label: humaniseAction(action) }
}

function humaniseAction(action: string): string {
  const words = action.replace(/_/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function labelForCorrection(
  detail: Record<string, any> | null,
  originalType: string | null,
): string {
  if (detail?.resolution) return detail.resolution
  if (detail?.findingType) return `Auto-fixed: ${humaniseType(detail.findingType)}`
  if (originalType) return `Auto-fixed: ${humaniseType(originalType)}`
  return 'Auto-fix applied'
}

function humaniseType(t: string): string {
  return t.replace(/_/g, ' ')
}
