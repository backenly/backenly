/**
 * PUSH NOTIFICATIONS INTEGRATION (OneSignal)
 * ==========================================
 * Activates OneSignal for a project.
 *
 * What it does:
 *   1. Stores OneSignal REST API Key under integrationId='onesignal' and the
 *      App ID under integrationId='onesignal_app_id'. Two stored credentials
 *      keep the existing single-string vault working without JSON tricks.
 *   2. Creates two workspace tables:
 *        device_tokens       — id, user_id, player_id, platform, registered_at
 *        push_notifications  — id, user_id, title, body, status, onesignal_id, sent_at
 *   3. Generates a `register-device` function so apps can POST a OneSignal
 *      player id after the OneSignal SDK initialises on a phone / browser.
 *   4. Records readiness on project.activeIntegrations.
 *
 * Sending: the SEND_PUSH executor action calls OneSignal directly using the
 * stored credentials. Generated functions and triggers can also send pushes
 * via that action without writing platform-specific code.
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { storeIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { executeGenerateFunction } from '@/lib/ai/function-generator'

export interface PushIntegrationResult {
  success: boolean
  message: string
  needsCredentials?: boolean
  credentialHint?: string
}

export async function executePushIntegration(
  projectId: string,
  appId?: string,
  restApiKey?: string,
): Promise<PushIntegrationResult> {
  const haveKey = await hasIntegrationKey(projectId, 'onesignal')
  const haveAppId = await hasIntegrationKey(projectId, 'onesignal_app_id')

  if ((!haveKey || !haveAppId) && (!appId || !restApiKey)) {
    return {
      success: false,
      needsCredentials: true,
      message:
        `OneSignal needs both your **App ID** and **REST API Key**. ` +
        `Find them in onesignal.com → Settings → Keys & IDs → "OneSignal App ID" and "REST API Key".`,
      credentialHint: 'OneSignal App ID + REST API Key',
    }
  }

  if (appId) {
    await storeIntegrationKey(projectId, 'onesignal_app_id', appId)
  }
  if (restApiKey) {
    await storeIntegrationKey(projectId, 'onesignal', restApiKey)
  }

  const autoWired: string[] = ['✅ OneSignal credentials stored (App ID + REST API Key)']

  // device_tokens — maps end-user accounts to OneSignal player ids.
  const tokensTbl = await executeAction({
    action: 'CREATE_TABLE',
    params: {
      tableName: 'device_tokens',
      columns: [
        { name: 'user_id', type: 'UUID', notNull: true },
        { name: 'player_id', type: 'TEXT', notNull: true, unique: true },
        { name: 'platform', type: 'TEXT' }, // 'ios' | 'android' | 'web'
        { name: 'registered_at', type: 'TIMESTAMP', default: 'NOW()' },
      ],
    },
  }, projectId)
  if (tokensTbl.success) autoWired.push('✅ `device_tokens` table created')

  // push_notifications — delivery log.
  const logTbl = await executeAction({
    action: 'CREATE_TABLE',
    params: {
      tableName: 'push_notifications',
      columns: [
        { name: 'user_id', type: 'UUID' },
        { name: 'title', type: 'TEXT' },
        { name: 'body', type: 'TEXT', notNull: true },
        { name: 'status', type: 'TEXT', notNull: true, default: 'sent' },
        { name: 'onesignal_id', type: 'TEXT' },
        { name: 'sent_at', type: 'TIMESTAMP', default: 'NOW()' },
      ],
    },
  }, projectId)
  if (logTbl.success) autoWired.push('✅ `push_notifications` table created (delivery log)')

  // Generate REST APIs for both tables.
  await executeAction({ action: 'GENERATE_API', params: { tableName: 'device_tokens' } }, projectId).catch(() => {})
  await executeAction({ action: 'GENERATE_API', params: { tableName: 'push_notifications' } }, projectId).catch(() => {})

  // Generate the `register-device` helper function so mobile apps can hand
  // their OneSignal player id back to the backend.
  const regFn = await executeGenerateFunction(
    {
      functionName: 'register-device',
      description: [
        'Register a device for push notifications. Accept { player_id, platform } in the request body.',
        'Use event.user.id as the user_id. Upsert into device_tokens by player_id so re-registering the same device just refreshes platform / user mapping.',
        'Return { ok: true, player_id }. Require authentication.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if ((regFn as any).success) {
    autoWired.push('✅ Generated `POST /fn/register-device` (mobile apps call this after OneSignal SDK init)')
  }

  // Persist active-integrations state.
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const existing = (proj?.activeIntegrations as Record<string, any>) ?? {}
  await prisma.project.update({
    where: { id: projectId },
    data: {
      activeIntegrations: {
        ...existing,
        onesignal: {
          enabled: true,
          readiness: 'behaviorally_ready',
          activatedAt: existing.onesignal?.activatedAt ?? new Date().toISOString(),
          activatedBy: 'push_executor',
          tables: ['device_tokens', 'push_notifications'],
        },
      },
    },
  })

  return {
    success: true,
    message:
      `OneSignal push is wired up.\n\n` +
      `**Auto-wired:**\n${autoWired.join('\n')}\n\n` +
      `**How to send a push from chat:** "send a push to user_id=… with title 'Hi' and body 'You have new messages'".\n` +
      `**Broadcast to everyone:** "send a broadcast push: '<your message>'".\n\n` +
      `Your mobile app needs the OneSignal SDK to obtain a player_id, then POST it to \`/fn/register-device\`.`,
  }
}
