/**
 * Move a region's projects from its shared database into databases of their
 * own, a few at a time (lib/data-plane/tenancy-migration.ts has the steps).
 *
 *   npx tsx scripts/migrate-project-databases.ts --region us-east-1 --project <id> [--dry-run]
 *   npx tsx scripts/migrate-project-databases.ts --region us-east-1 --all [--batch 5] [--dry-run]
 *   npx tsx scripts/migrate-project-databases.ts --region us-east-1 --report
 *   npx tsx scripts/migrate-project-databases.ts --region us-east-1 --revoke-public-connect [--grant-connect role1,role2]
 *
 * Each move is a regional job (`tenancy_migration`) that the region's own
 * scheduler runs, where pg_dump and psql reach both databases; this script only
 * asks for them and waits. It enqueues one batch at a time (--batch, 1 unless
 * given), never more than that many moves queued or running in the region at
 * once, and waits for the batch to end before the next. Each project gets one
 * line as its move ends:
 *
 *   <project>  moved
 *   <project>  dry-run ok
 *   <project>  refused <reason>
 *   <project>  aborted <step> <reason>
 *
 * A move pauses its project for a few minutes, so take an instance snapshot of
 * the region's database before a batch, and run --dry-run first: it pauses the
 * project too, copies and verifies everything, and leaves the project exactly
 * as it was. Stopping this script does not stop moves already queued: they run
 * in the region, and --report shows how each ended.
 *
 * --revoke-public-connect is the last step, once every project of the region
 * has a database of its own: CONNECT on the region's own database is taken
 * from PUBLIC, and from any project role that holds it by name, and given by
 * name to the platform's roles and to whatever other login is connected to it,
 * so a project's own login cannot open it at all. Refused while any project of
 * the region is still shared. Run it with the region's admin connection
 * (BACKENLY_ADMIN_DATABASE_URL, with the region appended outside the home
 * region) as the database's owner. On Backenly Cloud, where no service holds
 * that connection, the region's procedure does the same:
 * tools/managed-db/regional/launch.ts close-shared.
 *
 * Needs the platform database (DATABASE_URL). Prints project ids, steps and
 * reasons; never a credential, a row or a channel name.
 */

import { prisma } from '../lib/db/prisma'
import { disconnectRegionalClients } from '../lib/data-plane/regional'
import { CLOUD_REGIONS, type CloudRegionId } from '../lib/regions'
import { REGIONAL_STATUS, TENANCY_MIGRATION_JOB_TYPE } from '../lib/queue'
import {
  MIGRATION_USAGE,
  UsageError,
  describeOutcome,
  parseMigrationArgs,
  type MigrationReport,
} from '../lib/data-plane/tenancy-migration-rules'
import {
  enqueueTenancyMigration,
  migrationsInFlight,
  projectsInRegionWhere,
  revokePublicConnect,
} from '../lib/data-plane/tenancy-migration'

const POLL_MS = 5_000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type JobRow = { id: string; projectId: string | null; status: string; error: string | null; result: unknown; createdAt: Date }

/** One line for a job: how its move ended, or that it is still going. */
function lineFor(job: JobRow): string | null {
  if (job.status === 'completed') {
    const report = job.result as MigrationReport | null
    if (report && typeof report === 'object' && 'outcome' in report) return describeOutcome({ ...report, attention: report.attention ?? [] })
    return 'ended with no report'
  }
  if (job.status === REGIONAL_STATUS.failed) return `aborted ${(job.result as { step?: string } | null)?.step ?? 'unknown'} ${job.error ?? 'the job failed in its region'}`
  return null
}

async function regionJobs(region: CloudRegionId): Promise<JobRow[]> {
  return prisma.backgroundJob.findMany({
    where: { type: TENANCY_MIGRATION_JOB_TYPE, payload: { path: ['region'], equals: region } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, projectId: true, status: true, error: true, result: true, createdAt: true },
  })
}

