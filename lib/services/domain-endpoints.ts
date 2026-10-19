/**
 * THE FUNCTIONS BACKENLY GENERATES FOR A TABLE
 * ============================================
 *
 * Creating a table registers, as AiFunction rows, the endpoints that
 * lib/ai/build-runtime/domain-business-logic.ts writes for it: a validation
 * schema for every table, and more for a recognised kind of table (jobs,
 * wallets, subscriptions, users). They are served at /fn/<name> and read the
 * table, so they follow it. GENERATE_API registers them, and a restore or a
 * reapply keeps them in step with the tables it removed or brought back
 * (lib/changes/recovery.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { generateDomainEndpoints, type GeneratedEndpoint } from '@/lib/ai/build-runtime/domain-business-logic'

/** The route GENERATE_API records on each one. A row with any other is not, or no longer, a generated one. */
function routeOf(projectId: string, ep: GeneratedEndpoint): string {
  return `${ep.method} /api/v1/${projectId}/fn/${ep.name}`
}

/**
 * Register the table's generated endpoints. `replace` rewrites the ones that
 * already exist, as GENERATE_API always has; without it only missing ones are
 * added, so nothing someone changed since is overwritten.
 */
export async function registerDomainEndpoints(
  projectId: string,
  tableName: string,
  allTables: string[],
  opts: { replace: boolean },
): Promise<GeneratedEndpoint[]> {
  const endpoints = generateDomainEndpoints(tableName, projectId, allTables)
  for (const ep of endpoints) {
    try {
      const data = {
        description: ep.description,
        generatedCode: ep.code,
        triggerType: 'manual',
        triggerTable: routeOf(projectId, ep),
        status: 'active',
      }
      const existing = await prisma.aiFunction.findFirst({ where: { projectId, name: ep.name }, select: { id: true } })
      if (!existing) await prisma.aiFunction.create({ data: { projectId, name: ep.name, ...data } })
      else if (opts.replace) await prisma.aiFunction.update({ where: { id: existing.id }, data })
    } catch (err: any) {
      console.warn(`[DomainEndpoints] Could not register "${ep.name}":`, err?.message ?? err)
    }
  }
  return endpoints
}

/**
 * Remove the endpoints generated for tables that are gone, and say which.
 *
 * A name a remaining table also generates stays: the auth and admin endpoints
 * belong to every auth table. So does a row that is no longer as GENERATE_API
 * wrote it: code an agent deployed over it (codeOrigin 'agent'), or a
 * different trigger or route. Only what Backenly generated, and nothing is
 * left to serve, is removed.
 */
export async function removeDomainEndpoints(
  projectId: string,
  removed: string[],
  remaining: string[],
): Promise<string[]> {
  if (removed.length === 0) return []
  const allTables = [...new Set([...removed, ...remaining])]
  const stillGenerated = new Set(
    remaining.flatMap((t) => generateDomainEndpoints(t, projectId, allTables).map((ep) => ep.name)),
  )
  const routes = new Map<string, string>()
  for (const t of removed) {
    for (const ep of generateDomainEndpoints(t, projectId, allTables)) {
      if (!stillGenerated.has(ep.name)) routes.set(ep.name, routeOf(projectId, ep))
    }
  }
  if (routes.size === 0) return []

  const rows = await prisma.aiFunction.findMany({
    where: { projectId, name: { in: [...routes.keys()] }, codeOrigin: 'generated', triggerType: 'manual' },
    select: { id: true, name: true, triggerTable: true },
  })
  const generated = rows.filter((r) => r.triggerTable === routes.get(r.name))
  if (generated.length === 0) return []
  await prisma.aiFunction.deleteMany({ where: { id: { in: generated.map((r) => r.id) } } })
  return generated.map((r) => r.name)
}
