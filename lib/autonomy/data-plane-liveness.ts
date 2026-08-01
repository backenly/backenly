/**
 * IS THE BACKEND ACTUALLY ANSWERING?
 * ==================================
 *
 * ── Why this invariant exists ───────────────────────────────────────────────
 *
 * Measured against two months of production findings (2026-06-02 → 2026-07-31,
 * every project), one fault type accounts for roughly 80% of everything that has
 * ever genuinely gone wrong:
 *
 *   contract_surface_broken   298
 *   missing_fk                 29
 *   missing_rate_limit         28   (detector since retired)
 *   verification_failed         4
 *   orphan_table                3
 *   missing_fk_index            2
 *   workflow_broken             1
 *   …
 *
 * `contract_surface_broken` means a customer cannot reach their backend. It was
 * not one of the seventeen invariants. It is written only by
 * `lib/services/contract-verifier.ts` on a separate 15-minute sweep, and appears
 * in the desired-state catalogue exactly once — in a comment explaining that it
 * is EXCLUDED.
 *
 * The consequence is the specific failure this whole system exists to prevent:
 * `computeDesiredStateDiff` could return `satisfied: true` and
 * `summarizeDesiredState` could print "Backend is healthy — all guarantees hold"
 * at the moment a project's REST API was returning 502s. The catalogue was
 * weighted toward STRUCTURE — schema shape, RLS, indexes, constraints — while
 * reality is weighted toward LIVENESS. The most common real failure was in the
 * blind spot of the thing built to watch for failures.
 *
 * ── Why this probe reads recorded evidence instead of probing ───────────────
 *
 * The obvious implementation — call `detectContractViolations` from the
 * invariant — is wrong and would be a serious regression. That function makes
 * five real HTTP calls per project with an 8s timeout each, plus a 12s retry
 * window when every surface fails. The reconciler runs the full invariant set
 * EVERY MINUTE for every active project; the contract sweep runs every fifteen
 * for exactly this reason. Wiring live probing into the minute loop would
 * multiply outbound probe traffic ~15x and put a 20s worst case inside a loop
 * that is otherwise pure database work.
 *
 * So the sweep stays the only prober, and this invariant reads what it recorded.
 *
 * ── Why a heartbeat had to be added ─────────────────────────────────────────
 *
 * Reading only "is there an open contract_surface_broken finding?" would have
 * rebuilt the exact bug this invariant is a response to. Absence of a finding is
 * ambiguous between:
 *
 *   • the sweep ran and every surface answered            (healthy)
 *   • the sweep has not run in three days                 (no information)
 *
 * and reading the second as the first is precisely how `detectMissingRls`
 * reported green while dead. The sweep recorded nothing on a clean pass, so
 * `recordContractSweepResult` now writes a per-project heartbeat on EVERY pass.
 * Stored on ProjectPreference as an upsert — one row per project, updated in
 * place, no unbounded growth — the same mechanism `sensor-health.ts` uses for
 * probe liveness.
 *
 * When the heartbeat is missing or stale this probe THROWS rather than
 * returning `[]`. `computeDesiredStateDiff` isolates the rejection, records it
 * in `errors`, and marks the invariant unsatisfied — because unknown state is
 * not the same as healthy. That is the whole point.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'

const PREF_TYPE = 'contract_liveness'
const PREF_KEY = 'last_sweep'

/**
 * How stale a heartbeat may be before its silence stops meaning anything.
 *
 * The sweep is scheduled every 15 minutes (instrumentation.ts, `*​/15 * * * *`).
 * Three intervals allows a missed run plus scheduling jitter without crying
 * wolf, while still surfacing a genuinely dead sweep within the hour. Tightening
 * this below one interval would make the invariant flap against its own
 * scheduler.
 */
const HEARTBEAT_MAX_AGE_MS = 45 * 60 * 1000

export interface ContractLivenessHeartbeat {
  verifiedAt: string
  /** True when every advertised surface answered on the last sweep. */
  ok: boolean
  /** Surfaces that failed, for the message. Empty when ok. */
  brokenSurfaces: string[]
}

