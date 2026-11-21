/**
 * The allowed addresses in the change history (lib/changes/resources).
 *
 * RETIRED AS A FEATURE. A project's direct Postgres logins used to connect
 * through a regional endpoint that admitted only the addresses its projects
 * allowed, and adding or removing one was an entry in the History. Direct
 * connections now go through the connection pooler (lib/data-plane/pooler.ts),
 * which keeps no address list, so nothing adds an address any more and
 * nothing reads the list. This adapter stays so that a History entry made
 * while the feature existed can still be restored: restoring one puts the
 * project's own list back as it was, and changes nothing else.
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
