/**
 * TRIGGER SERVICE
 * ==============
 * Backenly's event-driven automation engine.
 *
 * Allows devs to say: "When a like is created, automatically create a notification"
 * and the platform wires it up — no code, no webhooks to configure.
 *
 * Trigger flow:
 *   DB insert/update/delete  →  trigger-service.fireTriggers()
 *     → finds matching AppTrigger rows
 *     → executes the action (insert into target table, call webhook, etc.)
 *     → persists delivery result to TriggerDeliveryLog (DLQ for failures)
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { REGIONAL_BODY_RETENTION_DAYS, failureWithoutReply, regionalBodiesFor, type RegionalBodies } from '@/lib/data-plane/regional-bodies'
import * as Sentry from '@sentry/nextjs'
import crypto from 'crypto'

// ── Idempotency ──────────────────────────────────────────────────────────────
// Best-effort in-process deduplication (clears on restart, good enough for most cases)
const recentEvents = new Map<string, number>()
const DEDUP_WINDOW_MS = 5_000 // 5 seconds

function isDuplicate(triggerId: string, event: TriggerEvent): boolean {
  const key = `${triggerId}:${event.type}:${event.table}:${JSON.stringify(event.data).slice(0, 200)}`
  const lastFired = recentEvents.get(key)
  if (lastFired && Date.now() - lastFired < DEDUP_WINDOW_MS) return true
  recentEvents.set(key, Date.now())
  // Evict old entries to prevent unbounded growth
  if (recentEvents.size > 1000) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    for (const [k, ts] of recentEvents) {
      if (ts < cutoff) recentEvents.delete(k)
    }
  }
  return false
}

// ── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<{ result: T; attempts: number }> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn()
      return { result, attempts: attempt }
    } catch (err: any) {
      lastError = err
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) // 1s, 2s, 4s
        console.warn(`[Triggers] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${err.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}

export interface TriggerEvent {
  type: 'insert' | 'update' | 'delete'
  table: string
  data: Record<string, any>        // new row (or deleted row for DELETE)
  old?: Record<string, any>        // previous row for UPDATE
}

export interface TriggerResult {
  triggerId: string
  triggerName: string
  success: boolean
  action: string
  error?: string
}

/**
 * Fire all enabled triggers that match the given event.
 * Called after every successful DB mutation in the v1 API routes.
 */
export async function fireTriggers(
  projectId: string,
  event: TriggerEvent
): Promise<TriggerResult[]> {
  const results: TriggerResult[] = []

  // Load all matching triggers for this table + event
  const triggers = await prisma.appTrigger.findMany({
    where: {
      projectId,
      enabled: true,
      sourceTable: event.table,
      event: { in: [event.type, 'all'] },
    },
  })

  if (triggers.length === 0) return results

  console.log(`[Triggers] Firing ${triggers.length} trigger(s) for ${event.type} on ${event.table}`)

  for (const trigger of triggers) {
    // Idempotency check — skip if we just fired this exact event
    if (isDuplicate(trigger.id, event)) {
      console.log(`[Triggers] Skipping duplicate event for trigger "${trigger.name}"`)
      results.push({ triggerId: trigger.id, triggerName: trigger.name, success: true, action: 'skipped (duplicate)' })
      continue
    }

    if (trigger.actionType === 'webhook') {
      // Webhooks go through the DLQ-aware path
      const result = await fireWebhookWithDLQ(projectId, trigger, event)
      results.push(result)
    } else {
      // DB actions: single attempt, already atomic
      try {
        const result = await executeTriggerAction(projectId, trigger, event)
        results.push(result)
      } catch (err: any) {
        console.error(`[Triggers] DB action failed for trigger "${trigger.name}":`, err.message)
        // Identifiers only: the row that fired the trigger is the customer's
        // data and never goes to the error reporter.
        Sentry.captureException(err, {
          tags: { trigger_id: trigger.id, trigger_name: trigger.name, action_type: trigger.actionType },
          extra: triggerReportContext(projectId, event),
        })
        results.push({
          triggerId: trigger.id,
          triggerName: trigger.name,
          success: false,
          action: trigger.actionType,
          error: err.message,
        })
      }
    }
  }

  return results
}

/**
 * Fire a webhook with full retry + DLQ persistence.
 * On permanent failure: records a DEAD entry so non-devs can see + replay it.
 */
