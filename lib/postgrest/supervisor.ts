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
 *   3. SINGLE-FLIGHT, PER REGION. Every project in a region detects the same
 *      outage in the same minute. A pg advisory lock on a fixed key per region
 *      collapses that into one restart; the losers report "a heal is already
 *      running" rather than queueing a second one behind it.
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
 *
 * ── One data plane per region ────────────────────────────────────────────────
 *
 * Each region runs its own PostgREST over its own database. Everything above
 * applies to one region at a time: the probe, the prune, the lock, the cooldown
 * and the restart channel are all the region's, and a heal in one region never
 * touches, waits on or counts against another.
 */

import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { projectRegion, regionSetting } from '@/lib/data-plane/regional'
import { diagnoseAndHeal, probePostgrest, type PostgrestStatus } from './health'

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Fixed advisory-lock key for the home region's data-plane heal. Distinct from
 * `build-lock`'s project-derived keys, which are `Math.abs(djb2(projectId))` —
 * a value this small cannot collide with one of those in practice, and the
 * namespace is documented here so a future fixed-key lock picks a different one.
 * Other regions take the keys just above it (healLockKey).
 */
const HEAL_LOCK_KEY = 8_474_001

/**
 * The lock key for one region's heal. The home region keeps HEAL_LOCK_KEY, so a
 * process running an older build still excludes this one while both are live.
 */
export function healLockKey(region: CloudRegionId): number {
  if (region === HOME_REGION) return HEAL_LOCK_KEY
  const others = CLOUD_REGIONS.filter((r) => r.id !== HOME_REGION).map((r) => r.id)
  return HEAL_LOCK_KEY + 1 + others.indexOf(region)
}

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
  /** Another heal holds the region's lock right now. */
  | 'in_progress'
  /** The region has a data plane this process has no address for. */
  | 'region_not_reachable'
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

// ── Single flight per region ─────────────────────────────────────────────────

/**
 * Take the region's heal lock on a connection of its own, held for the whole
 * heal. The lock is in the control-plane database, which every process shares.
 *
 * An advisory lock belongs to the session that took it. This used to go through
 * the pooled Prisma client, so the unlock could run on a different connection
 * than the lock: it released nothing, and the connection that did hold the lock
 * went back to the pool still holding it. Every later heal on another
 * connection then read "in progress" until that connection happened to close.
 * One dedicated connection, closed at the end, cannot leave the lock behind.
 *
 * Null when the lock is held elsewhere, or when the control-plane database is
 * unreachable. Refusing the heal is correct then too: without the lock this
 * could fan out into one restart per project, and a data plane whose own
 * database is down will not be fixed by a restart.
 */
async function tryLock(key: number): Promise<Client | null> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  try {
    await client.connect()
    const res = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [key],
    )
    if (res.rows[0]?.acquired === true) return client
  } catch {
    /* refused below */
  }
  await client.end().catch(() => {})
  return null
}

async function unlock(client: Client, key: number): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [key])
  } catch { /* closing the session below releases it regardless */ }
  await client.end().catch(() => {})
}

// ── Cooldown, persisted so it survives a process restart ─────────────────────

/**
 * Restart history lives in AuditLog rather than in memory. The Next app and the
 * Express runtime are separate processes, and either can run a reconcile pass —
 * an in-memory cooldown would be per-process and would let two processes restart
 * PostgREST back to back.
 *
 * Per region: a restart of one region's PostgREST says nothing about another's.
 * Every heal row records its region (audit, below); rows written before heals
 * were per region carry none, and were all the home region's.
 */
async function lastRestartAt(region: CloudRegionId): Promise<Date | null> {
  const marker = `"region":"${region}"`
  const inRegion =
    region === HOME_REGION
      ? { OR: [{ details: { contains: marker } }, { NOT: { details: { contains: '"region":' } } }] }
      : { details: { contains: marker } }
  try {
    const row = await prisma.auditLog.findFirst({
      where: { action: 'DATA_PLANE_RESTARTED', type: 'health', ...inRegion },
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
  region: CloudRegionId,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        projectId,
        action,
        type: 'health',
        // Region first, so lastRestartAt can match it in the serialized text.
        details: JSON.stringify({ region, ...payload }),
        timestamp: new Date(),
      },
    })
  } catch { /* auditing must never be the reason a repair fails */ }
}

