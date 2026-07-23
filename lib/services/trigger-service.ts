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

import { prisma } from '@/lib/db'
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
        Sentry.captureException(err, {
          tags: { trigger_id: trigger.id, trigger_name: trigger.name, action_type: trigger.actionType },
          extra: { projectId, event },
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
    await prisma.triggerDeliveryLog.create({
      data: {
        triggerId: trigger.id,
        projectId,
        eventType: event.type,
        table: event.table,
        payload: payload as any,
        status: 'SUCCESS',
        attemptCount: attempts,
        statusCode: lastStatusCode,
        deliveredAt: new Date(),
      },
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
    await prisma.triggerDeliveryLog.create({
      data: {
        triggerId: trigger.id,
        projectId,
        eventType: event.type,
        table: event.table,
        payload: payload as any,
        status: 'DEAD',
        attemptCount: attempts,
        statusCode: lastStatusCode,
        error: lastError,
      },
    })

    // Report to Sentry — this is a silent failure non-devs can't see
    Sentry.captureException(err, {
      tags: {
        trigger_id: trigger.id,
        trigger_name: trigger.name,
        webhook_url: trigger.webhookUrl,
        project_id: projectId,
      },
      extra: { event, attempts, lastStatusCode },
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

  const payload = log.payload as Record<string, any>

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

    console.log(`[Triggers] ✅ Replayed delivery ${deliveryLogId} successfully`)
    return { success: true }
  } catch (err: any) {
    // Update attempt count + keep as DEAD
    await prisma.triggerDeliveryLog.update({
      where: { id: deliveryLogId },
      data: {
        error: err.message,
        attemptCount: { increment: 1 },
      },
    })

    Sentry.captureException(err, {
      tags: { replay: true, delivery_log_id: deliveryLogId, project_id: projectId },
    })

    return { success: false, error: err.message }
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

  const response = await fetch(trigger.webhookUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000), // 30s timeout
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Webhook returned ${response.status}: ${text}`)
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

  await prisma.$executeRawUnsafe(sql, ...values)

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

  await prisma.$executeRawUnsafe(sql, ...setValues, ...whereValues)

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

  await prisma.$executeRawUnsafe(sql, ...values)

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
  const trigger = await prisma.appTrigger.create({
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
  })

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
      enabled: true,
      createdAt: true,
    },
  })
}

export async function deleteTrigger(projectId: string, triggerId: string): Promise<void> {
  await prisma.appTrigger.deleteMany({
    where: { id: triggerId, projectId },
  })
}

/**
 * List delivery logs for a project — optionally filter by status (DEAD = DLQ view).
 */
export async function listDeliveryLogs(
  projectId: string,
  opts: { status?: 'SUCCESS' | 'FAILED' | 'DEAD'; limit?: number } = {}
) {
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