async function fireWebhookWithDLQ(
  projectId: string,
  trigger: any,
  event: TriggerEvent
): Promise<TriggerResult> {
  const payload = buildWebhookPayload(trigger, event)

  let attempts = 0
  let lastError: string | undefined
  let lastStatusCode: number | undefined

  try {
    const { result, attempts: att } = await withRetry(
      async () => {
        attempts++
        const { statusCode } = await executeWebhookRequest(trigger, payload)
        lastStatusCode = statusCode
      },
      3,
      1000
    )
    attempts = att

    // SUCCESS — log delivery
    await recordDelivery(projectId, trigger, event, payload, {
      status: 'SUCCESS',
      attemptCount: attempts,
      statusCode: lastStatusCode,
      deliveredAt: new Date(),
    })

    console.log(`[Triggers] ✅ Webhook fired to ${trigger.webhookUrl}`)
    return {
      triggerId: trigger.id,
      triggerName: trigger.name,
      success: true,
      action: `Webhook fired to ${trigger.webhookUrl}`,
    }
  } catch (err: any) {
    lastError = err.message

    // DEAD — all retries exhausted, push to DLQ
    await recordDelivery(projectId, trigger, event, payload, {
      status: 'DEAD',
      attemptCount: attempts,
      statusCode: lastStatusCode,
      error: lastError,
    })

    // Report to Sentry — this is a silent failure non-devs can't see. Without
    // the row, and without the receiver's path and query, which can carry a
    // token: its host is enough to tell which endpoint is failing. Nor the
    // receiver's reply, which can quote the row it was sent.
    Sentry.captureException(withoutReply(err), {
      tags: {
        trigger_id: trigger.id,
        trigger_name: trigger.name,
        webhook_host: hostOf(trigger.webhookUrl),
        project_id: projectId,
      },
      extra: { ...triggerReportContext(projectId, event), attempts, lastStatusCode },
    })

    console.error(`[Triggers] ☠️ Webhook permanently failed for trigger "${trigger.name}" after ${attempts} attempts — logged to DLQ`)

    return {
      triggerId: trigger.id,
      triggerName: trigger.name,
      success: false,
      action: `Webhook to ${trigger.webhookUrl}`,
      error: lastError,
    }
  }
}

/**
 * A delivery's log row, and its body where the project's data is kept: the
 * payload and the receiver's reply on the row at home; in the project's region
 * otherwise, written first and under the row's id, with only the HTTP status
 * of a failure on the row (lib/data-plane/regional-bodies.ts).
 */
async function recordDelivery(
  projectId: string,
  trigger: { id: string },
  event: TriggerEvent,
  payload: Record<string, any>,
  outcome: { status: 'SUCCESS' | 'DEAD'; attemptCount: number; statusCode?: number; error?: string; deliveredAt?: Date },
): Promise<void> {
  const bodies = await regionalBodiesFor(projectId)
  const id = crypto.randomUUID()
  await bodies.set('trigger', id, { payload, ...(outcome.error !== undefined ? { error: outcome.error } : {}) })

  await prisma.triggerDeliveryLog.create({
    data: {
      id,
      triggerId: trigger.id,
      projectId,
      eventType: event.type,
      table: event.table,
      payload: bodies.region ? Prisma.DbNull : (payload as any),
      status: outcome.status,
      attemptCount: outcome.attemptCount,
      statusCode: outcome.statusCode,
      deliveredAt: outcome.deliveredAt,
      error: bodies.region ? failureWithoutReply(outcome.error, outcome.statusCode) : outcome.error,
    },
  })
}

/**
 * Replay a dead webhook delivery. Called from the retry API.
 */
export async function replayDelivery(
  projectId: string,
  deliveryLogId: string
): Promise<{ success: boolean; error?: string }> {
  const log = await prisma.triggerDeliveryLog.findFirst({
    where: { id: deliveryLogId, projectId, status: 'DEAD' },
    include: { trigger: true },
  })

  if (!log) {
    return { success: false, error: 'Delivery log not found or not in DEAD state' }
  }

  const trigger = log.trigger
  if (!trigger.webhookUrl) {
    return { success: false, error: 'Trigger no longer has a webhook URL' }
  }

  const bodies: RegionalBodies = await regionalBodiesFor(projectId)
  let payload = log.payload as Record<string, any> | null
  if (payload === null) {
    const held = await bodies.get('trigger', deliveryLogId)
    if (!held) {
      return { success: false, error: `The event is no longer kept in the project's region (${REGIONAL_BODY_RETENTION_DAYS} days)` }
    }
    payload = held.payload as Record<string, any>
  }

  try {
    const { statusCode } = await executeWebhookRequest(trigger, payload)

    // Mark original log as SUCCESS
    await prisma.triggerDeliveryLog.update({
      where: { id: deliveryLogId },
      data: {
        status: 'SUCCESS',
        statusCode,
        error: null,
        deliveredAt: new Date(),
        attemptCount: { increment: 1 },
      },
    })
    if (bodies.region) await bodies.set('trigger', deliveryLogId, { error: null })

    console.log(`[Triggers] ✅ Replayed delivery ${deliveryLogId} successfully`)
    return { success: true }
  } catch (err: any) {
    // Update attempt count + keep as DEAD
    await prisma.triggerDeliveryLog.update({
      where: { id: deliveryLogId },
      data: {
        error: bodies.region ? failureWithoutReply(err.message, undefined) : err.message,
        attemptCount: { increment: 1 },
      },
    })
    if (bodies.region) await bodies.set('trigger', deliveryLogId, { error: err.message })

    Sentry.captureException(withoutReply(err), {
      tags: { replay: true, delivery_log_id: deliveryLogId, project_id: projectId },
    })

    return { success: false, error: err.message }
  }
}