// ── The restart channel ──────────────────────────────────────────────────────

/**
 * Resolve the LOCAL restart channel, if this host has one.
 *
 * Restarting a process is a host concern, not an application one. On a bare
 * host like Hetzner the app can shell out to systemctl; under an orchestrator
 * it must not, and does not need to: a wedged task fails its health check and
 * the orchestrator replaces it. So this is named `LOCAL`, is optional, and its
 * absence is a normal configuration rather than a fault.
 *
 * Backenly deliberately holds no infrastructure credentials. There is no
 * ECS-aware branch here and there should never be one: giving the product
 * process permission to replace its own tasks buys nothing that a health check
 * does not already provide, and costs a blast radius.
 *
 * The old `POSTGREST_RESTART_COMMAND` is still honoured for one transitional
 * cycle so that redeploying an older host, or rolling back, does not silently
 * lose its emergency fallback just because the variable was not renamed.
 *
 * Per region, like every other setting: POSTGREST_LOCAL_RESTART_COMMAND_<REGION>
 * outside the home region, and never the home command, which restarts the home
 * process. The deprecated name only ever existed for the home region.
 */
function resolveLocalRestartCommand(region: CloudRegionId): { command: string | null; deprecated: boolean } {
  const preferred = regionSetting('POSTGREST_LOCAL_RESTART_COMMAND', region).value?.trim()
  if (preferred) return { command: preferred, deprecated: false }

  const legacy = region === HOME_REGION ? process.env.POSTGREST_RESTART_COMMAND?.trim() : undefined
  if (legacy) return { command: legacy, deprecated: true }

  return { command: null, deprecated: false }
}

/**
 * Run the configured restart command.
 *
 * The command is executed as-is by the platform operator's own shell — it is
 * operator configuration on the operator's own host, in the same category as
 * `DATABASE_URL`. It is never built from user input, never interpolated with
 * anything from a finding, and absent by default.
 *
 * Its text is never logged. An operator is free to put credentials in it, and a
 * heal note travels into findings the customer can read.
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
async function waitForRecovery(region: CloudRegionId): Promise<PostgrestStatus> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS
  let status = await probePostgrest(region)
  while (status.state !== 'healthy' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS))
    status = await probePostgrest(region)
  }
  return status
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Diagnose the data plane and repair it, restarting the process when — and only
 * when — an independent probe confirms that is what it needs.
 *
 * Never throws once it knows the region. A repair that can take down its caller
 * is worse than the fault it fixes; callers read `outcome` / `healthy`.
 * Looking up a project's region can throw (a region this build does not know,
 * or the control-plane database failing), and that is left to the caller, which
 * already handles a throw: guessing a region would heal the wrong data plane.
 *
 * @param projectId  The project whose finding prompted the heal. It decides the
 *                   region, when `region` is not given, and nothing else: the
 *                   decision is made for the whole region, from the probe.
 * @param region     The region whose data plane to heal. Defaults to the
 *                   project's, or the home region when there is no project.
 */