async function report(region: CloudRegionId): Promise<number> {
  const latest = new Map<string, JobRow>()
  for (const job of await regionJobs(region)) {
    if (job.projectId && !latest.has(job.projectId)) latest.set(job.projectId, job)
  }
  for (const [projectId, job] of latest) {
    const line = lineFor(job) ?? `running (${(job.result as { step?: string } | null)?.step ?? 'queued'})`
    const dry = (job.result as { dryRun?: boolean } | null)?.dryRun ? ' [dry run]' : ''
    console.log(`${projectId}  ${line}${dry}  (${job.createdAt.toISOString()})`)
  }
  const shared = await prisma.project.count({ where: { databaseTenancy: 'shared', ...projectsInRegionWhere(region) } })
  const dedicated = await prisma.project.count({ where: { databaseTenancy: 'dedicated', ...projectsInRegionWhere(region) } })
  console.log(`\n${region}: ${dedicated} project(s) with a database of their own, ${shared} still in the shared database.`)
  return 0
}

async function migrate(region: CloudRegionId, projects: string[] | 'all', batch: number, dryRun: boolean): Promise<number> {
  const targets =
    projects === 'all'
      ? (
          await prisma.project.findMany({
            where: { databaseTenancy: 'shared', deletedAt: null, ...projectsInRegionWhere(region) },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        ).map((p) => p.id)
      : projects
  console.log(`${targets.length} project(s) in ${region}, ${batch} at a time${dryRun ? ', dry run' : ''}.`)

  const counts = new Map<string, number>()
  const tally = (line: string) => {
    const key = line.startsWith('moved') ? 'moved' : line.startsWith('dry-run ok') ? 'dry-run ok' : line.split(' ')[0]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (let start = 0; start < targets.length; start += batch) {
    const slice = targets.slice(start, start + batch)
    // Never more than `batch` moves of the region queued or running, others' included.
    for (;;) {
      const inFlight = await migrationsInFlight(region)
      if (inFlight + slice.length <= batch || inFlight === 0) break
      console.log(`waiting: ${inFlight} move(s) already queued or running in ${region}`)
      await sleep(POLL_MS)
    }

    const waiting = new Map<string, string>() // job id -> project id
    for (const projectId of slice) {
      const open = await prisma.backgroundJob.findFirst({
        where: { type: TENANCY_MIGRATION_JOB_TYPE, projectId, status: { in: [REGIONAL_STATUS.pending, REGIONAL_STATUS.running] } },
        select: { id: true },
      })
      if (open) {
        const line = 'refused migration_running: a move of this project is already queued or running'
        console.log(`${projectId}  ${line}`)
        tally(line)
        continue
      }
      const job = await enqueueTenancyMigration(projectId, region, { dryRun, requestedBy: 'operator' })
      waiting.set(job.id, projectId)
    }

    let lastProgress = Date.now()
    while (waiting.size > 0) {
      await sleep(POLL_MS)
      const jobs = await prisma.backgroundJob.findMany({
        where: { id: { in: [...waiting.keys()] } },
        select: { id: true, projectId: true, status: true, error: true, result: true, createdAt: true },
      })
      for (const job of jobs) {
        const line = lineFor(job)
        if (line === null) continue
        console.log(`${waiting.get(job.id)}  ${line}`)
        tally(line)
        waiting.delete(job.id)
      }
      if (waiting.size > 0 && Date.now() - lastProgress > 60_000) {
        lastProgress = Date.now()
        for (const job of jobs.filter((j) => waiting.has(j.id))) {
          console.log(`  ${waiting.get(job.id)}: ${job.status === REGIONAL_STATUS.pending ? 'queued' : `at ${(job.result as { step?: string } | null)?.step ?? 'start'}`}`)
        }
      }
    }
  }

  console.log(`\n${[...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to do'}.`)
  return [...counts.keys()].some((k) => k === 'aborted' || k.startsWith('moved, needs')) ? 1 : 0
}

async function main(): Promise<number> {
  let command
  try {
    command = parseMigrationArgs(process.argv.slice(2), CLOUD_REGIONS.map((r) => r.id))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${MIGRATION_USAGE}`)
      return 2
    }
    throw err
  }
  const region = command.region as CloudRegionId
  if (command.mode === 'report') return report(region)
  if (command.mode === 'revoke_public_connect') {
    const done = await revokePublicConnect(region, { extraRoles: command.extraRoles })
    console.log(
      `CONNECT on ${done.database} in ${region} taken from PUBLIC and from ${done.closedToProjectRoles.length} project role(s); given to ${done.granted.join(', ')}.`,
    )
    console.log(`To put it back: ${done.reverse}`)
    return 0
  }
  return migrate(region, command.projects, command.batch, command.dryRun)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectRegionalClients().catch(() => {})
    await prisma.$disconnect().catch(() => {})
  })
