/**
 * POSTHOG INTEGRATION EXECUTOR — BEHAVIORAL CHAIN
 * =================================================
 * PostHog is a product-analytics integration — NOT an LLM. It was previously
 * (incorrectly) routed through the AI executor, which generated a phantom
 * "posthog chat completion endpoint". This executor wires it correctly.
 *
 * States produced:
 *   key_stored          → API key stored, nothing else done.
 *   partially_configured → Key + table exist, but a helper function failed.
 *   behaviorally_ready   → Key + analytics_events table + capture/identify
 *                          functions all generated.
 *
 * Behavioral chain:
 *   1. Require the PostHog project API key (phc_…)
 *   2. Create `analytics_events` table (local mirror/log of captured events)
 *   3. Generate `posthog-capture`       — record a product event
 *   4. Generate `posthog-identify`      — set person properties
 *   5. Generate `posthog-feature-flag`  — evaluate a feature flag for a user
 *   6. Compute readiness and persist it
 *
 * Runtime contract: generated functions call ctx.integrations.posthog.*
 * (see lib/services/ai-functions/integration-context.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { storeIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { executeAction } from '@/lib/ai/minimal-executor'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { withAgentTransaction } from '@/lib/ai/transaction-manager'
import { emit } from '@/lib/events/bus'
import {
  checkIntegrationReadiness,
  toIntegrationRecord,
  formatReadinessReport,
} from './readiness'

export interface PostHogIntegrationResult {
  success: boolean
  message: string
  needsApiKey?: boolean
  keyHint?: string
  readiness?: string
}

export async function executePostHogIntegration(
  projectId: string,
  apiKey?: string,
): Promise<PostHogIntegrationResult> {
  const keyExists = await hasIntegrationKey(projectId, 'posthog')

  if (!keyExists && !apiKey) {
    return {
      success: false,
      needsApiKey: true,
      message: 'PostHog needs a project API key — pick how you want to proceed in the card below.',
      keyHint: 'Paste your PostHog project API key (phc_...)',
    }
  }

  const autoWiredSteps: string[] = []

  // ── Transaction: store key + create the local event log table ─────────────
  const txResult = await withAgentTransaction(projectId, async (ctx) => {
    if (apiKey) {
      await storeIntegrationKey(projectId, 'posthog', apiKey)
      ctx.record({ type: 'key_stored', payload: { integrationId: 'posthog' } })
    }

    // analytics_events — local mirror of every event sent to PostHog. Gives the
    // dashboard a queryable record and a retry surface if PostHog delivery fails.
    const tblResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'analytics_events',
        columns: [
          { name: 'distinct_id',      type: 'TEXT', notNull: true },
          { name: 'event',            type: 'TEXT', notNull: true },
          { name: 'properties',       type: 'JSONB' },
          { name: 'sent_to_posthog',  type: 'BOOLEAN', default: 'false' },
          { name: 'error',            type: 'TEXT' },
        ],
      },
    }, projectId)
    if (tblResult.success) {
      autoWiredSteps.push('✅ `analytics_events` table created (event log)')
      ctx.record({ type: 'table_created', payload: { tableName: 'analytics_events' } })
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    const existing = (project?.activeIntegrations as Record<string, any>) ?? {}
    await prisma.project.update({
      where: { id: projectId },
      data: {
        activeIntegrations: {
          ...existing,
          posthog: {
            enabled: true,
            readiness: 'partially_configured',
            activatedAt: existing.posthog?.activatedAt ?? new Date().toISOString(),
            activatedBy: 'integration_executor',
            tables: ['analytics_events'],
          },
        },
      },
    })
    ctx.record({ type: 'integration_activated', payload: { integrationId: 'posthog' } })
  })

  if (!txResult.success) {
    return {
      success: false,
      message: txResult.rolledBack
        ? `PostHog setup failed and was rolled back: ${txResult.message}`
        : `PostHog setup failed: ${txResult.message}`,
    }
  }

  // ── Generate behavioral helper functions ───────────────────────────────────

  // 3. posthog-capture — record a product-analytics event
  const captureResult = await executeGenerateFunction(
    {
      functionName: 'posthog-capture',
      description: [
        'Record a product-analytics event in PostHog.',
        'Accept { distinctId, event, properties? } in the request body.',
        'Call ctx.integrations.posthog.capture({ distinctId, event, properties }).',
        'Also insert a row into analytics_events with distinct_id, event, properties, and sent_to_posthog=true (or false + error on failure).',
        'Require authentication — reject unauthenticated requests with 401.',
        'Return { tracked: true }.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (captureResult.success) autoWiredSteps.push('✅ Generated `posthog-capture` (event tracking)')

  // 4. posthog-identify — attach person properties to a user
  const identifyResult = await executeGenerateFunction(
    {
      functionName: 'posthog-identify',
      description: [
        'Attach or update person properties on a PostHog user.',
        'Accept { distinctId, properties } in the request body.',
        'Call ctx.integrations.posthog.identify({ distinctId, properties }).',
        'Require authentication — reject unauthenticated requests with 401.',
        'Return { identified: true }.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (identifyResult.success) autoWiredSteps.push('✅ Generated `posthog-identify` (person properties)')

  // 5. posthog-feature-flag — evaluate a feature flag for a user
  const flagResult = await executeGenerateFunction(
    {
      functionName: 'posthog-feature-flag',
      description: [
        'Evaluate a PostHog feature flag for a specific user.',
        'Accept { flagKey, distinctId } in the request body.',
        'Call ctx.integrations.posthog.isFeatureEnabled(flagKey, distinctId) — it returns a boolean.',
        'Require authentication — reject unauthenticated requests with 401.',
        'Return { flagKey, enabled }.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (flagResult.success) autoWiredSteps.push('✅ Generated `posthog-feature-flag` (flag evaluation)')

  // ── Emit events ────────────────────────────────────────────────────────────
  emit('integration.activated', projectId, { integrationId: 'posthog', tables: ['analytics_events'] })
  emit('schema.changed', projectId, { tables: ['analytics_events'] })

  import('@/lib/versioning/schema-versions').then(({ snapshotSchema }) =>
    snapshotSchema(
      projectId,
      'PostHog integration: analytics_events + capture/identify/feature-flag functions',
      'posthog_executor',
    ).catch(() => {})
  )

  // ── Compute final readiness ────────────────────────────────────────────────
  const readinessReport = await checkIntegrationReadiness(projectId, 'posthog')

  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const existingIntegrations = (proj?.activeIntegrations as Record<string, any>) ?? {}
  await prisma.project.update({
    where: { id: projectId },
    data: {
      activeIntegrations: {
        ...existingIntegrations,
        posthog: toIntegrationRecord(readinessReport, {
          activatedAt: existingIntegrations.posthog?.activatedAt ?? new Date().toISOString(),
          activatedBy: 'integration_executor',
          tables: ['analytics_events'],
        }),
      },
    },
  })

  const stepsMsg = `\n\n**Auto-wired:**\n${autoWiredSteps.join('\n')}`
  const readinessMsg = `\n\n${formatReadinessReport(readinessReport)}`

  return {
    success: true,
    message: `PostHog connected.${stepsMsg}${readinessMsg}`,
    readiness: readinessReport.status,
  }
}
