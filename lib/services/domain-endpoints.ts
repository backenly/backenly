/**
 * THE FUNCTIONS BACKENLY GENERATES FOR A TABLE
 * ============================================
 *
 * Creating a table registers, as AiFunction rows, the endpoints that
 * lib/ai/build-runtime/domain-business-logic.ts writes for a recognised kind
 * of table (jobs, wallets, subscriptions, users). Tables built before
 * 2026-11-11 also got a validation schema endpoint, `<table>-schema`, which is
 * still recognised as generated but no longer registered. They are served at /fn/<name> and read the
 * table, so they follow it. GENERATE_API registers them. A restore that removes
 * the table removes them and keeps them exactly as they were, and only undoing
 * that restore puts them back (lib/changes/recovery.ts).
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { generateDomainEndpoints, type GeneratedEndpoint } from '@/lib/ai/build-runtime/domain-business-logic'

/** The route GENERATE_API records on each one. A row with any other is not, or no longer, a generated one. */
function routeOf(projectId: string, ep: GeneratedEndpoint): string {
  return `${ep.method} /api/v1/${projectId}/fn/${ep.name}`
}

/** What the generator gives the project's tables: each name, with the routes it is registered under. */
export type GeneratedRoutes = Map<string, Set<string>>

/** The endpoints Backenly generates for these tables, as GENERATE_API registers them. */
export function generatedEndpointRoutes(projectId: string, tables: string[]): GeneratedRoutes {
  const routes: GeneratedRoutes = new Map()
  for (const table of tables) {
    for (const ep of generateDomainEndpoints(table, projectId, tables, { includeSchemaEndpoint: true })) {
      const known = routes.get(ep.name) ?? new Set<string>()
      routes.set(ep.name, known.add(routeOf(projectId, ep)))
    }
  }
  return routes
}

/** The same, for the project's tables as registration reads them (the platform's table registry). */
export async function projectGeneratedRoutes(projectId: string): Promise<GeneratedRoutes> {
  const tables = await prisma.table.findMany({ where: { projectId }, select: { name: true } })
  return generatedEndpointRoutes(projectId, tables.map((t) => t.name))
}

/**
 * Whether a function is one Backenly generated for a table: a name and route
 * the generator gives one of the project's tables, the manual trigger
 * GENERATE_API registers, and no code an agent deployed over it (codeOrigin
 * 'agent'). They are part of the table's API, not functions a person or an
 * agent made, so the project's function count leaves them out. Production QA
 * (2026-11-09): the Overview said "Functions 9" for a project with two.
 *
 * The route alone does not tell: a function an agent asks Backenly to write
 * (GENERATE_FUNCTION, lib/ai/function-generator.ts) is stored with the same
 * trigger and the same shape of route.
 */
