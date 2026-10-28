/**
 * Integrations in the change history (lib/changes/resources).
 *
 * An integration's key is a credential and is never kept: a key a change
 * stored is removed by restoring it, and a key it replaced or removed stays as
 * the change left it. Whether an integration is switched on comes back exactly
 * (Project.activeIntegrations), except one switched off with its key, which
 * stays off with it; its readiness is recomputed by its own checks and is not
 * compared, or every later check would read as a conflict.
 *
 * The `<provider>_auth` markers in the same table belong to sign-in providers
 * (lib/changes/resources/auth.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { changedSecrets, secretDigest, type Irreversible, type ResourceAdapter, type ResourceItem, type ResourceOp, type Tx } from './core'

export const isAuthMarker = (integrationId: string) => integrationId.endsWith('_auth')

export const integrationsAdapter: ResourceAdapter = {
  id: 'integrations',

  async capture(projectId) {
    const [keys, project] = await Promise.all([
      prisma.projectIntegrationKey.findMany({ where: { projectId } }),
      prisma.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } }),
    ])
    const out: Record<string, ResourceItem> = {}
    for (const k of keys) {
      if (isAuthMarker(k.integrationId)) continue
      out[`integration:${k.integrationId}`] = {
        label: `${k.integrationId} key`,
        fields: { integrationId: k.integrationId },
        secrets: { key: secretDigest(k.encryptedKey) },
      }
    }
    const active = (project?.activeIntegrations as Record<string, any> | null) ?? {}
    for (const [id, entry] of Object.entries(active)) {
      if (!entry || typeof entry !== 'object') continue
      out[`active:${id}`] = {
        label: `the ${id} integration`,
        fields: { enabled: entry.enabled === true },
        meta: { entry },
      }
    }
    return out
  },

  irreversible(op: ResourceOp, all: ResourceOp[]): Irreversible | null {
    if (op.key.startsWith('active:')) {
      // Switched on again, it would read as connected with no key behind it.
      const id = op.key.slice('active:'.length)
      const key = all.find((o) => o.key === `integration:${id}`)
      if (op.before?.fields.enabled && key?.before && !key.after) {
        return { reason: `The ${id} integration was switched off with its key, which does not come back: connect it again.`, partial: false }
      }
      return null
    }
    if (op.before && !op.after) {
      return { reason: `The ${op.before.label} was removed, and keys are not kept, so it does not come back: connect it again.`, partial: false }
    }
    if (op.before && op.after && changedSecrets(op.before, op.after).length > 0) {
      return { reason: `The ${op.after.label} was replaced, and the earlier key is not kept: the new one stays.`, partial: false }
    }
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    if (op.key.startsWith('integration:')) {
      // Only a key the change stored reaches here: it is removed.
      if (!op.before) await tx.projectIntegrationKey.deleteMany({ where: { projectId, integrationId: op.key.slice('integration:'.length) } })
      return
    }
    const id = op.key.slice('active:'.length)
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } })
    const active = { ...((project?.activeIntegrations as Record<string, any> | null) ?? {}) }
    if (op.before) active[id] = op.before.meta?.entry ?? { enabled: op.before.fields.enabled }
    else delete active[id]
    await tx.project.update({ where: { id: projectId }, data: { activeIntegrations: active } })
  },
}