export async function healDataPlane(
  projectId: string | null = null,
  region?: CloudRegionId,
): Promise<HealResult> {
  const notes: string[] = []
  const target = region ?? (projectId ? await projectRegion(projectId) : HOME_REGION)

  // ── 1. Single-flight ──────────────────────────────────────────────────────
  const lockKey = healLockKey(target)
  const lock = await tryLock(lockKey)
  if (!lock) {
    const status = await probePostgrest(target)
    notes.push(`Another data-plane heal is already running for ${target}.`)
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
    const attempt = await diagnoseAndHeal(target)
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
      await audit('DATA_PLANE_HEAL_VERIFIED', projectId, target, { outcome, notes })
      return {
        outcome,
        healthy: true,
        status: attempt.status,
        prunedSchemas: attempt.prunedSchemas,
        restarted: false,
        notes,
      }
    }

    if (attempt.status.state === 'not_configured' && target !== HOME_REGION) {
      // Not "nothing to heal". The region has a data plane, and this process
      // has no address for it, so it can neither see nor repair it. Reporting
      // that as healthy would close a finding about a plane nobody looked at.
      const { variable } = regionSetting('POSTGREST_URL', target)
      notes.push(`${variable} is not set, so this process cannot reach the data plane in ${target} to check or repair it.`)
      await audit('DATA_PLANE_REGION_UNREACHABLE', projectId, target, { variable, notes })
      return {
        outcome: 'region_not_reachable',
        healthy: false,
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
    const last = await lastRestartAt(target)
    if (last && Date.now() - last.getTime() < RESTART_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESTART_COOLDOWN_MS - (Date.now() - last.getTime())) / 1000)
      notes.push(
        `The data plane was restarted ${Math.round((Date.now() - last.getTime()) / 1000)}s ago and ` +
        `is still failing. Holding off ${waitSec}s — restarting again this soon would be a crash ` +
        `loop, not a repair.`,
      )
      await audit('DATA_PLANE_HEAL_COOLDOWN', projectId, target, { waitSec, status: attempt.status, notes })
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
    const { command, deprecated } = resolveLocalRestartCommand(target)
    if (deprecated) {
      // Names the replacement, never the value.
      notes.push(
        'POSTGREST_RESTART_COMMAND is deprecated. Rename it to ' +
        'POSTGREST_LOCAL_RESTART_COMMAND: restarting a process is a host concern, and under an ' +
        'orchestrator the variable should be absent so a wedged task is replaced by its health ' +
        'check instead.',
      )
    }
    if (!command) {
      notes.push(
        'Verified that PostgREST needs a restart, but no local restart channel is configured, so ' +
        'this platform cannot restart it from here. That is expected under an orchestrator, where ' +
        'a failing health check replaces the task. On a bare host, set ' +
        'POSTGREST_LOCAL_RESTART_COMMAND to the supervisor command (for example a systemctl or pm2 ' +
        'restart of the postgrest process) and the loop will repair this class of outage on its own.',
      )
      await audit('DATA_PLANE_RESTART_UNCONFIGURED', projectId, target, { status: attempt.status, notes })
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
    await audit('DATA_PLANE_RESTARTED', projectId, target, {
      reason: attempt.status.state,
      prunedSchemas: attempt.prunedSchemas,
    })

    const run = await runRestartCommand(command)
    notes.push(run.ok ? `Restart command accepted: ${run.detail}` : `Restart command failed: ${run.detail}`)

    // ── 5. Verify recovery, never assume it ─────────────────────────────────
    const recovered = await waitForRecovery(target)
    if (recovered.state === 'healthy') {
      notes.push(`PostgREST is answering again (${recovered.latencyMs}ms).`)
      await audit('DATA_PLANE_HEAL_SUCCEEDED', projectId, target, { notes })
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
    await audit('DATA_PLANE_HEAL_FAILED', projectId, target, { status: recovered, notes })
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
    await unlock(lock, lockKey)
  }
}

/**
 * One sentence for the fix ledger / approve response — written for the PROJECT
 * OWNER, not for whoever runs the platform.
 *
 * The distinction is load-bearing. The data plane is Backenly's infrastructure,
 * not the customer's: telling them "POSTGREST_LOCAL_RESTART_COMMAND is not set on
 * this host" names a variable they cannot reach, in a system they did not deploy, and
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
    case 'region_not_reachable':
      return 'Backenly could not check the database API service in this project\'s region from here. This is platform infrastructure, not your project — it has been escalated and needs no action from you.'
    case 'cooling_down':
      return 'The data plane was just restarted and is still failing, so Backenly is not restarting it again immediately. This is platform infrastructure and is being escalated — there is nothing to change in your project.'
    case 'restart_channel_unconfigured':
      return 'Backenly confirmed the database API service is down. This is platform infrastructure, not your project — it has been escalated to the Backenly operators and needs no action from you.'
    case 'unrecovered':
      return 'The database API service did not come back. This is platform infrastructure, not your project — it has been escalated and needs no action from you.'
  }
}
