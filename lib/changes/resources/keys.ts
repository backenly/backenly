/**
 * API keys in the change history (lib/changes/resources).
 *
 * A key a change created is revoked by restoring it. A revoked or rotated key
 * never comes back: a credential that was taken out of use stays out of use,
 * whoever asks. A key's permissions, limits and expiry come back exactly. A key
 * revoked here reaches every region the way any revocation does (the triggers
 * on api_keys, lib/auth-projection).
 *
 * Two kinds of key are not the history's: the project's public anon key, which
 * is one with Project.anonKey and is provisioned with the project, and a
 * preview branch's keys, which end with their branch (lib/branches/preview.ts).
 */

import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { changedSecrets, secretDigest, type Irreversible, type ResourceAdapter, type ResourceItem, type ResourceOp, type Tx } from './core'

export const keysAdapter: ResourceAdapter = {
  id: 'keys',

  async capture(projectId) {
    const [rows, project] = await Promise.all([
      prisma.apiKey.findMany({ where: { projectId, branchId: null } }),
      prisma.project.findUnique({ where: { id: projectId }, select: { anonKey: true } }),
    ])
    const anonHash = project?.anonKey ? createHash('sha256').update(project.anonKey).digest('hex') : null
    const out: Record<string, ResourceItem> = {}
    for (const k of rows) {
      if (k.keyHash === anonHash) continue
      out[`apikey:${k.id}`] = {
        label: `API key ${k.name}`,
        fields: {
          name: k.name, role: k.role, permissions: [...k.permissions].sort(), capabilities: [...k.capabilities].sort(),
          keyType: k.keyType, serviceRole: k.serviceRole, scope: k.scope, mcpReadOnly: k.mcpReadOnly,
          rateLimit: k.rateLimit, rateLimitWindow: k.rateLimitWindow, expiresAt: k.expiresAt?.toISOString() ?? null,
        },
        secrets: { key: secretDigest(k.keyHash, k.keyPrefix) },
      }
    }
    return out
  },

  irreversible(op: ResourceOp): Irreversible | null {
    if (op.before && !op.after) {
      return { reason: `${capital(op.before.label)} was revoked, and a revoked key never comes back: create a new one instead.`, partial: false }
    }
    if (op.before && op.after && changedSecrets(op.before, op.after).length > 0) {
      return { reason: `${capital(op.after.label)} was rotated, and its old secret never comes back: the new one stays.`, partial: true }
    }
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const id = op.key.slice('apikey:'.length)
    if (!op.before) {
      await tx.apiKey.deleteMany({ where: { id, projectId } })
      return
    }
    const f = op.before.fields as Record<string, any>
    await tx.apiKey.updateMany({
      where: { id, projectId },
      data: {
        name: f.name, role: f.role, permissions: f.permissions, capabilities: f.capabilities, keyType: f.keyType,
        serviceRole: f.serviceRole, scope: f.scope, mcpReadOnly: f.mcpReadOnly, rateLimit: f.rateLimit,
        rateLimitWindow: f.rateLimitWindow, expiresAt: f.expiresAt ? new Date(f.expiresAt) : null,
      },
    })
  },
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
