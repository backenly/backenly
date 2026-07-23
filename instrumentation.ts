/**
 * Next.js instrumentation hook — runs once per server startup.
 * Registers Sentry for Node.js (server) and Edge runtimes.
 * Also starts the cron scheduler for self-hosted deployments (Hetzner/PM2)
 * where Vercel Cron is unavailable.
 *
 * Every minute the scheduler runs two things in parallel:
 *   1. runDueCronJobs()  — user-defined AiFunction cron jobs
 *   2. runSystemTasks()  — platform housekeeping:
 *        • retry failed outbound webhooks
 *        • detect and fail stuck background jobs
 *        • process the background job queue
 *        • auto-provision daily log-cleanup jobs
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')

    // Start the in-process cron scheduler.
    // On Vercel this is a no-op (VERCEL env is set); Vercel Cron calls
    // /api/cron/run-ai-jobs instead.  On self-hosted (Hetzner/PM2) this
    // is the only scheduler, so it must run here.
    if (!process.env.VERCEL) {
      const { default: cron } = await import('node-cron')
      const { runDueCronJobs, runSystemTasks } = await import('./lib/services/cron-runner')

      // Mark cron scheduler as alive in process memory (for health checks)
      ;(globalThis as any).__cronSchedulerStartedAt = new Date().toISOString()

      cron.schedule('* * * * *', async () => {
        // Run user jobs and system tasks in parallel — independent failure domains
        await Promise.allSettled([
          runDueCronJobs().catch((err: any) =>
            console.error('[CronScheduler] User cron error:', err?.message)
          ),
          runSystemTasks().catch((err: any) =>
            console.error('[CronScheduler] System tasks error:', err?.message)
          ),
        ])
      })

      // Daily backup at 02:05 UTC (staggered from cleanup at 02:00)
      cron.schedule('5 2 * * *', async () => {
        const { runDailyBackups } = await import('./lib/services/workspace-backup')
        await runDailyBackups().catch((err: any) =>
          console.error('[DailyBackup] Error:', err?.message)
        )
      })

      // Workspace observer once daily — 00:10 UTC
      cron.schedule('10 0 * * *', async () => {
        const { runWorkspaceObserver } = await import('./lib/services/workspace-observer')
        await runWorkspaceObserver().catch((err: any) =>
          console.error('[WorkspaceObserver] Cron error:', err?.message)
        )
      })

      // Live API contract probes every 15 minutes. Deliberately separate from
      // the daily observer above: five HTTP calls per project (~1s) versus
      // minutes of LLM-backed analysis. This is the detector that answers "is
      // this backend answering its users right now?", so it runs on a cadence
      // that bounds an outage to minutes instead of a day.
      cron.schedule('*/15 * * * *', async () => {
        const { runContractSweep } = await import('./lib/services/workspace-observer')
        await runContractSweep().catch((err: any) =>
          console.error('[ContractSweep] Cron error:', err?.message)
        )
      })

      // Autonomous background health scan once daily — 01:00 UTC
      cron.schedule('0 1 * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { runMonitoredHealthScan } = await import('./lib/ai/background-monitor')

        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')
        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(7),
          select: { id: true, userId: true },
        }).catch(() => [])

        const CONCURRENCY = 10
        for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
          const batch = activeProjects.slice(i, i + CONCURRENCY)
          await Promise.allSettled(
            batch.map(p => runMonitoredHealthScan(p.id, p.userId ?? '').catch((err: any) =>
              console.error(`[BackgroundHealth] project=${p.id} error:`, err?.message)
            ))
          )
        }
        console.log(`[BackgroundHealth] Cron run complete — ${activeProjects.length} projects scanned`)
      })

      // ── Phase 6: Infra Intelligence — once daily ────────────────────────────
      // Queries pg_stat_* views (not user data). Detects hot tables, index
      // fragmentation, partitioning candidates, connection saturation.
      // Auto-applies safe index additions; queues structural changes for approval.
      cron.schedule('30 2 * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { runAndStoreInfraIntelligence } = await import('./lib/ai/infra-intelligence')

        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')
        const loadedProjects = await prisma.project.findMany({
          where: activeProjectsWhere(),
          select: { id: true, userId: true },
        }).catch(() => [])

        const CONCURRENCY = 5
        for (let i = 0; i < loadedProjects.length; i += CONCURRENCY) {
          const batch = loadedProjects.slice(i, i + CONCURRENCY)
          await Promise.allSettled(
            batch.map(p => runAndStoreInfraIntelligence(p.id, p.userId ?? '').catch((err: any) =>
              console.error(`[InfraIntelligence] project=${p.id} error:`, err?.message)
            ))
          )
        }
        console.log(`[InfraIntelligence] Cron run complete — ${loadedProjects.length} projects scanned`)
      })

      // ── Phase 6: Architecture Evolution — every 24 hours ───────────────────
      // Detects project stage (MVP→Growth→Scale→Enterprise), plans migration
      // steps, identifies service extraction candidates and tech debt.
      cron.schedule('20 3 * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { runAndStoreArchitectureEvolution } = await import('./lib/ai/architecture-evolution')

        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')
        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(),
          select: { id: true, userId: true },
        }).catch(() => [])

        const CONCURRENCY = 5
        for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
          const batch = activeProjects.slice(i, i + CONCURRENCY)
          await Promise.allSettled(
            batch.map(p => runAndStoreArchitectureEvolution(p.id, p.userId ?? '').catch((err: any) =>
              console.error(`[ArchEvolution] project=${p.id} error:`, err?.message)
            ))
          )
        }
        console.log(`[ArchEvolution] Cron run complete — ${activeProjects.length} projects evaluated`)
      })

      // ── Phase 6: Frontend-Backend Coevolution — once daily ──────────────────
      // Analyses AuditLog API call patterns + SDK telemetry.
      // Auto-adds missing indexes; queues schema changes for approval.
      cron.schedule('0 4 * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { runAndStoreFrontendCoevolution } = await import('./lib/ai/frontend-coevolution')

        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')
        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(7),
          select: { id: true, userId: true },
        }).catch(() => [])

        const CONCURRENCY = 5
        for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
          const batch = activeProjects.slice(i, i + CONCURRENCY)
          await Promise.allSettled(
            batch.map(p => runAndStoreFrontendCoevolution(p.id, p.userId ?? '').catch((err: any) =>
              console.error(`[Coevolution] project=${p.id} error:`, err?.message)
            ))
          )
        }
        console.log(`[Coevolution] Cron run complete — ${activeProjects.length} projects analysed`)
      })

      // ── Autonomy reconciler — tick every minute ─────────────────────────────
      // The MAPE-K closed loop. Reads desired-state diff, gates by per-project
      // dial + breaker + change-freeze, applies Tier-0/Tier-1 fixes through
      // the existing deterministic kernel.
      //
      // Cadence (2026-07-23): the cron TICKS every minute, but the dispatcher
      // (runReconciler) enforces the OWNER'S plan cadence floor
      // (Plan.autonomyScanIntervalMin):
      //   • Free       → 30 min between reconciler runs
      //   • Pro        → 1 min — effectively continuous (every tick)
      //   • Enterprise → 1 min floor, custom per contract
      // It also exits early for OFF dial settings (shadow only). Cost scales
      // with revenue, not sign-ups. Event-driven kicks (after mutations) flow
      // through the same dispatcher, so they honor the cadence too — a Free
      // project that creates 30 tables in an hour still runs the loop at most
      // twice in that hour. The cron is the backstop for drift detection.
      cron.schedule('* * * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { runReconciler } = await import('./lib/autonomy/reconciler')
        const { FLAGS } = await import('./lib/config/flags')

        if (!FLAGS.ENABLE_AUTONOMY_RECONCILER) {
          return
        }

        // Only scan projects that have shown signs of life recently — the
        // reconciler does real work per project, no point burning DB on dead
        // projects. See lib/autonomy/activity-gate.ts for what counts as alive
        // and why it is no longer "somebody chatted about it".
        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')
        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(),
          select: { id: true },
        }).catch(() => [])

        // Per-project failure isolation — one bad project never stalls the
        // whole tick. Concurrency 5; the per-plan cadence gate inside
        // runReconciler keeps most ticks to a cheap audit-row lookup, so the
        // every-minute tick stays flat on DB load.
        const CONCURRENCY = 5
        let applied = 0
        let frozen = 0
        for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
          const batch = activeProjects.slice(i, i + CONCURRENCY)
          const results = await Promise.allSettled(
            batch.map(p => runReconciler(p.id))
          )
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value && 'applied' in r.value) {
              applied += r.value.applied
              if (r.value.frozen) frozen++
            }
          }
        }
        console.log(
          `[AutonomyReconciler] Cron run complete — ${activeProjects.length} projects, ` +
          `${applied} fixes applied, ${frozen} frozen (mid-incident).`
        )
      })

      // ── DB storage snapshot — hourly ────────────────────────────────────────
      // Measures actual pg_total_relation_size per workspace schema and writes
      // ProjectUsage.dbStorageUsedMb so the billing dashboard reflects real
      // end-user inserts (not only AI-build-time side-effects).
      cron.schedule('0 * * * *', async () => {
        const { snapshotAllProjectsDbStorage } = await import('./lib/billing/usage-tracker')
        await snapshotAllProjectsDbStorage().catch((err: any) =>
          console.error('[DbStorageSnapshot] Error:', err?.message)
        )
      })

      console.log(
        '[CronScheduler] Started — user cron jobs + system tasks every minute, ' +
        'autonomy reconciler tick every minute (plan cadence floors: Free 30m / Pro 1m), ' +
        'DB storage snapshot hourly, ' +
        'all AI background scans once daily (staggered 00:10–04:30 UTC)'
      )
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
