/**
 * The allowed addresses in the change history (lib/changes/resources).
 *
 * An allowed address lets a project's direct Postgres logins connect from it:
 * the region's network allowlist admits the union of every project's addresses
 * there (lib/services/direct-access-allowlist.ts). That is a change to who can
 * reach the database, so adding or removing one is an entry in the History, as
 * adding an allowed origin is (./frontends.ts).
 *
 * An address a change added is taken off the list by restoring the change, and
 * one a change took off is put back. Nothing about an address is secret, so it
 * always comes back exactly. The region's allowlist follows once the restore
 * has committed (afterCommitResources in ./index.ts).
 */
import { prisma } from '@/lib/db/prisma'
import type { ResourceAdapter, ResourceItem, ResourceOp, Tx } from './core'

const KEY = 'address:'

export const addressesAdapter: ResourceAdapter = {
  id: 'addresses',

  async capture(projectId) {
    const rows = await prisma.directAccessAddress.findMany({ where: { projectId }, select: { cidr: true, createdAt: true } })
    const out: Record<string, ResourceItem> = {}
    for (const r of rows) {
      out[`${KEY}${r.cidr}`] = {
        label: `allowed address ${r.cidr}`,
        fields: { cidr: r.cidr },
        meta: { createdAt: r.createdAt.toISOString() },
      }
    }
    return out
  },

  irreversible() {
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const cidr = op.key.slice(KEY.length)
    if (!op.before) {
      await tx.directAccessAddress.deleteMany({ where: { projectId, cidr } })
      return
    }
    await tx.directAccessAddress.createMany({ data: [{ projectId, cidr }], skipDuplicates: true })
  },
}
