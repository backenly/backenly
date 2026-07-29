/**
 * DATA-PLANE SUPERVISOR — the layer `health.ts` said it was reporting to.
 *
 * `diagnoseAndHeal()` has always ended with `restartRequired: true` and this
 * comment: "Process control belongs to whatever supervises the process ... It
 * reports `restartRequired` so the supervising layer can act on a verified
 * diagnosis instead of on a guess."
 *
 * That supervising layer did not exist. `diagnoseAndHeal` had zero callers, so
 * a verified diagnosis went nowhere, and a PostgREST that was down or wedged
 * stayed that way until a human noticed a dashboard. This module is the missing
 * layer.
 *
 * ── Why a shared-process restart is safe to automate ────────────────────────
 *
 * PostgREST is one process serving every tenant, so restarting it is the widest
 * blast radius the autonomy loop can reach for. Four properties make it safe
 * enough to do without asking, and all four must hold — remove any one and this
 * becomes a guess with a platform-sized cost:
 *
 *   1. VERIFIED, NOT REPORTED. The trigger is never the per-project finding.
 *      A project's probe can fail for reasons that have nothing to do with the
 *      data plane, and 40 projects failing does not make the diagnosis 40x more
 *      certain. `healDataPlane` re-runs the INDEPENDENT platform probe and
 *      no-ops the moment PostgREST answers. The finding is what makes us look;
 *      the probe is what decides.
 *   2. STRICTLY IMPROVING. It only acts when the plane is already unreachable
 *      or wedged — i.e. when every tenant is already getting 502/503. There is
 *      no healthy traffic left to disrupt.
 *   3. SINGLE-FLIGHT, PLATFORM-WIDE. Every project detects the same outage in
 *      the same minute. A pg advisory lock on a fixed key collapses that into
 *      one restart; the losers report "a heal is already running" rather than
 *      queueing a second one behind it.
 *   4. RATE-CEILINGED. A cooldown bounds restarts per window, so a fault that
 *      survives a restart (bad config, dead database) degrades into one honest
 *      escalation instead of a restart loop that turns an outage into a crash
 *      loop.
 *
 * ── Why the restart command is configuration, never inference ───────────────
 *
 * This module will not guess how PostgREST is supervised. `POSTGREST_RESTART_
 * COMMAND` is required for the restart step; without it the heal still prunes,
 * re-probes and reports honestly that it verified an outage it has no channel
 * to repair. Inferring `systemctl restart postgrest` and being wrong means
 * shelling an arbitrary string as root on a production box — the failure mode
 * is worse than the outage.
 */

import { prisma } from '@/lib/db'
import { diagnoseAndHeal, probePostgrest, type PostgrestStatus } from './health'

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Fixed advisory-lock key for the platform-wide data-plane heal. Distinct from
 * `build-lock`'s project-derived keys, which are `Math.abs(djb2(projectId))` —
 * a value this small cannot collide with one of those in practice, and the
 * namespace is documented here so a future fixed-key lock picks a different one.
 */
const HEAL_LOCK_KEY = 8_474_001

/** Minimum gap between restarts. Bounds a crash-loop to one restart per window. */
const RESTART_COOLDOWN_MS = 5 * 60 * 1000

/** How long the restarted process gets to answer before we call the heal failed. */
const RECOVERY_TIMEOUT_MS = 30_000
const RECOVERY_POLL_MS = 1_000

/** Hard ceiling on the restart command itself, so a hung supervisor cannot hang the loop. */
const RESTART_TIMEOUT_MS = 20_000

// ── Result shape ─────────────────────────────────────────────────────────────

export type HealOutcome =
  /** PostgREST answered on the verification probe — nothing was wrong. */
  | 'already_healthy'
  /** Pruning dangling schemas cleared it; no restart needed. */
  | 'healed_without_restart'
  /** Restarted, and the plane answered again afterwards. */
  | 'healed_by_restart'
  /** Another heal holds the platform lock right now. */
  | 'in_progress'
  /** Verified outage, but a restart happened too recently to try again. */
  | 'cooling_down'
  /** Verified outage requiring a restart, with no configured restart channel. */
  | 'restart_channel_unconfigured'
  /** Restarted (or tried to) and PostgREST still is not answering. */
  | 'unrecovered'

export interface HealResult {
  outcome: HealOutcome
  /** True only when the data plane is answering by the time this returns. */
  healthy: boolean
  status: PostgrestStatus
  prunedSchemas: number
  restarted: boolean
  /** Human-readable trace — every step, in order. Persisted to the audit log. */
  notes: string[]
}

// ── Platform-wide single flight ──────────────────────────────────────────────

async function tryLock(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<[{ acquired: boolean }]>`
      SELECT pg_try_advisory_lock(${HEAL_LOCK_KEY}::bigint) AS acquired
    `
    return rows[0]?.acquired === true
  } catch {
    // The control-plane database is unreachable. Refusing the heal is correct:
    // without the lock this could fan out into one restart per project, and a
    // data plane whose own database is down will not be fixed by a restart.
    return false
  }
}

