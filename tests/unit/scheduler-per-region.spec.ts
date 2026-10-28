/**
 * ONE SCHEDULER PER REGION, AND THE PLATFORM'S OWN WORK ONCE
 * =========================================================
 * Every region's processes take their scheduler lock on the one platform
 * database they share (lib/scheduler/leader.ts), so each region needs a key of
 * its own: with one key for all of them, a Virginia worker that won it stopped
 * Mumbai's jobs. And with a leader in every region, any job that is not about a
 * region's own projects (the usage close, alerts, back office) would run once
 * per region: the usage close would bill twice. instrumentation.ts therefore
 * declares those with cron.platform, which schedules only in the home region.
 *
 * These hold the classification to the code, so a new billing job cannot be
 * added with cron.schedule and quietly run in every region.
 */

import fs from 'fs'
import path from 'path'

import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { SCHEDULER_LOCK_KEY, schedulerLockKey } from '@/lib/scheduler/leader'

describe('the scheduler lock', () => {
  it('keeps the home region on the key every earlier build took, so a rolling deploy has one leader', () => {
    expect(SCHEDULER_LOCK_KEY).toEqual([0x424b4e53, 1])
    expect(schedulerLockKey(HOME_REGION)).toEqual([0x424b4e53, 1])
  })

  it('gives every region a key of its own', () => {
    const keys = CLOUD_REGIONS.map((region) => schedulerLockKey(region.id).join(':'))
    expect(new Set(keys).size).toBe(CLOUD_REGIONS.length)
  })

  it('has no key for a region this build does not know', () => {
    expect(() => schedulerLockKey('mars-north-1' as CloudRegionId)).toThrow(/no scheduler lock slot/)
  })
})

describe('instrumentation.ts', () => {
  // Line comments first: one mentions /api/cron/*, which would otherwise open a
  // "block comment" that ends inside a '*/10 * * * *' expression.
  const code = fs
    .readFileSync(path.join(process.cwd(), 'instrumentation.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /** The code of every job of one kind: from its call to the next job, or the end of the schedule. */
  function jobs(kind: 'schedule' | 'platform'): string[] {
    const starts = [...code.matchAll(/cron\.(schedule|platform)\(/g)].map((m) => ({ index: m.index ?? 0, kind: m[1] }))
    const end = code.indexOf('[CronScheduler] Started')
    expect(starts.length).toBeGreaterThan(20)
    expect(end).toBeGreaterThan(0)
    return starts
      .map((start, i) => ({ kind: start.kind, text: code.slice(start.index, starts[i + 1]?.index ?? end) }))
      .filter((job) => job.kind === kind)
      .map((job) => job.text)
  }

  // The platform's own work: billing, usage, back office, and rows in the
  // platform database any project may own.
  const PLATFORM = [
    'runPlatformSystemTasks',
    'cleanupAllProjectGraphs',
    'runScheduledBackOfficeMaintenance',
    'pruneBaseline',
    'evaluateUsageAnomalies',
    'evaluateUsageAlerts',
    'closePreviousPeriod',
    'pruneAppliedBatches',
  ]

  // A region's own projects, seen through the fleet scheduler or skipUnreachable,
  // both of which keep to the projects this process serves.
  const REGIONAL = [
    'runDueCronJobs',
    'runRegionalSystemTasks',
    'diagnoseEscalatedFindings',
    'checkSensorHealth',
    'runDailyBackups',
    'runWorkspaceObserver',
    'runContractSweep',
    'runMonitoredHealthScan',
    'runAndStoreInfraIntelligence',
    'runAndStoreArchitectureEvolution',
    'runAndStoreFrontendCoevolution',
    'runReconciler',
    'sweepProjectMaintenance',
    'sweepArchitecture',
    'collectBaseline',
    'runDriftEventUpkeep',
    'snapshotScheduledDbStorage',
    'ingestConfiguredLogs',
    'reconcileScheduledFileStorage',
  ]

  it('schedules the platform’s work with cron.platform, in the home region only', () => {
    const platform = jobs('platform').join('\n')
    expect(PLATFORM.filter((fn) => !platform.includes(fn))).toEqual([])
    expect(code).toMatch(/platform: \([\s\S]*?\) => \(home \? nodeCron\.schedule\(/)
  })

  it('never schedules the platform’s work in every region', () => {
    const regional = jobs('schedule').join('\n')
    expect(PLATFORM.filter((fn) => regional.includes(fn))).toEqual([])
  })

  it('schedules every per-project pass in every region, and none of them only at home', () => {
    const regional = jobs('schedule').join('\n')
    const platform = jobs('platform').join('\n')
    expect(REGIONAL.filter((fn) => !regional.includes(fn))).toEqual([])
    expect(REGIONAL.filter((fn) => platform.includes(fn))).toEqual([])
  })

  it('starts the leadership of the region this process serves, and none when that is unknown', () => {
    expect(code).toMatch(/region = serviceRegion\(\)\s+startSchedulerLeadership\(\{ region \}\)/)
    expect(code).toMatch(/catch \(err\) \{\s+console\.error\(`\[CronScheduler\] NOT scheduling/)
  })
})

describe('runRegionalSystemTasks', () => {
  // The share every region's scheduler runs for its own projects. Settling
  // interrupted governed changes and dropping expired vaults used to run only
  // from a Vercel cron route, which nothing on AWS calls.
  const runner = fs
    .readFileSync(path.join(process.cwd(), 'lib/services/cron-runner.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const start = runner.indexOf('export async function runRegionalSystemTasks(')
  const body = runner.slice(start, runner.indexOf('\n}\n', start))

  it('settles this region\'s interrupted governed changes and drops its expired change vaults', () => {
    expect(start).toBeGreaterThan(0)
    expect(body).toContain('settleInterruptedChangesHere(now)')
    expect(body).toContain('purgeExpiredVaultsHere(now)')
  })
})