/** A delivery failure as the error reporter may see it: the HTTP status, not the receiver's reply. */
export function withoutReply(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  const reported = new Error(failureWithoutReply(message, undefined) ?? 'Webhook delivery failed')
  reported.name = err instanceof Error ? err.name : 'Error'
  return reported
}

// ── Error-report context ──────────────────────────────────────────────────────

/** What a trigger failure tells the error reporter: which event, never its row. */
export function triggerReportContext(projectId: string, event: TriggerEvent): Record<string, string> {
  return { projectId, table: event.table, eventType: event.type }
}

/** A webhook URL's host, or a placeholder for one that does not parse. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return 'none'
  try {
    return new URL(url).host
  } catch {
    return 'unparseable'
  }
}

// ── Webhook helpers ───────────────────────────────────────────────────────────

function buildWebhookPayload(trigger: any, event: TriggerEvent): Record<string, any> {
  return {
    trigger: trigger.name,
    event: event.type,
    table: event.table,
    data: event.data,
    old: event.old || null,
    timestamp: new Date().toISOString(),
  }
}

async function executeWebhookRequest(
  trigger: any,
  payload: Record<string, any>
): Promise<{ statusCode: number }> {
  if (!trigger.webhookUrl) {
    throw new Error('webhook trigger requires webhookUrl')
  }

  const body = JSON.stringify(payload)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Backenly-Trigger': trigger.name,
    'X-Backenly-Event': payload.event,
    'X-Backenly-Table': payload.table,
  }

  // Sign payload if secret configured
  if (trigger.webhookSecret) {
    const signature = crypto
      .createHmac('sha256', trigger.webhookSecret)
      .update(body)
      .digest('hex')
    headers['X-Backenly-Signature'] = `sha256=${signature}`
  }

  // safeFetch, NOT fetch — the same guard endpoint webhooks already deliver
  // through (lib/webhooks/index.ts). A raw fetch on a stored URL from the web
  // process is a server-side request forgery primitive with a persistence
  // layer: the failure text below lands in TriggerDeliveryLog.error, which the
  // agent reads back via webhooks {trigger_deliveries} — loopback services,
  // the VPC and 169.254.169.254 included. The guard validates scheme and
  // address at connect time, re-validates every redirect hop, and caps the
  // response size.
  const { safeFetch } = await import('@/lib/security/outbound-guard')
  const response = await safeFetch(trigger.webhookUrl, {
    method: 'POST',
    egressScope: 'webhook',
    headers,
    body,
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // Diagnostic only, and served back to every reader of the delivery log:
    // capped so a receiver cannot park kilobytes of its choosing there.
    throw new Error(`Webhook returned ${response.status}: ${String(text).slice(0, 300)}`)
  }

  return { statusCode: response.status }
}

// ── Execute trigger action (non-webhook) ─────────────────────────────────────

async function executeTriggerAction(
  projectId: string,
  trigger: any,
  event: TriggerEvent
): Promise<TriggerResult> {
  // Check conditions (optional filter)
  if (trigger.conditions) {
    const conditions = trigger.conditions as Record<string, any>
    const sourceData = event.data || {}
    for (const [key, expectedValue] of Object.entries(conditions)) {
      if (sourceData[key] !== expectedValue) {
        return {
          triggerId: trigger.id,
          triggerName: trigger.name,
          success: true,
          action: 'skipped (condition not met)',
        }
      }
    }
  }

  switch (trigger.actionType) {
    case 'insert_row':
      return await executeInsertRow(projectId, trigger, event)

    case 'update_row':
      return await executeUpdateRow(projectId, trigger, event)

    case 'delete_rows':
      return await executeDeleteRows(projectId, trigger, event)

    default:
      throw new Error(`Unknown trigger action type: ${trigger.actionType}`)
  }
}

async function executeInsertRow(
  projectId: string,
  trigger: any,
  event: TriggerEvent
): Promise<TriggerResult> {
  if (!trigger.targetTable) {
    throw new Error('insert_row trigger requires targetTable')
  }

  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const targetRow: Record<string, any> = {}

  const fieldMappings = (trigger.fieldMappings || {}) as Record<string, string>
  for (const [sourceField, targetField] of Object.entries(fieldMappings)) {
    if (event.data[sourceField] !== undefined) {
      targetRow[targetField] = event.data[sourceField]
    }
  }

  const staticFields = (trigger.staticFields || {}) as Record<string, any>
  Object.assign(targetRow, staticFields)

  if (Object.keys(targetRow).length === 0) {
    throw new Error('No fields to insert — check fieldMappings and staticFields')
  }

  const columns = Object.keys(targetRow).map(k => `"${k}"`).join(', ')
  const placeholders = Object.keys(targetRow).map((_, i) => `$${i + 1}`).join(', ')
  const values = Object.values(targetRow)

  const sql = `
    INSERT INTO "${postgresSchema}"."${trigger.targetTable}" (${columns})
    VALUES (${placeholders})
  `

  // On the database holding the project's data, in its region.
  const db = await workspaceRawClient(projectId)
  await db.$executeRawUnsafe(sql, ...values)

  console.log(`[Triggers] ✅ Inserted row into "${trigger.targetTable}" via trigger "${trigger.name}"`)

  return {
    triggerId: trigger.id,
    triggerName: trigger.name,
    success: true,
    action: `Inserted row into ${trigger.targetTable}`,
  }
}

async function executeUpdateRow(
  projectId: string,
  trigger: any,
  event: TriggerEvent
): Promise<TriggerResult> {
  if (!trigger.targetTable) {
    throw new Error('update_row trigger requires targetTable')
  }

  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const fieldMappings = (trigger.fieldMappings || {}) as Record<string, string>
  const staticFields = (trigger.staticFields || {}) as Record<string, any>

  if (Object.keys(staticFields).length === 0) {
    throw new Error('update_row trigger requires staticFields (the values to SET)')
  }

  let paramIdx = 1
  const setValues: any[] = []
  const setClauses = Object.entries(staticFields).map(([col, val]) => {
    setValues.push(val)
    return `"${col}" = $${paramIdx++}`
  })

  const whereValues: any[] = []
  const whereClauses = Object.entries(fieldMappings).map(([sourceField, targetField]) => {
    whereValues.push(event.data[sourceField])
    return `"${targetField}" = $${paramIdx++}`
  })

  if (whereClauses.length === 0) {
    throw new Error('update_row trigger requires fieldMappings to identify target rows')
  }

  const sql = `
    UPDATE "${postgresSchema}"."${trigger.targetTable}"
    SET ${setClauses.join(', ')}
    WHERE ${whereClauses.join(' AND ')}
  `

  // On the database holding the project's data, in its region.
  const db = await workspaceRawClient(projectId)
  await db.$executeRawUnsafe(sql, ...setValues, ...whereValues)

  console.log(`[Triggers] ✅ Updated rows in "${trigger.targetTable}" via trigger "${trigger.name}"`)

  return {
    triggerId: trigger.id,
    triggerName: trigger.name,
    success: true,
    action: `Updated rows in ${trigger.targetTable}`,
  }
}

async function executeDeleteRows(
  projectId: string,
  trigger: any,
  event: TriggerEvent
): Promise<TriggerResult> {
  if (!trigger.targetTable) {
    throw new Error('delete_rows trigger requires targetTable')
  }

  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const fieldMappings = (trigger.fieldMappings || {}) as Record<string, string>

  if (Object.keys(fieldMappings).length === 0) {
    throw new Error('delete_rows trigger requires fieldMappings to identify target rows')
  }

  let paramIdx = 1
  const values: any[] = []
  const whereClauses = Object.entries(fieldMappings).map(([sourceField, targetField]) => {
    values.push(event.data[sourceField])
    return `"${targetField}" = $${paramIdx++}`
  })

  const sql = `
    DELETE FROM "${postgresSchema}"."${trigger.targetTable}"
    WHERE ${whereClauses.join(' AND ')}
  `

  // On the database holding the project's data, in its region.
  const db = await workspaceRawClient(projectId)
  await db.$executeRawUnsafe(sql, ...values)

  console.log(`[Triggers] ✅ Deleted rows from "${trigger.targetTable}" via trigger "${trigger.name}"`)

  return {
    triggerId: trigger.id,
    triggerName: trigger.name,
    success: true,
    action: `Deleted rows from ${trigger.targetTable}`,
  }
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

export async function createTrigger(
  projectId: string,
  params: {
    name: string
    description?: string
    sourceTable: string
    event: string
    conditions?: Record<string, any>
    actionType: string
    targetTable?: string
    fieldMappings?: Record<string, string>
    staticFields?: Record<string, any>
    webhookUrl?: string
  }
): Promise<{ id: string; name: string }> {
  // A stored URL is a standing instruction to the delivery worker. Refusing a
  // blocked destination here answers the creator with the reason, instead of
  // parking a trigger that fails on every fire; delivery still re-validates,
  // because a hostname that is public today can point somewhere else tomorrow.
  if (params.webhookUrl) {
    const { assertAllowedUrl } = await import('@/lib/security/outbound-guard')
    assertAllowedUrl(params.webhookUrl, 'webhook')
  }

  // One governed change, in the project's history (lib/changes/resources/webhooks.ts).
  const { governedChange } = await import('@/lib/changes/ledger')
  const trigger = await governedChange(projectId, `Create trigger ${params.name}`, () => prisma.appTrigger.create({
    data: {
      projectId,
      name: params.name,
      description: params.description,
      sourceTable: params.sourceTable,
      event: params.event,
      conditions: params.conditions || undefined,
      actionType: params.actionType,
      targetTable: params.targetTable,
      fieldMappings: params.fieldMappings || undefined,
      staticFields: params.staticFields || undefined,
      webhookUrl: params.webhookUrl,
    },
  }))

  console.log(`[Triggers] Created trigger "${trigger.name}" (${trigger.id})`)

  return { id: trigger.id, name: trigger.name }
}

export async function listTriggers(projectId: string) {
  return prisma.appTrigger.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      sourceTable: true,
      event: true,
      actionType: true,
      targetTable: true,
      // The destination a webhook trigger posts to — the console renders it.
      // webhookSecret is deliberately NOT selected: it never leaves the server.
      webhookUrl: true,
      enabled: true,
      createdAt: true,
    },
  })
}

/**
 * Delete one trigger of this project. Returns whether a trigger was deleted, so
 * a caller never reports a removal that did not happen (WH-F15).
 *
 * The id is checked before the query: Prisma drops an undefined filter, so
 * `deleteMany({ where: { id: undefined, projectId } })` deletes EVERY trigger
 * in the project.
 */
