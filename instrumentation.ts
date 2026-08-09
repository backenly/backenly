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

      // ── Graph retention, 05:20 UTC ─────────────────────────────────────────
      //
      // Declared in vercel.json since forever and never once executed, because
      // no /api/cron/* route is invoked on this host. 1339 graphs had
      // accumulated across six projects.
      //
      // Scheduled only AFTER making retention entitlement-aware. The flat
      // RETENTION_COUNT of 20 contradicted plans.maxDeploymentHistory, which is
      // NULL (unlimited) for BUILDER and SCALE — so running this as it stood
      // would have silently deleted history those plans are sold as keeping,
      // and only for paying customers. See lib/orchestration/graph-cleanup.ts.
      //
      // Safe by construction: per-project transaction, never deletes the active
      // graph or sequence 1, and both FKs onto backend_graphs are
      // ON DELETE SET NULL so a severed lineage cannot fail the delete.
      cron.schedule('20 5 * * *', async () => {
        const { cleanupAllProjectGraphs } = await import('./lib/orchestration/graph-cleanup')
        const res = await cleanupAllProjectGraphs().catch((err: any) => {
          console.error('[GraphCleanup] Cron error:', err?.message)
          return null
        })
        if (res && res.totalDeleted > 0) {
          console.log(
            `[GraphCleanup] Pruned ${res.totalDeleted} graph(s) across ${res.projectsProcessed} project(s), kept ${res.totalKept}`,
          )
        }
      })

      // ── Billing grace periods, 03:10 UTC ───────────────────────────────────
      //
      // Also previously unscheduled. `runDailyGraceCheck` downgrades
      // subscriptions whose GRACE window has expired back to FREE, and it lives
      // behind /api/cron/grace-check (and its duplicate,
      // /api/cron/process-grace-periods). No /api/cron/* route is invoked on
      // this host — no crontab entry, no systemd timer, zero hits in the nginx
      // access log — so it had never run.
      //
      // Impact today is nil: there are no GRACE subscriptions, because there are
      // no paid ones. It is wired up now because the day that stops being true
      // is exactly the day nobody thinks to check, and the failure is silent in
      // the direction that costs money — a lapsed payer keeps their paid plan.
      cron.schedule('10 3 * * *', async () => {
        const { runDailyGraceCheck } = await import('./lib/billing/grace')
        const res = await runDailyGraceCheck().catch((err: any) => {
          console.error('[GraceCheck] Cron error:', err?.message)
          return null
        })
        if (res && res.processed > 0) {
          console.log(`[GraceCheck] Downgraded ${res.processed} expired grace period(s) to FREE`)
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

      // Live API contract probes every minute. Deliberately separate from the
      // daily observer above: five HTTP calls per project (~1s) versus minutes
      // of LLM-backed analysis. This is the detector that answers "is this
      // backend answering its users right now?" — measured over two months of
      // production, contract_surface_broken is ~80% of every real fault ever
      // recorded here.
      //
      // It ran every 15 minutes, which put a 15-minute floor under the detection
      // of the single most common way a customer's backend breaks, on a product
      // that sells minute-by-minute healing. The reconciler reads this sweep's
      // recorded result rather than probing itself (live HTTP does not belong in
      // a per-minute loop), so the sweep's cadence WAS the data plane's
      // detection latency no matter how often the reconciler ran.
      //
      // Self-limiting rather than rate-limited: if a sweep is still running when
      // the next minute fires, this one skips. Under normal load that never
      // happens (five projects in parallel, ~1s each); under enough load to
      // matter it degrades to "as often as it can finish" instead of piling
      // overlapping sweeps onto the same projects. A guard, not a quota.
      cron.schedule('* * * * *', async () => {
        const g = globalThis as any
        if (g.__contractSweepRunning) return
        g.__contractSweepRunning = true
        try {
          const { runContractSweep } = await import('./lib/services/workspace-observer')
          await runContractSweep()
        } catch (err: any) {
          console.error('[ContractSweep] Cron error:', err?.message)
        } finally {
          g.__contractSweepRunning = false
        }
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

      // ── Phase 6: Infra Intelligence — every minute ──────────────────────────
      //
      // Queries pg_stat_* views (not user data). Detects hot tables, dead-tuple
      // bloat, index fragmentation, partitioning candidates, connection
      // saturation. Auto-applies safe index additions; queues structural
      // changes for approval.
      //
      // It ran once a day, and that was a 24-hour floor on something the loop
      // cannot do without: this pass owns the `infra_*` finding types, so it is
      // the ONLY thing that can WITHDRAW one. A hot-table finding whose table was
      // indexed a minute later stayed in the review queue until the next 02:30
      // UTC sweep, and the user has no way to tell a stale row from a live one.
      //
      // Daily was never justified by cost. Unlike the neighbouring background
      // scans, this module contains no model call of any kind — it is pure SQL
      // over statistics views, cheaper per project than the reconciler pass that
      // already runs every minute beside it.
      //
      // Same self-limiting guard as the contract sweep: if a pass is still
      // running when the next minute fires, skip. Degrades to "as often as it
      // can finish" under load rather than stacking overlapping sweeps.
      cron.schedule('* * * * *', async () => {
        const g = globalThis as any
        if (g.__infraScanRunning) return
        g.__infraScanRunning = true
        try {
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
        } catch (err: any) {
          console.error('[InfraIntelligence] Cron error:', err?.message)
        } finally {
          g.__infraScanRunning = false
        }
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

        // ── Say out loud when the loop cannot actually repair anything ───────
        //
        // ENABLE_AUTONOMY_LIVE_EXECUTION defaults to false, and with it unset
        // every project silently runs in shadow: the loop evaluates, decides,
        // and writes an AUTONOMY_SHADOW_DECISION row that looks like work, but
        // applies nothing. Nothing else says so. The dashboard still shows the
        // dial the owner set, the cron still reports projects scanned, and the
        // audit ledger still fills up — so a deployment that heals nothing is
        // indistinguishable from one that heals everything.
        //
        // Throttled to once an hour: this is a configuration fact, not an
        // event, and a per-minute warning would train everyone to filter it.
        if (!FLAGS.ENABLE_AUTONOMY_LIVE_EXECUTION) {
          const g = globalThis as any
          const lastWarn = g.__autonomyShadowWarnAt ?? 0
          if (Date.now() - lastWarn > 60 * 60 * 1000) {
            g.__autonomyShadowWarnAt = Date.now()
            console.warn(
              '[AutonomyReconciler] SHADOW MODE — ENABLE_AUTONOMY_LIVE_EXECUTION is not set, ' +
              'so the loop is evaluating every project but repairing NOTHING. Self-healing is off. ' +
              'Set ENABLE_AUTONOMY_LIVE_EXECUTION=true to enable it (see .env.example).',
            )
          }
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

      // ── Database behaviour baseline — hourly, on the hour ───────────────────
      //
      // Records query latency, sequential scans, table size and connection
      // counts per project, so `the_backend_behaves_like_itself` has a history
      // to measure the current hour against. Hourly is the cadence the whole
      // design assumes: the samples ARE hour buckets, and running it more often
      // would refine the current bucket repeatedly for no gain.
      //
      // Runs at :05 rather than :00 so it is not competing with every other
      // hourly job for the same connections, and reads only pg_stat_* views and
      // pg_class sizes — no user data, no model call.
      cron.schedule('5 * * * *', async () => {
        const g = globalThis as any
        if (g.__baselineCollectorRunning) return
        g.__baselineCollectorRunning = true
        try {
          const { prisma } = await import('./lib/db/prisma')
          const { collectBaseline, pruneBaseline } = await import('./lib/autonomy/baseline/collector')
          const { activeProjectsWhere } = await import('./lib/autonomy/activity-gate')

          const projects = await prisma.project.findMany({
            where: activeProjectsWhere(),
            select: { id: true },
          }).catch(() => [])

          const CONCURRENCY = 5
          for (let i = 0; i < projects.length; i += CONCURRENCY) {
            const batch = projects.slice(i, i + CONCURRENCY)
            await Promise.allSettled(batch.map(p => collectBaseline(p.id)))
          }

          // One indexed delete for the whole platform, not one per project.
          const pruned = await pruneBaseline()
          console.log(`[Baseline] sampled ${projects.length} project(s), pruned ${pruned} old sample(s)`)
        } catch (err: any) {
          console.error('[Baseline] Cron error:', err?.message)
        } finally {
          g.__baselineCollectorRunning = false
        }
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