export function isGeneratedEndpoint(
  fn: { name: string; triggerType: string | null; triggerTable: string | null; codeOrigin?: string | null },
  routes: GeneratedRoutes,
): boolean {
  if (fn.codeOrigin === 'agent' || fn.triggerType !== 'manual' || !fn.triggerTable) return false
  return routes.get(fn.name)?.has(fn.triggerTable) ?? false
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
      // history: a table's generated endpoints follow the table (lib/changes/recovery.ts generatedEndpointsFollow)
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

type AiFunctionRow = Awaited<ReturnType<typeof prisma.aiFunction.findMany>>[number]

/** Writes the rows a removal took, in the removal's own transaction. */
export type RecordRemoved = (rows: RemovedEndpoint[], tx: Prisma.TransactionClient) => Promise<void>

function asRemoved(r: AiFunctionRow): RemovedEndpoint {
  return {
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
  }
}

/**
 * The endpoints generated for tables that are gone, as they are now.
 *
 * A name a remaining table also generates is not among them: the auth and
 * admin endpoints belong to every auth table. Nor is a row that is no longer
 * as GENERATE_API registered it: code an agent deployed over it (codeOrigin
 * 'agent'), or a different trigger or route.
 */
export async function generatedEndpointsOf(projectId: string, removed: string[], remaining: string[]): Promise<AiFunctionRow[]> {
  if (removed.length === 0) return []
  const allTables = [...new Set([...removed, ...remaining])]
  const stillGenerated = new Set(
    remaining.flatMap((t) => generateDomainEndpoints(t, projectId, allTables, { includeSchemaEndpoint: true }).map((ep) => ep.name)),
  )
  const routes = new Map<string, string>()
  for (const t of removed) {
    for (const ep of generateDomainEndpoints(t, projectId, allTables, { includeSchemaEndpoint: true })) {
      if (!stillGenerated.has(ep.name)) routes.set(ep.name, routeOf(projectId, ep))
    }
  }
  if (routes.size === 0) return []
  const rows = await prisma.aiFunction.findMany({
    where: { projectId, name: { in: [...routes.keys()] }, codeOrigin: 'generated', triggerType: 'manual' },
  })
  return rows.filter((r) => r.triggerTable === routes.get(r.name))
}

/**
 * Remove these rows, each only while it is still the code Backenly generated:
 * codeOrigin 'generated', its route, the same code. A row an agent deployed
 * over meanwhile keeps its code; a function's own runs touch only its
 * bookkeeping (runs, last run, last error), which does not count. `record` is
 * handed exactly the rows removed, as they were, in the same transaction: if
 * it cannot be written, nothing is removed.
 */
export async function deleteGeneratedEndpoints(projectId: string, rows: AiFunctionRow[], record?: RecordRemoved): Promise<RemovedEndpoint[]> {
  if (rows.length === 0) return []
  return prisma.$transaction(async (tx) => {
    const taken: RemovedEndpoint[] = []
    for (const r of rows) {
      const still = { id: r.id, projectId, codeOrigin: 'generated', triggerType: 'manual', triggerTable: r.triggerTable, generatedCode: r.generatedCode }
      const now = await tx.aiFunction.findFirst({ where: still })
      if (!now) continue
      // The same condition again, so a deploy committed after that read is not removed either.
      // history: a table's generated endpoints follow the table (lib/changes/recovery.ts generatedEndpointsFollow)
      const { count } = await tx.aiFunction.deleteMany({ where: still })
      if (count > 0) taken.push(asRemoved(now))
    }
    if (taken.length > 0 && record) await record(taken, tx)
    return taken
  })
}

/**
 * Remove the endpoints generated for tables that are gone, and return each row
 * as it was, so undoing the restore can put back exactly those rows: switched
 * off, rewritten or not (generatedEndpointsOf, deleteGeneratedEndpoints).
 */
export async function removeDomainEndpoints(
  projectId: string,
  removed: string[],
  remaining: string[],
  record?: RecordRemoved,
): Promise<RemovedEndpoint[]> {
  return deleteGeneratedEndpoints(projectId, await generatedEndpointsOf(projectId, removed, remaining), record)
}

/**
 * The generated endpoints of a table that was dropped, removed with it, as a
 * restore removes those of a table it takes away. Left behind, each was a
 * callable route over a table that was gone. Inside a change, the change's
 * record keeps each row as it was, so restoring the drop puts back exactly those
 * (lib/changes/recovery.ts generatedEndpointsFollow). Outside one the drop is
 * permanent, and so is this.
 */
export async function removeEndpointsOfDroppedTable(
  projectId: string,
  table: string,
  changeId: string | null,
): Promise<RemovedEndpoint[]> {
  const remaining = (await prisma.table.findMany({ where: { projectId }, select: { name: true } })).map((t) => t.name)
  const record: RecordRemoved | undefined = changeId
    ? async (functions, tx) => {
        await tx.backendChangeEvent.create({
          data: { changeId, projectId, type: 'generated_endpoints_removed', data: { functions } as unknown as Prisma.InputJsonValue },
        })
      }
    : undefined
  return removeDomainEndpoints(projectId, [table], remaining, record)
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
      // history: a table's generated endpoints follow the table (lib/changes/recovery.ts generatedEndpointsFollow)
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