/**
 * Record the outcome of one contract sweep for one project.
 *
 * Called on EVERY pass including clean ones — a heartbeat that is only written
 * on failure cannot distinguish "healthy" from "never ran", which is the
 * ambiguity this exists to remove. Never throws: the sweep's job is probing, and
 * a bookkeeping failure must not fail the probe that succeeded.
 */
export async function recordContractSweepResult(
  projectId: string,
  brokenSurfaces: string[],
): Promise<void> {
  const beat: ContractLivenessHeartbeat = {
    verifiedAt: new Date().toISOString(),
    ok: brokenSurfaces.length === 0,
    brokenSurfaces,
  }
  const value = JSON.stringify(beat)
  await prisma.projectPreference
    .upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      create: { projectId, type: PREF_TYPE, key: PREF_KEY, value, confidence: 1 },
      update: { value, lastSeen: new Date() },
    })
    .catch(() => {
      /* observability bookkeeping — never blocks the sweep */
    })
}

/** Read the heartbeat, or null when absent/unparseable. */
export async function readContractLiveness(
  projectId: string,
): Promise<ContractLivenessHeartbeat | null> {
  const row = await prisma.projectPreference
    .findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      select: { value: true },
    })
    .catch(() => null)
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as ContractLivenessHeartbeat
    return typeof parsed?.verifiedAt === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Pure staleness rule, separated so it is provable without a database. */
export function isHeartbeatStale(
  beat: Pick<ContractLivenessHeartbeat, 'verifiedAt'> | null,
  now: Date = new Date(),
  maxAgeMs: number = HEARTBEAT_MAX_AGE_MS,
): boolean {
  if (!beat) return true
  const t = Date.parse(beat.verifiedAt)
  if (!Number.isFinite(t)) return true
  return now.getTime() - t > maxAgeMs
}

/**
 * The invariant probe: is this project's advertised API answering?
 *
 * Returns the gaps as the CONTRACT SWEEP ALREADY RECORDED THEM — read back from
 * `health_findings` rather than re-derived. That keeps a single writer: the
 * sweep owns creating and resolving these rows, and this probe only surfaces
 * them into the desired-state verdict. Emitting freshly-built gaps here would
 * make two components authors of the same finding, and the identity they
 * disagreed on would decide which one won.
 */
export async function detectDataPlaneNotAnswering(projectId: string): Promise<RawFinding[]> {
  // A project with no tables is never swept (runContractSweep selects
  // `tables: { some: {} }`), so it has no heartbeat and never will. That is a
  // correct state — there is no data plane to answer — not an unknown one.
  // Without this branch every unbuilt project would permanently report "could
  // not be checked", and because `reapInvariantFindings` refuses to reap on any
  // probe error, it would also permanently freeze their finding cleanup.
  const tableCount = await prisma.table.count({ where: { projectId } }).catch(() => 0)
  if (tableCount === 0) return []

  const beat = await readContractLiveness(projectId)

  if (isHeartbeatStale(beat)) {
    // Deliberately a throw, not an empty array. See the module header: an
    // invariant that cannot be evaluated must never be reported as satisfied.
    throw new Error(
      beat
        ? `contract sweep has not verified this project since ${beat.verifiedAt} ` +
          `(older than ${Math.round(HEARTBEAT_MAX_AGE_MS / 60000)} min) — liveness is unknown, not healthy`
        : 'contract sweep has never verified this project — liveness is unknown, not healthy',
    )
  }

  if (beat!.ok) return []

  // The sweep says at least one surface was failing. Surface the rows it wrote.
  const open = await prisma.healthFinding
    .findMany({
      where: {
        projectId,
        type: 'contract_surface_broken',
        status: { in: ['open', 'pending_approval'] },
      },
      select: { severity: true, details: true },
    })
    .catch(() => [] as Array<{ severity: string; details: unknown }>)

  return open.map((f) => ({
    type: 'contract_surface_broken' as const,
    severity: (f.severity as RawFinding['severity']) ?? 'critical',
    details: (f.details ?? {}) as Record<string, unknown>,
    // The sweep owns repair for these (it runs HEAL_DATA_PLANE itself for the
    // data-plane shape and is single-flighted platform-wide). This probe never
    // attaches a second fix closure.
    autoFixable: false,
  }))
}