export async function deleteTrigger(projectId: string, triggerId: string): Promise<boolean> {
  if (typeof triggerId !== 'string' || !triggerId) {
    throw new Error('deleteTrigger needs the id of the trigger to delete')
  }
  const { governedChange } = await import('@/lib/changes/ledger')
  const { count } = await governedChange(projectId, 'Delete a trigger', () => prisma.appTrigger.deleteMany({
    where: { id: triggerId, projectId },
  }))
  return count > 0
}

/**
 * List delivery logs for a project — optionally filter by status (DEAD = DLQ view).
 */
export async function listDeliveryLogs(
  projectId: string,
  opts: { status?: 'SUCCESS' | 'FAILED' | 'DEAD'; limit?: number } = {}
) {
  const rows = await deliveryLogRows(projectId, opts)

  // A regional project's failure text is read from its region, for whoever
  // asked; the platform row holds only the HTTP status.
  const bodies = await regionalBodiesFor(projectId)
  if (!bodies.region) return rows
  const held = await bodies.getMany('trigger', rows.map((row) => row.id))
  return rows.map((row) => {
    const error = held.get(row.id)?.error
    return error != null ? { ...row, error } : row
  })
}

function deliveryLogRows(projectId: string, opts: { status?: 'SUCCESS' | 'FAILED' | 'DEAD'; limit?: number }) {
  return prisma.triggerDeliveryLog.findMany({
    where: {
      projectId,
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    select: {
      id: true,
      triggerId: true,
      eventType: true,
      table: true,
      status: true,
      attemptCount: true,
      statusCode: true,
      error: true,
      deliveredAt: true,
      createdAt: true,
      trigger: { select: { name: true, webhookUrl: true } },
    },
  })
}
