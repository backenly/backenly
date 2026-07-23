/**
 * EMAIL INTEGRATION EXECUTOR — BEHAVIORAL CHAIN
 * ================================================
 * Phase 2: Moves beyond table creation to a fully wired email system.
 *
 * States produced:
 *   key_stored          → Key stored, but no tables or triggers created.
 *   partially_configured → Tables created; auth not enabled so triggers
 *                          could not be auto-created.
 *   behaviorally_ready   → Key + tables + welcome trigger (+ password-reset
 *                          trigger if a reset table exists).
 *
 * Behavioral chain:
 *   1. Store API key (no mock mode — key required for real delivery)
 *   2. Create `email_events` table (delivery log with message_id + status tracking)
 *   3. Create `email_templates` table (reusable named templates)
 *   4. Seed standard templates: welcome, password_reset, notification
 *   5. If auth is enabled → create welcome-email AI function (on_signup trigger)
 *   6. If password_reset / reset_tokens table exists → create reset-email AI function
 *   7. Create generic transactional email helper function (manual trigger)
 *   8. Compute readiness and persist it
 */

import { prisma } from '@/lib/db/prisma'
import { storeIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { executeAction } from '@/lib/ai/minimal-executor'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { withAgentTransaction } from '@/lib/ai/transaction-manager'
import { emit } from '@/lib/events/bus'
import { getActiveGraph } from '@/lib/orchestration/graph-pointer'
import {
  checkIntegrationReadiness,
  toIntegrationRecord,
  formatReadinessReport,
} from './readiness'

export type EmailProvider = 'resend' | 'sendgrid'

export interface EmailIntegrationResult {
  success: boolean
  message: string
  needsApiKey?: boolean
  keyHint?: string
  readiness?: string
}

// Commerce table names — if found, we create a payment confirmation email trigger
const COMMERCE_TABLES = [
  'orders', 'order', 'payments', 'payment', 'purchases', 'purchase',
  'subscriptions', 'subscription', 'transactions',
]

// Standard transactional template seeds
const STANDARD_TEMPLATES = [
  {
    name: 'welcome',
    subject: 'Welcome to {{app_name}}!',
    body_text: 'Hi {{user_name}}, welcome! Click here to get started: {{cta_url}}',
  },
  {
    name: 'password_reset',
    subject: 'Reset your {{app_name}} password',
    body_text: 'Click here to reset your password: {{reset_url}}. This link expires in 1 hour.',
  },
  {
    name: 'notification',
    subject: '{{subject}}',
    body_text: '{{message}}',
  },
]

export async function executeEmailIntegration(
  projectId: string,
  provider: EmailProvider,
  apiKey?: string,
): Promise<EmailIntegrationResult> {
  const keyExists = await hasIntegrationKey(projectId, provider)
  const providerName = provider === 'sendgrid' ? 'SendGrid' : 'Resend'
  const keyExample   = provider === 'sendgrid' ? 'SG.xxx.yyy' : 're_...'
  const keyDocsUrl   = provider === 'sendgrid'
    ? 'app.sendgrid.com → Settings → API Keys'
    : 'resend.com → API Keys'

  // Email requires a real API key — no mock mode (unlike Stripe which has tables as value)
  // Short one-liner — the new ChoiceView credential card delivers the full
  // "Do you have the key? / Use placeholder / Show me how to get one" UX.
  if (!keyExists && !apiKey) {
    return {
      success: false,
      needsApiKey: true,
      message: `${providerName} needs an API key — pick how you want to proceed in the card below.`,
      keyHint: `Paste your ${providerName} API key (${keyExample})`,
    }
  }

  // ── Live key validation (Resend only — verify against API before storing) ──
  if (apiKey && provider === 'resend') {
    try {
      const checkRes = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      })
      if (checkRes.status === 401 || checkRes.status === 403) {
        return {
          success: false,
          message: [
            '**Invalid Resend API key.** The key was rejected by Resend.',
            '',
            'Check that you copied the full key (starts with `re_`) and try again.',
            'Find your keys at resend.com → API Keys.',
          ].join('\n'),
        }
      }
    } catch {
      // Network timeout — proceed optimistically (offline/test envs)
    }
  }

  const autoWiredSteps: string[] = []

  // ── Transaction: store key + create tables ────────────────────────────────
  const txResult = await withAgentTransaction(projectId, async (ctx) => {
    if (apiKey) {
      await storeIntegrationKey(projectId, provider, apiKey)
      ctx.record({ type: 'key_stored', payload: { integrationId: provider } })
    }

    // email_events — delivery log for every sent message
    const evtResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'email_events',
        columns: [
          { name: 'message_id',       type: 'TEXT' },        // provider-assigned ID
          { name: 'recipient',        type: 'TEXT', notNull: true },
          { name: 'subject',          type: 'TEXT', notNull: true },
          { name: 'template',         type: 'TEXT' },         // template name used
          { name: 'provider',         type: 'TEXT', notNull: true, default: provider },
          { name: 'status',           type: 'TEXT', notNull: true, default: 'pending' },
          // status values: pending | sent | delivered | bounced | failed | opened | clicked
          { name: 'sent_at',          type: 'TIMESTAMP' },
          { name: 'delivered_at',     type: 'TIMESTAMP' },
          { name: 'opened_at',        type: 'TIMESTAMP' },
          { name: 'error',            type: 'TEXT' },
          { name: 'metadata',         type: 'JSONB' },        // any extra provider data
        ],
      },
    }, projectId)
    if (evtResult.success) {
      autoWiredSteps.push('✅ `email_events` table created (delivery log)')
      ctx.record({ type: 'table_created', payload: { tableName: 'email_events' } })
    }

    // email_templates — reusable named templates
    const tplResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'email_templates',
        columns: [
          { name: 'name',        type: 'TEXT', notNull: true, unique: true },
          { name: 'subject',     type: 'TEXT', notNull: true },
          { name: 'body_html',   type: 'TEXT' },
          { name: 'body_text',   type: 'TEXT', notNull: true },
          { name: 'variables',   type: 'JSONB' },  // expected variable names
          { name: 'active',      type: 'BOOLEAN', default: 'true' },
        ],
      },
    }, projectId)
    if (tplResult.success) {
      autoWiredSteps.push('✅ `email_templates` table created')
      ctx.record({ type: 'table_created', payload: { tableName: 'email_templates' } })

      // Seed standard templates via INSERT_DATA
      for (const tpl of STANDARD_TEMPLATES) {
        await executeAction({
          action: 'INSERT_DATA',
          params: {
            tableName: 'email_templates',
            data: tpl,
          },
        }, projectId).catch(() => {})
      }
      autoWiredSteps.push('✅ Seeded standard templates: welcome, password_reset, notification')
    }

    // Preliminary activeIntegrations entry (readiness updated after tx)
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
          [provider]: {
            enabled: true,
            readiness: 'partially_configured',
            activatedAt: existing[provider]?.activatedAt ?? new Date().toISOString(),
            activatedBy: 'integration_executor',
            tables: ['email_events', 'email_templates'],
          },
        },
      },
    })
    ctx.record({ type: 'integration_activated', payload: { integrationId: provider } })
  })

  if (!txResult.success) {
    return {
      success: false,
      message: txResult.rolledBack
        ? `Email setup failed and was rolled back: ${txResult.message}`
        : `Email setup failed: ${txResult.message}`,
    }
  }

  // ── Generate behavioral AI functions (outside transaction) ─────────────────

  // 5. Welcome email trigger (on_signup)
  const graph = await getActiveGraph(projectId).catch(() => null)
  const authEnabled = graph?.auth?.providers?.email?.enabled === true

  if (authEnabled) {
    const welcomeResult = await executeGenerateFunction(
      {
        functionName: 'welcome-email',
        description: [
          `Welcome email triggered on user sign-up.`,
          `Use ctx.integrations.${provider}.send() to send an email.`,
          `Look up the "welcome" template from the email_templates table.`,
          `Substitute {{user_name}} with the user's name or email prefix, {{app_name}} with the project name.`,
          `Insert a row into email_events with status="sent" (or "failed" on error) and the returned message_id.`,
          `Require authentication context — read the signed-up user from event.user.`,
        ].join(' '),
        method: 'POST',
      },
      projectId,
    ).catch(() => ({ success: false }))
    if (welcomeResult.success) {
      autoWiredSteps.push(`✅ Welcome email trigger created (on_signup → ${provider})`)
    }
  } else {
    autoWiredSteps.push(`ℹ️ Welcome email skipped — email auth not enabled (enable it to auto-create the trigger)`)
  }

  // 6. Password-reset email trigger
  const resetTable = await prisma.table.findFirst({
    where: { projectId, name: { in: ['password_reset', 'password_resets', 'reset_tokens'] } },
    select: { id: true, name: true },
  })
  if (resetTable) {
    const resetResult = await executeGenerateFunction(
      {
        functionName: 'password-reset-email',
        description: [
          `Password reset email triggered when a row is inserted into \`${resetTable.name}\`.`,
          `Use ctx.integrations.${provider}.send() to send the email.`,
          `Look up the "password_reset" template from email_templates.`,
          `Substitute {{reset_url}} with the token from the inserted row, {{app_name}} with the project name.`,
          `Set the expiry message to "This link expires in 1 hour."`,
          `Insert a row into email_events with status="sent" or "failed" and the provider message_id.`,
        ].join(' '),
        method: 'POST',
      },
      projectId,
    ).catch(() => ({ success: false }))
    if (resetResult.success) {
      autoWiredSteps.push(`✅ Password-reset email trigger created (${resetTable.name}.insert → ${provider})`)
    }
  }

  // 7. Generic transactional email helper (manual trigger — callable from other functions)
  const sendResult = await executeGenerateFunction(
    {
      functionName: 'send-transactional-email',
      description: [
        `General-purpose transactional email helper.`,
        `Accept { to, templateName, variables } in the request body.`,
        `Look up the named template from email_templates.`,
        `Replace all {{variable}} placeholders with the provided values.`,
        `Use ctx.integrations.${provider}.send() to deliver the email.`,
        `Insert a row into email_events recording recipient, template, provider, status, and message_id.`,
        `Require authentication.`,
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (sendResult.success) {
    autoWiredSteps.push(`✅ Generated \`POST /fn/send-transactional-email\` (reusable helper)`)
  }

  // 8. Payment confirmation email (when a commerce table exists)
  // Detects orders/payments/subscriptions tables and creates a trigger so every
  // successful payment automatically sends a confirmation email.
  const commerceTable = await prisma.table.findFirst({
    where: { projectId, name: { in: COMMERCE_TABLES } },
    select: { id: true, name: true },
  })
  if (commerceTable) {
    const confirmResult = await executeGenerateFunction(
      {
        functionName: 'payment-confirmation-email',
        description: [
          `Payment confirmation email triggered when a row is updated in \`${commerceTable.name}\` with status="paid".`,
          `Use ctx.integrations.${provider}.send() to send the email.`,
          `Look up the "notification" template from email_templates or compose a simple receipt message.`,
          `Include the order/payment ID, amount if available, and a thank-you message.`,
          `Send to the user email associated with the record (look up from workspace users table if needed).`,
          `Insert a row into email_events with status="sent" or "failed" and the provider message_id.`,
          `Only send when the new status is "paid" or "completed" — ignore other status changes.`,
        ].join(' '),
        method: 'POST',
      },
      projectId,
    ).catch(() => ({ success: false }))
    if (confirmResult.success) {
      autoWiredSteps.push(`✅ Payment confirmation email trigger created (${commerceTable.name}.update → ${provider})`)
    }
  }

  // ── Emit events ───────────────────────────────────────────────────────────
  emit('integration.activated', projectId, { integrationId: provider, tables: ['email_events', 'email_templates'] })
  emit('schema.changed', projectId, { tables: ['email_events', 'email_templates'] })

  import('@/lib/versioning/schema-versions').then(({ snapshotSchema }) =>
    snapshotSchema(
      projectId,
      `${providerName} integration: email_events + email_templates + triggers`,
      'email_executor',
    ).catch(() => {})
  )

  // ── Compute final readiness ────────────────────────────────────────────────
  const readinessReport = await checkIntegrationReadiness(projectId, provider)

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
        [provider]: toIntegrationRecord(readinessReport, {
          activatedAt: existingIntegrations[provider]?.activatedAt ?? new Date().toISOString(),
          activatedBy: 'integration_executor',
          tables: ['email_events', 'email_templates'],
        }),
      },
    },
  })

  const stepsMsg = `\n\n**Auto-wired:**\n${autoWiredSteps.join('\n')}`
  const readinessMsg = `\n\n${formatReadinessReport(readinessReport)}`

  return {
    success: true,
    message: `${providerName} connected.${stepsMsg}${readinessMsg}`,
    readiness: readinessReport.status,
  }
}