async function unlock(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${HEAL_LOCK_KEY}::bigint)`
  } catch { /* session-scoped — released when the connection cycles */ }
}

// ── Cooldown, persisted so it survives a process restart ─────────────────────

/**
 * Restart history lives in AuditLog rather than in memory. The Next app and the
 * Express runtime are separate processes, and either can run a reconcile pass —
 * an in-memory cooldown would be per-process and would let two processes restart
 * PostgREST back to back.
 */
async function lastRestartAt(): Promise<Date | null> {
  try {
    const row = await prisma.auditLog.findFirst({
      where: { action: 'DATA_PLANE_RESTARTED', type: 'health' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    })
    return row?.timestamp ?? null
  } catch {
    return null
  }
}

async function audit(
  action: string,
  projectId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        projectId,
        action,
        type: 'health',
        details: JSON.stringify(payload),
        timestamp: new Date(),
      },
    })
  } catch { /* auditing must never be the reason a repair fails */ }
}

// ── The restart channel ──────────────────────────────────────────────────────

/**
 * Run the configured restart command.
 *
 * `POSTGREST_RESTART_COMMAND` is executed as-is by the platform operator's own
 * shell — it is operator configuration on the operator's own host, in the same
 * category as `DATABASE_URL`. It is never built from user input, never
 * interpolated with anything from a finding, and absent by default.
 */
async function runRestartCommand(command: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)
    const { stdout, stderr } = await execAsync(command, {
      timeout: RESTART_TIMEOUT_MS,
      windowsHide: true,
    })
    const detail = [stdout?.trim(), stderr?.trim()].filter(Boolean).join(' | ').slice(0, 300)
    return { ok: true, detail: detail || 'command exited 0' }
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean }
    if (e?.killed) return { ok: false, detail: `restart command timed out after ${RESTART_TIMEOUT_MS}ms` }
    return { ok: false, detail: (e?.stderr || e?.message || String(err)).slice(0, 300) }
  }
}

/**
 * Poll until PostgREST answers or the recovery window expires.
 *
 * A restart is asynchronous — the command returns as soon as the supervisor
 * accepts it, well before the process has rebuilt its schema cache. Reporting
 * success on the command's exit code would mark the finding auto_fixed while
 * the plane was still down, which is precisely the "reported a fix that did not
 * happen" failure the auto-fix engine's re-check guard exists to prevent.
 */
async function waitForRecovery(): Promise<PostgrestStatus> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS
  let status = await probePostgrest()
  while (status.state !== 'healthy' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS))
    status = await probePostgrest()
  }
  return status
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Diagnose the data plane and repair it, restarting the process when — and only
 * when — an independent probe confirms that is what it needs.
 *
 * Never throws. A repair that can take down its caller is worse than the fault
 * it fixes; callers read `outcome` / `healthy`.
 *
 * @param projectId  The project whose finding prompted the heal. Recorded for
 *                   traceability only — it never influences the decision, which
 *                   is made platform-wide from the probe.
 */
export async function healDataPlane(projectId: string | null = null): Promise<HealResult> {
  const notes: string[] = []

  // ── 1. Single-flight ──────────────────────────────────────────────────────
  if (!(await tryLock())) {
    const status = await probePostgrest()
    notes.push('Another data-plane heal is already running on this platform.')
    return {
      outcome: 'in_progress',
      healthy: status.state === 'healthy',
      status,
      prunedSchemas: 0,
      restarted: false,
      notes,
    }
  }

  try {
    // ── 2. Verify, prune, re-probe ──────────────────────────────────────────
    // diagnoseAndHeal is the independent diagnosis: it probes PostgREST
    // directly, prunes dangling schemas when the cache is wedged, and re-probes
    // before concluding anything.
    const attempt = await diagnoseAndHeal()
    notes.push(...attempt.notes)

    if (attempt.status.state === 'healthy') {
      // Either it was never down (the project probe failed for its own reasons)
      // or pruning fixed it. Both are resolutions, and neither is a restart.
      const outcome: HealOutcome =
        attempt.prunedSchemas > 0 ? 'healed_without_restart' : 'already_healthy'
      if (outcome === 'already_healthy') {
        notes.push(
          'PostgREST answers correctly on the platform probe — the reported outage was ' +
          'not a data-plane fault, so nothing was restarted.',
        )
      }
      await audit('DATA_PLANE_HEAL_VERIFIED', projectId, { outcome, notes })
      return {
        outcome,
        healthy: true,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    if (attempt.status.state === 'not_configured') {
      notes.push('POSTGREST_URL is not set — there is no data plane to heal in this environment.')
      return {
        outcome: 'already_healthy',
        healthy: true,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    if (!attempt.restartRequired) {
      notes.push('Diagnosis did not conclude that a restart is required.')
      return {
        outcome: 'unrecovered',
        healthy: false,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    // ── 3. Rate ceiling ─────────────────────────────────────────────────────
    const last = await lastRestartAt()
    if (last && Date.now() - last.getTime() < RESTART_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESTART_COOLDOWN_MS - (Date.now() - last.getTime())) / 1000)
      notes.push(
        `The data plane was restarted ${Math.round((Date.now() - last.getTime()) / 1000)}s ago and ` +
        `is still failing. Holding off ${waitSec}s — restarting again this soon would be a crash ` +
        `loop, not a repair.`,
      )
      await audit('DATA_PLANE_HEAL_COOLDOWN', projectId, { waitSec, status: attempt.status, notes })
      return {
        outcome: 'cooling_down',
        healthy: false,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    // ── 4. Restart ──────────────────────────────────────────────────────────
    const command = process.env.POSTGREST_RESTART_COMMAND?.trim()
    if (!command) {
      notes.push(
        'Verified that PostgREST needs a restart, but POSTGREST_RESTART_COMMAND is not set, so ' +
        'there is no channel to restart it through. Set it to the supervisor command for this ' +
        'host (for example a systemctl or pm2 restart of the postgrest process) and the loop will ' +
        'repair this class of outage on its own.',
      )
      await audit('DATA_PLANE_RESTART_UNCONFIGURED', projectId, { status: attempt.status, notes })
      return {
        outcome: 'restart_channel_unconfigured',
        healthy: false,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    // Recorded BEFORE the command runs. If the process dies mid-restart, the
    // cooldown must still be in effect on the next pass — a crash that loses the
    // record is exactly when the loop is most likely to restart repeatedly.
    await audit('DATA_PLANE_RESTARTED', projectId, {
      reason: attempt.status.state,
      prunedSchemas: attempt.prunedSchemas,
    })

    const run = await runRestartCommand(command)
    notes.push(run.ok ? `Restart command accepted: ${run.detail}` : `Restart command failed: ${run.detail}`)

    // ── 5. Verify recovery, never assume it ─────────────────────────────────
    const recovered = await waitForRecovery()
    if (recovered.state === 'healthy') {
      notes.push(`PostgREST is answering again (${recovered.latencyMs}ms).`)
      await audit('DATA_PLANE_HEAL_SUCCEEDED', projectId, { notes })
      return {
        outcome: 'healed_by_restart',
        healthy: true,
        status: recovered,
        prunedSchemas: attempt.prunedSchemas,
        restarted: true,
        notes,
      }
    }

    notes.push(
      `PostgREST did not recover within ${RECOVERY_TIMEOUT_MS / 1000}s of the restart — the cause ` +
      `is outside the data-plane process itself.`,
    )
    await audit('DATA_PLANE_HEAL_FAILED', projectId, { status: recovered, notes })
    return {
      outcome: 'unrecovered',
      healthy: false,
      status: recovered,
      prunedSchemas: attempt.prunedSchemas,
      restarted: run.ok,
      notes,
    }
  } catch (err) {
    // diagnoseAndHeal touches the database and PostgREST; either can fail in a
    // way that throws. An outage is not a reason to also crash the caller.
    const message = err instanceof Error ? err.message : String(err)
    notes.push(`Heal aborted: ${message}`)
    return {
      outcome: 'unrecovered',
      healthy: false,
      status: { state: 'unreachable', detail: message },
      prunedSchemas: 0,
      restarted: false,
      notes,
    }
  } finally {
    await unlock()
  }
}

/**
 * One sentence for the fix ledger / approve response — written for the PROJECT
 * OWNER, not for whoever runs the platform.
 *
 * The distinction is load-bearing. The data plane is Backenly's infrastructure,
 * not the customer's: telling them "POSTGREST_RESTART_COMMAND is not set on this
 * host" names a variable they cannot reach, in a system they did not deploy, and
 * reads as the platform blaming its own config at them. They need to know what
 * is broken, that it is ours, and whether they must do anything.
 *
 * The operator detail is not lost — it goes to `result.notes`, which every
 * branch writes to the audit log.
 *
 * Every branch says what was verified and what was done, including the ones that
 * did nothing. "Nothing was restarted, and here is why" is what keeps the loop
 * trustworthy when it declines to act.
 */
export function describeHeal(result: HealResult): string {
  switch (result.outcome) {
    case 'already_healthy':
      return 'The data plane is answering — the outage had already cleared, so nothing was changed.'
    case 'healed_without_restart':
      return `Data plane restored: cleared ${result.prunedSchemas} stale schema registration(s), no restart needed.`
    case 'healed_by_restart':
      return 'Data plane restored: the database API service was restarted and is answering again.'
    case 'in_progress':
      return 'A data-plane repair is already running — this will clear on the next check.'
    case 'cooling_down':
      return 'The data plane was just restarted and is still failing, so Backenly is not restarting it again immediately. This is platform infrastructure and is being escalated — there is nothing to change in your project.'
    case 'restart_channel_unconfigured':
      return 'Backenly confirmed the database API service is down. This is platform infrastructure, not your project — it has been escalated to the Backenly operators and needs no action from you.'
    case 'unrecovered':
      return 'The database API service did not come back. This is platform infrastructure, not your project — it has been escalated and needs no action from you.'
  }
}
