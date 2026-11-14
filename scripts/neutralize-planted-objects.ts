/**
 * Switch off code projects planted in their schemas over a direct-access login.
 *
 * A read-write login whose admin allowed schema changes could create functions,
 * triggers, rules, policies and views in its workspace schema. On a database
 * shared by several projects that code runs in the sessions that serve all of
 * them: a trigger fires as the platform's role when the platform writes the
 * table, and the platform's role reaches every project. scripts/setup-direct-
 * access.sql now gives such a login rows only and takes the rest from it
 * (section 5c); this finds what was already planted, in the home database and
 * every region's, and switches it off (lib/security/planted-objects.ts says
 * how it tells a project's code from Backenly's, and what it does):
 *
 *   - triggers disabled (dropped on a view, where they cannot be disabled),
 *     and rules the same;
 *   - EXECUTE on the project's functions and procedures taken from PUBLIC,
 *     from their owner and from every role granted it, so a shared session
 *     that reaches one fails instead of running it; a SECURITY DEFINER one
 *     that runs as a platform role made SECURITY INVOKER.
 *
 * No table, column or row is touched. Policies, views, defaults, constraints,
 * indexes, operators and casts that call such a function are listed: they now
 * fail closed. So is any definition that calls a built-in which runs SQL or
 * changes the session (query_to_xml, pg_notify, set_config...): no privilege
 * can switch that off, and a person reviews it.
 *
 * Each project's own schema changes as one governed change attributed to
 * Backenly, which History never restores (PLANTED_CHANGE_GROUP); its branches
 * and change vaults change as they are, as scripts/force-admin-only-tables.ts
 * does them. Every project with anything switched off gets an audit-log entry
 * (type security) listing it by kind and name, since a REVOKE leaves nothing
 * History reads.
 *
 *   npx tsx scripts/neutralize-planted-objects.ts                         # report, every configured region
 *   npx tsx scripts/neutralize-planted-objects.ts --apply                 # switch it off
 *   npx tsx scripts/neutralize-planted-objects.ts --region us-east-1      # one region (with or without --apply)
 *   npx tsx scripts/neutralize-planted-objects.ts --project <uuid>        # one project
 *
 * Run it with the application's own database connection (each region's
 * DATABASE_URL), in every region, once the release has installed
 * scripts/setup-direct-access.sql there (the home SQL step, and the regional
 * procedure's direct-access step): that hands what a read-write login owned to
 * its project's owner role, which the application role acts as. Where it has
 * not, --apply refuses the region. A database dedicated to one project (a
 * self-hosted deployment) is reported and left alone: its code is that
 * project's own. Safe to run again: it acts only on what is still on.
 *
 * Prints kinds, names and owners, never a definition.
 */

import { CLOUD_REGIONS, type CloudRegionId } from '../lib/regions'
import { disconnectRegionalClients, projectRegion, regionDatabaseUrl, regionPool, regionRawClient } from '../lib/data-plane/regional'
import { prisma } from '../lib/db/prisma'
import { resolveWorkspaceSchema } from '../lib/services/workspace-pool'
import {
  actionsFor,
  findPlanted,
  projectSchemas,
  readDatabaseFacts,
  recordSwitchedOff,
  stillRunning,
  switchOff,
  type Planted,
  type PlantedReport,
} from '../lib/security/planted-objects'

const APPLY = process.argv.includes('--apply')
const argOf = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const regionArg = argOf('--region')
const projectArg = argOf('--project')

/** Lines printed per list; the rest are counted. */
const SHOWN = 40

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  return `${e?.code ? `${e.code} ` : ''}${e?.message ?? String(err)}`
}

function shown<T>(items: T[], line: (item: T) => string, say: (s: string) => void): void {
  for (const item of items.slice(0, SHOWN)) say(line(item))
  if (items.length > SHOWN) say(`  ... and ${items.length - SHOWN} more`)
}

const describe = (p: Planted) => `${p.kind} ${p.schema}: ${p.name} (${p.why})`

/** What the report holds for one project. */
function ofProject(report: PlantedReport, projectId: string): PlantedReport {
  return {
    planted: report.planted.filter((p) => p.projectId === projectId),
    callers: report.callers.filter((c) => c.projectId === projectId),
    review: report.review.filter((r) => r.projectId === projectId),
  }
}

