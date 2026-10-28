/**
 * Environment variables in the change history (lib/changes/resources).
 *
 * A variable's value is a secret, so it is never kept: a restore removes a
 * variable a change added, and puts a description back, but a value a change
 * set or a variable it removed stays as the change left it, and says so.
 */

import { prisma } from '@/lib/db/prisma'
import { changedSecrets, encryptedVersion, type Irreversible, type ResourceAdapter, type ResourceItem, type ResourceOp, type Tx } from './core'

export const envAdapter: ResourceAdapter = {
  id: 'env',

  async capture(projectId) {
    const rows = await prisma.projectEnvVar.findMany({ where: { projectId } })
    const out: Record<string, ResourceItem> = {}
    for (const v of rows) {
      out[`env:${v.key}`] = {
        label: `environment variable ${v.key}`,
        fields: { key: v.key, description: v.description },
        secrets: { value: encryptedVersion(v.valueIv) },
      }
    }
    return out
  },

  irreversible(op: ResourceOp): Irreversible | null {
    if (op.before && !op.after) {
      return { reason: `${capital(op.before.label)} was removed, and its value is not kept, so it does not come back.`, partial: false }
    }
    if (op.before && op.after && changedSecrets(op.before, op.after).length > 0) {
      return { reason: `The value of ${op.after.label} was replaced, and the earlier value is not kept: the new one stays.`, partial: true }
    }
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const key = op.key.slice('env:'.length)
    if (!op.before) {
      await tx.projectEnvVar.deleteMany({ where: { projectId, key } })
      return
    }
    await tx.projectEnvVar.updateMany({ where: { projectId, key }, data: { description: (op.before.fields.description as string | null) ?? null } })
  },
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
