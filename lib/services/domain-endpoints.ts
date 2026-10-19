/**
 * THE FUNCTIONS BACKENLY GENERATES FOR A TABLE
 * ============================================
 *
 * Creating a table registers, as AiFunction rows, the endpoints that
 * lib/ai/build-runtime/domain-business-logic.ts writes for it: a validation
 * schema for every table, and more for a recognised kind of table (jobs,
 * wallets, subscriptions, users). They are served at /fn/<name> and read the
 * table, so they follow it. GENERATE_API registers them. A restore that removes
 * the table removes them and keeps them exactly as they were, and only undoing
 * that restore puts them back (lib/changes/recovery.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { generateDomainEndpoints, type GeneratedEndpoint } from '@/lib/ai/build-runtime/domain-business-logic'

/** The route GENERATE_API records on each one. A row with any other is not, or no longer, a generated one. */
function routeOf(projectId: string, ep: GeneratedEndpoint): string {
  return `${ep.method} /api/v1/${projectId}/fn/${ep.name}`
}

/** Register the table's generated endpoints, rewriting the ones that exist, as GENERATE_API always has. */
export async function registerDomainEndpoints(
  projectId: string,
  tableName: string,
  allTables: string[],
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
      if (existing) await prisma.aiFunction.update({ where: { id: existing.id }, data })
      else await prisma.aiFunction.create({ data: { projectId, name: ep.name, ...data } })
    } catch (err: any) {
      console.warn(`[DomainEndpoints] Could not register "${ep.name}":`, err?.message ?? err)
    }
  }
  return endpoints
}

/** A generated endpoint as it was when a restore removed it, enough to put back exactly that row. */
export interface RemovedEndpoint {
  id: string
  name: string
  description: string
  generatedCode: string
  codeOrigin: string
  triggerType: string
  triggerTable: string | null
  status: string
  lastRun: string | null
  lastError: string | null
  runCount: number
  createdAt: string
}

/**
 * Remove the endpoints generated for tables that are gone, and return each row
 * as it was, so undoing the restore can put back exactly those rows: switched
 * off, rewritten or not. `keep` is handed the rows before anything is removed,
 * and if it throws nothing is.
 *
 * A name a remaining table also generates stays: the auth and admin endpoints
 * belong to every auth table. So does a row that is no longer as GENERATE_API
 * registered it: code an agent deployed over it (codeOrigin 'agent'), or a
 * different trigger or route.
 */
export async function removeDomainEndpoints(
  projectId: string,
  removed: string[],
  remaining: string[],
  keep?: (rows: RemovedEndpoint[]) => Promise<void>,
): Promise<RemovedEndpoint[]> {
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
  })
  const generated = rows.filter((r) => r.triggerTable === routes.get(r.name))
  if (generated.length === 0) return []
  const kept: RemovedEndpoint[] = generated.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    generatedCode: r.generatedCode,
    codeOrigin: r.codeOrigin,
    triggerType: r.triggerType,
    triggerTable: r.triggerTable,
    status: r.status,
    lastRun: r.lastRun?.toISOString() ?? null,
    lastError: r.lastError,
    runCount: r.runCount,
    createdAt: r.createdAt.toISOString(),
  }))
  if (keep) await keep(kept)
  await prisma.aiFunction.deleteMany({ where: { id: { in: generated.map((r) => r.id) } } })
  return kept
}

/**
 * Put back endpoints a restore removed, exactly as it kept them. A name that
 * is in use again (someone made a function of that name since) is left alone.
 * Returns the names put back.
 */
export async function restoreDomainEndpoints(projectId: string, rows: RemovedEndpoint[]): Promise<string[]> {
  const back: string[] = []
  for (const r of rows) {
    try {
      if (await prisma.aiFunction.findFirst({ where: { projectId, name: r.name }, select: { id: true } })) continue
      const taken = await prisma.aiFunction.findUnique({ where: { id: r.id }, select: { id: true } })
      await prisma.aiFunction.create({
        data: {
          ...(taken ? {} : { id: r.id }),
          projectId,
          name: r.name,
          description: r.description,
          generatedCode: r.generatedCode,
          codeOrigin: r.codeOrigin,
          triggerType: r.triggerType,
          triggerTable: r.triggerTable,
          status: r.status,
          lastRun: r.lastRun ? new Date(r.lastRun) : null,
          lastError: r.lastError,
          runCount: r.runCount,
          createdAt: new Date(r.createdAt),
        },
      })
      back.push(r.name)
    } catch (err: any) {
      console.warn(`[DomainEndpoints] Could not put back "${r.name}":`, err?.message ?? err)
    }
  }
  return back
}
