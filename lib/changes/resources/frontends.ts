/**
 * The allowed origins in the change history (lib/changes/resources).
 *
 * An active connected origin is an entry on the project's CORS allowlist: a
 * browser app on that origin may call the SDK routes, and the first deployed
 * origin closes the list to every other one (lib/services/connectFrontend.ts).
 * That is a change to who can reach the backend, and it never reached the
 * History: production QA (2026-11-09) added http://localhost:5173 and found no
 * entry for it.
 *
 * An origin a change added is taken off the list by restoring the change, and
 * one a change took off is put back. Its row stays either way, with when it was
 * connected and disconnected, as disconnecting has always left it.
 */
import { prisma } from '@/lib/db/prisma'
import type { ResourceAdapter, ResourceItem, ResourceOp, Tx } from './core'

const KEY = 'origin:'

export const frontendsAdapter: ResourceAdapter = {
  id: 'frontends',

  async capture(projectId) {
    const rows = await prisma.connectedApp.findMany({ where: { projectId, isActive: true } })
    const out: Record<string, ResourceItem> = {}
    for (const r of rows) {
      out[`${KEY}${r.origin}`] = {
        label: `allowed origin ${r.origin}`,
        fields: { origin: r.origin },
        meta: { connectedBy: r.connectedBy, backendVersion: r.backendVersion },
      }
    }
    return out
  },

  // Nothing about an origin is secret or lost: it comes back exactly.
  irreversible() {
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const origin = op.key.slice(KEY.length)
    if (!op.before) {
      // The change added it: take it off the list, keeping its row.
      await tx.connectedApp.updateMany({
        where: { projectId, origin, isActive: true },
        data: { isActive: false, disconnectedAt: new Date() },
      })
      return
    }
    const meta = (op.before.meta ?? {}) as { connectedBy?: string; backendVersion?: number }
    await tx.connectedApp.upsert({
      where: { projectId_origin: { projectId, origin } },
      update: { isActive: true, disconnectedAt: null, connectedAt: new Date() },
      create: {
        projectId,
        origin,
        isActive: true,
        connectedBy: meta.connectedBy ?? 'UI',
        backendVersion: meta.backendVersion ?? 0,
      },
    })
  },
}