async function neutralizeRegion(region: CloudRegionId): Promise<boolean> {
  const say = (line: string) => console.log(`[${region}] ${line}`)
  const pool = regionPool(region, 'planted-objects', { max: 2 })

  const client = await pool.connect()
  let facts: Awaited<ReturnType<typeof readDatabaseFacts>>
  let schemas: string[]
  let report: PlantedReport
  let live: Awaited<ReturnType<typeof stillRunning>>
  try {
    facts = await readDatabaseFacts(client)
    schemas = await projectSchemas(client, projectArg)
    report = await findPlanted(client, schemas, facts)
    live = await stillRunning(client, report.planted, facts)
  } finally {
    client.release()
  }

  say(
    `${schemas.length} project schema(s); the database is ` +
      (facts.shared === null
        ? 'one whose direct-access helpers predate the shared-database check'
        : facts.shared
          ? 'shared by several projects'
          : 'dedicated to one project') +
      (facts.driftReadable ? '' : '; the drift ledger could not be read, so who made what rests on owners and names'),
  )
  const projects = [...new Set([
    ...report.planted.map((p) => p.projectId),
    ...report.review.map((r) => r.projectId),
  ])].filter((id): id is string => !!id).sort()
  if (projects.length === 0) {
    say('nothing planted found')
    return true
  }

  const isLive = new Set(live.map((l) => l.object))
  for (const projectId of projects) {
    const mine = ofProject(report, projectId)
    const on = mine.planted.filter((p) => isLive.has(p))
    say(`project ${projectId}: ${mine.planted.length} object(s) a project made, ${on.length} still on`)
    shown(on, (p) => `  on: ${describe(p)}`, say)
    shown(mine.planted.filter((p) => !isLive.has(p)), (p) => `  off already: ${describe(p)}`, say)
    shown(mine.callers, (c) => `  calls one of them, so fails closed once it is off: ${c.type} ${c.identity} calls ${c.calls}`, say)
    shown(mine.review, (r) => `  review: ${r.kind} ${r.schema}: ${r.name} calls ${r.builtins.join(', ')}`, say)
  }

  if (!APPLY) return true
  if (facts.shared === false) {
    say('not switched off: this database holds one project, and what its logins made is that project\'s own')
    return true
  }
  if (facts.shared === null || !facts.stripInstalled) {
    say('refused: install scripts/setup-direct-access.sql in this database first; it takes from every read-write login what let it change the schema and hands what it owned to its project\'s owner role')
    return false
  }

  let ok = true
  for (const projectId of projects) {
    const targets = [...new Set(live.filter((l) => l.object.projectId === projectId).map((l) => l.object))]
    if (targets.length === 0) continue
    const actions = actionsFor(targets)
    try {
      // Governed only where the project's record says this region holds it:
      // its History and its change lock are about that database.
      const record = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
      const governed = !!record && (await projectRegion(projectId)) === region
      const mainSchema = governed ? await resolveWorkspaceSchema(projectId) : `workspace_${projectId}`
      const db = regionRawClient(region, projectId)
      const result = await switchOff(projectId, actions, {
        execute: (sql) => db.$executeRawUnsafe(sql),
        governed,
        mainSchema,
      })

      const after = await pool.connect()
      let left: Awaited<ReturnType<typeof stillRunning>>
      try {
        left = await stillRunning(after, targets, facts)
      } finally {
        after.release()
      }
      if (record) await recordSwitchedOff(projectId, ofProject(report, projectId), result)

      say(
        `project ${projectId}: ${result.done.length} of ${actions.length} action(s) done` +
          (result.changeSeq !== null ? `, History #${result.changeSeq}` : governed ? '' : ', no History (no project record for this region)'),
      )
      shown(result.done, (a) => `  ${a.does}: ${describe(a.object)}`, say)
      shown(result.failed, (f) => `  failed: ${describe(f.action.object)}: ${errorText(f.error)}`, say)
      shown(left, (l) => `  still on: ${describe(l.object)}: ${l.what}`, say)
      if (result.failed.length > 0 || left.length > 0) ok = false
    } catch (err) {
      ok = false
      say(`project ${projectId}: failed: ${errorText(err)}`)
    }
  }
  return ok
}

async function main(): Promise<void> {
  const configured = CLOUD_REGIONS.map((region) => region.id).filter((id) => regionDatabaseUrl(id, 'app') !== undefined)
  const regions = regionArg ? configured.filter((id) => id === regionArg) : configured
  if (regions.length === 0) {
    console.error(regionArg ? `No database connection is configured for region ${regionArg}.` : 'No region has a database connection configured.')
    process.exitCode = 1
    return
  }

  let failures = 0
  for (const region of regions) {
    try {
      if (!(await neutralizeRegion(region))) failures += 1
    } catch (err) {
      failures += 1
      console.error(`[${region}] failed: ${errorText(err)}`)
    }
  }

  console.log(
    APPLY
      ? `Done in ${regions.length} region(s)${failures ? `, ${failures} with something still on or failed` : ''}.`
      : `Report only, ${regions.length} region(s). Run with --apply to switch off what is still on.`,
  )
  if (failures > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(errorText(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectRegionalClients().catch(() => {})
    await prisma.$disconnect().catch(() => {})
  })
