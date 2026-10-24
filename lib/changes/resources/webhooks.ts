/**
 * Webhooks and triggers in the change history (lib/changes/resources).
 *
 * Their targets, events, conditions and switches come back exactly. A signing
 * secret never does: a restore leaves the one in place, and a webhook or
 * trigger a change removed with its secret does not come back, since every
 * receiver verifies against that secret and it was not kept.
 */

import { prisma } from '@/lib/db/prisma'
import { changedSecrets, secretDigest, type Irreversible, type ResourceAdapter, type ResourceItem, type ResourceOp, type Tx } from './core'

export const webhooksAdapter: ResourceAdapter = {
  id: 'webhooks',

  async capture(projectId) {
    const [hooks, triggers] = await Promise.all([
      prisma.webhook.findMany({ where: { projectId } }),
      prisma.appTrigger.findMany({ where: { projectId } }),
    ])
    const out: Record<string, ResourceItem> = {}
    for (const w of hooks) {
      out[`webhook:${w.id}`] = {
        label: `webhook to ${hostOf(w.targetUrl)} (${w.eventType})`,
        fields: { eventType: w.eventType, targetUrl: w.targetUrl, active: w.active },
        secrets: { secret: secretDigest(w.secret) },
      }
    }
    for (const t of triggers) {
      out[`trigger:${t.id}`] = {
        label: `trigger ${t.name}`,
        fields: {
          name: t.name, description: t.description, sourceTable: t.sourceTable, event: t.event, conditions: t.conditions ?? null,
          actionType: t.actionType, targetTable: t.targetTable, fieldMappings: t.fieldMappings ?? null, staticFields: t.staticFields ?? null,
          webhookUrl: t.webhookUrl, enabled: t.enabled,
        },
        ...(t.webhookSecret ? { secrets: { webhookSecret: secretDigest(t.webhookSecret) } } : {}),
      }
    }
    return out
  },

  irreversible(op: ResourceOp): Irreversible | null {
    if (op.before && !op.after && Object.keys(op.before.secrets ?? {}).length > 0) {
      return { reason: `${capital(op.before.label)} was removed with its signing secret, which is not kept, so it does not come back.`, partial: false }
    }
    if (op.before && op.after && changedSecrets(op.before, op.after).length > 0) {
      return { reason: `The signing secret of ${op.after.label} was replaced, and the old one is not kept: the new one stays.`, partial: true }
    }
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const [kind, id] = op.key.split(':') as ['webhook' | 'trigger', string]
    if (!op.before) {
      if (kind === 'webhook') await tx.webhook.deleteMany({ where: { id, projectId } })
      else await tx.appTrigger.deleteMany({ where: { id, projectId } })
      return
    }
    const f = op.before.fields as Record<string, any>
    if (kind === 'webhook') {
      // Only settings: the secret in place stays (a removed one is irreversible).
      await tx.webhook.updateMany({ where: { id, projectId }, data: { eventType: f.eventType, targetUrl: f.targetUrl, active: f.active } })
      return
    }
    const data = {
      name: f.name, description: f.description, sourceTable: f.sourceTable, event: f.event, conditions: f.conditions ?? undefined,
      actionType: f.actionType, targetTable: f.targetTable, fieldMappings: f.fieldMappings ?? undefined, staticFields: f.staticFields ?? undefined,
      webhookUrl: f.webhookUrl, enabled: f.enabled,
    }
    const existing = await tx.appTrigger.findFirst({ where: { id, projectId }, select: { id: true } })
    if (existing) await tx.appTrigger.update({ where: { id }, data })
    else await tx.appTrigger.create({ data: { id, projectId, ...data } })
  },
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
