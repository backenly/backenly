/**
 * Functions and schedules in the change history (lib/changes/resources).
 *
 * A function's code, trigger, schedule and Power switch come back exactly; one
 * a change created is removed, one it deleted comes back under its own id. Its
 * run log is history, not configuration, and is neither compared nor restored;
 * so is `status: 'error'`, which records how the last run went and is not a
 * decision anyone made (lib/services/ai-functions/status.ts).
 *
 * The endpoints Backenly generates for a table are rows here too, but they
 * follow their table when a restore removes or brings it back
 * (lib/changes/recovery.ts generatedEndpointsFollow), so they are left out.
 */

import { prisma } from '@/lib/db/prisma'
import { isFunctionSwitchedOff } from '@/lib/services/ai-functions/status'
import { isDomainEndpointName } from '@/lib/ai/build-runtime/domain-business-logic'
import type { ResourceAdapter, ResourceItem, ResourceOp, Tx } from './core'

const GENERATED_ROUTE = /^[A-Z]+ \/api\/v1\/[^/]+\/fn\/([^/\s]+)$/

/**
 * A table's generated endpoint (lib/services/domain-endpoints.ts
 * registerDomainEndpoints): on its own route, under a name only a table
 * generates. A function a model generated on request (GENERATE_FUNCTION) has
 * the same origin and the same kind of route, and is in the history like any
 * other.
 */
export function isGeneratedEndpoint(f: { name: string; codeOrigin: string; triggerType: string; triggerTable: string | null }): boolean {
  if (f.codeOrigin !== 'generated' || f.triggerType !== 'manual') return false
  const route = GENERATED_ROUTE.exec(f.triggerTable ?? '')
  return !!route && route[1] === f.name && isDomainEndpointName(f.name)
}

export const functionsAdapter: ResourceAdapter = {
  id: 'functions',

  async capture(projectId) {
    const rows = await prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, description: true, generatedCode: true, codeOrigin: true, triggerType: true, triggerTable: true, status: true },
    })
    const out: Record<string, ResourceItem> = {}
    for (const f of rows) {
      if (isGeneratedEndpoint(f)) continue
      out[`function:${f.id}`] = {
        label: `${f.triggerType === 'cron' ? 'schedule' : 'function'} ${f.name}`,
        fields: {
          name: f.name,
          description: f.description,
          generatedCode: f.generatedCode,
          codeOrigin: f.codeOrigin,
          triggerType: f.triggerType,
          triggerTable: f.triggerTable,
          power: isFunctionSwitchedOff(f.status) ? 'off' : 'on',
        },
      }
    }
    return out
  },

  irreversible() {
    return null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const id = op.key.slice('function:'.length)
    if (!op.before) {
      await tx.aiFunction.deleteMany({ where: { id, projectId } })
      return
    }
    const f = op.before.fields as {
      name: string; description: string; generatedCode: string; codeOrigin: string; triggerType: string; triggerTable: string | null; power: 'on' | 'off'
    }
    const data = {
      name: f.name, description: f.description, generatedCode: f.generatedCode, codeOrigin: f.codeOrigin,
      triggerType: f.triggerType, triggerTable: f.triggerTable,
    }
    const existing = await tx.aiFunction.findFirst({ where: { id, projectId }, select: { status: true } })
    // On keeps how the last run went, unless the function was off.
    const status = f.power === 'off' ? 'inactive' : existing && !isFunctionSwitchedOff(existing.status) ? existing.status : 'active'
    if (existing) await tx.aiFunction.update({ where: { id }, data: { ...data, status } })
    else await tx.aiFunction.create({ data: { id, projectId, ...data, status } })
  },
}
