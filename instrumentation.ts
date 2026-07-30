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

      // ── Tier B: diagnose what Tier A escalated ─────────────────────────────
      //
      // This was MISSING here, and that is why no escalated finding has ever
      // carried a root-cause explanation in production.
      //
      // GET /api/cron/autonomy runs two passes: runReconciler (Tier A, acts) and
      // diagnoseEscalatedFindings (Tier B, explains). This in-process scheduler
      // is what actually runs on the box — the HTTP route is invoked by nothing
      // (no crontab entry, no systemd timer, zero hits in the nginx access log)
      // because Vercel-style cron declarations do not fire on a Hetzner VPS. So
      // Tier A was scheduled below and Tier B was simply left behind, and the
      // whole hypothesis/diagnosis engine under lib/autonomy/hypothesis/ never
      // executed. ReviewQueuePanel renders a diagnosis block for exactly this
      // data; it has always been empty.
      //
      // Slower cadence than the reconciler on purpose: this is the one autonomy
      // path that calls a model. It is self-capping (MAX_PER_TICK = 2 per
      // project) and skips findings that already carry a diagnosis, so a tick
      // with nothing escalated costs one indexed query per project.
      cron.schedule('*/10 * * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { diagnoseEscalatedFindings } = await import('./lib/autonomy/escalation-diagnosis')
        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')

        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(),
          select: { id: true },
        }).catch(() => [])
        if (activeProjects.length === 0) return

        const CONCURRENCY = 5
        let diagnosed = 0
        for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
          const batch = activeProjects.slice(i, i + CONCURRENCY)
          const results = await Promise.allSettled(
            batch.map(p => diagnoseEscalatedFindings(p.id)),
          )
          for (const r of results) {
            if (r.status === 'fulfilled') diagnosed += r.value
          }
        }
        if (diagnosed > 0) {
          console.log(`[EscalationDiagnosis] Wrote ${diagnosed} diagnosis/diagnoses`)
        }
      })

      // ── Sensor health: can the instruments still detect anything? ───────────
      //
      // Also previously unscheduled — checkSensorHealth was reachable only when
      // an agent called the MCP tool, so the loop never checked its own probes.
      // The failure it exists to catch is a probe returning [] because it is
      // BROKEN: detectMissingRls did that in every environment for months while
      // the dashboard rendered green, because "no findings" and "cannot detect
      // findings" are the same value. Running it records first-firings, which is
      // what promotes a probe from `unverified` to `clean` and makes its silence
      // mean something later.
      //
      // Daily, and after the observer's own pass, because it runs the full
      // desired-state diff per project.
      cron.schedule('40 0 * * *', async () => {
        const { prisma } = await import('./lib/db/prisma')
        const { checkSensorHealth, summariseSensorHealth } = await import('./lib/autonomy/sensor-health')
        const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')

        const activeProjects = await prisma.project.findMany({
          where: activeProjectsWhere(),
          select: { id: true },
        }).catch(() => [])

        for (const p of activeProjects) {
          try {
            const report = await checkSensorHealth(p.id)
            // Only shout when the instruments are not trustworthy. A fully
            // instrumented project is not news.
            if (!report.fullyInstrumented) {
              console.warn(
                `[SensorHealth] project=${p.id} ${summariseSensorHealth(report)}`,
              )
            }
          } catch (err: any) {
            console.error(`[SensorHealth] project=${p.id} failed:`, err?.message)
          }
        }
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
      // Cadence: the cron ticks every minute and EVERY plan reconciles on
      // every tick — Free, Pro and Enterprise all seed
      // Plan.autonomyScanIntervalMin = 1 (prisma/seed-billing.ts). The pricing
      // page sells "self-healing every minute" on the Free tier, so throttling
      // Free here would make the product contradict its own price list.
      //
      // The dispatcher (runReconciler) still reads the plan's cadence floor,
      // because the field is per-plan and live-editable — but with today's
      // values that gate is a no-op. Free↔Pro is separated by scan budget and
      // actions per window, not by how often the loop may look.
      //
      // It also exits early for OFF dial settings (shadow only). Event-driven
      // kicks (after mutations) flow through the same dispatcher, so they
      // honor the same rules. The cron is the backstop for drift detection.
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
        // whole tick. Concurrency 5; the reconciler is deterministic (no model
        // calls), so an every-minute pass costs DB work and audit rows rather
        // than tokens.
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
        'autonomy reconciler tick every minute (1-min cadence on every plan), ' +
        'DB storage snapshot hourly, ' +
        'all AI background scans once daily (staggered 00:10–04:30 UTC)'
      )
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
