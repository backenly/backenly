/**
 * THE GATE — WHERE AUTHORITY BECOMES ENFORCEMENT
 * ==============================================
 *
 * Phase 2 evaluated the Authority Decision beside the live loop and changed
 * nothing. This is where it becomes the actual authority: no autonomous
 * mutation may reach the executor except through `authorizeAutonomousFix`, and
 * only `AUTO_EXECUTE` gets through.
 *
 * ── Fail closed, everywhere ─────────────────────────────────────────────────
 *
 * Every path that cannot establish an answer returns a refusal. A sensor report
 * that throws, a project that cannot be read, an unrecognised finding type, an
 * unregistered action class: all of them produce FREEZE with a named blocker,
 * never a pass. The whole audit this architecture came out of was inabilities
 * to know being converted into positive claims, and a gate that opened when it
 * was confused would be the largest such conversion yet.
 *
 * ── Two moments, not one ────────────────────────────────────────────────────
 *
 * `authorizeAutonomousFix` decides. `revalidateAtMutationBoundary` proves the
 * decision still holds immediately before the mutation. They are separate
 * because everything between them is time in which an owner can revoke a grant,
 * a migration can land, or a probe can break.
 */

import { prisma } from '@/lib/db/prisma'
import { changesBefore, type CorrelatedChange } from '@/lib/autonomy/change-correlation'
import { checkSensorHealth } from '@/lib/autonomy/sensor-health'
import { DEFAULT_LEVEL, coerceAutonomyLevel, type AutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { loopPrincipals, principalsToMetadata, type PrincipalSet } from '@/lib/principal'

import { actionClassForFindingType } from './action-classes'
import { decideAuthority, type AuthorityDecision, type ObservationContext } from './decision'
import { loadGrants, revalidateGrant } from './grants'
import { loadOwnershipIntents, type OwnershipIntentRecord } from './ownership-intent'

export interface GateResult {
  decision: AuthorityDecision
  /** Only true for AUTO_EXECUTE. The single boolean the executor may trust. */
  mayExecute: boolean
  /** Carried to the mutation boundary so revalidation can prove it unchanged. */
  lease: {
    grantId: string | null
    grantVersion: number | null
    intentId: string | null
    intentVersion: number | null
    observedAt: string
  }
}

/** The environment this deployment is running as. */
export function currentEnvironment(): 'development' | 'staging' | 'production' {
  const raw = (process.env.BACKENLY_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
  if (raw === 'production') return 'production'
  if (raw === 'staging') return 'staging'
  return 'development'
}

/**
 * Establish whether the resource can be observed, AS the role that observes it.
 *
 * Asked of PostgreSQL through the application connection, because that is the
 * context the probes read through. A privileged context answering for a weaker
 * one is the Phase 0B finding, and it is why this does not simply ask whether
 * the schema exists in some other session.
 */
async function observe(projectId: string, resource: string): Promise<ObservationContext> {
  const observedAt = new Date().toISOString()
  try {
    const schema = await resolveWorkspaceSchema(projectId)
    const who = await prisma.$queryRawUnsafe<
      Array<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>
    >(`SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      schema,
    )
    const role = who[0]
    return {
      role: role?.u ?? 'unknown',
      bypassesRls: Boolean(role?.rolsuper || role?.rolbypassrls),
      observedAt,
      resourceObservable: rows[0].n > 0,
      reason: rows[0].n > 0 ? null : `schema ${schema} is not present`,
    }
  } catch (err: any) {
    // Could not establish it. `'unknown'` is treated as unobservable by the
    // decision, which is the point: a failed observability check is not a
    // healthy one.
    return {
      role: 'unknown',
      bypassesRls: false,
      observedAt,
      resourceObservable: 'unknown',
      reason: `observability check failed: ${err?.message ?? err}`,
    }
  }
}

async function projectLevel(projectId: string): Promise<AutonomyLevel> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { autonomyLevel: true },
    })
    return coerceAutonomyLevel((p as any)?.autonomyLevel) ?? DEFAULT_LEVEL
  } catch {
    return DEFAULT_LEVEL
  }
}

/**
 * Decide whether a proposed autonomous repair may execute.
 *
 * `resource` is `schema.table` so the intent lookup and the receipt name the
 * same thing.
 */
export async function authorizeAutonomousFix(args: {
  projectId: string
  findingType: string
  tableName: string | null
  loop?: 'reconciler' | 'maintenance'
}): Promise<GateResult> {
  const loop = args.loop ?? 'reconciler'
  const environment = currentEnvironment()
  const table = args.tableName ?? ''
  const resource = table ? `${args.projectId}.${table}` : args.projectId

  const cls = actionClassForFindingType(args.findingType)
  const principals: PrincipalSet = await loopPrincipals(prisma, args.projectId, loop)

  // An unregistered finding type has no declared dependencies, so nothing can
  // be established about it. `decideAuthority` freezes on an unknown class; the
  // id is passed through so the receipt names what was unregistered.
  const actionClassId = cls?.id ?? `unregistered:${args.findingType}`

  const observation = await observe(args.projectId, resource)

  let probes: Awaited<ReturnType<typeof checkSensorHealth>>['probes'] = []
  let sensorError: string | null = null
  try {
    probes = (await checkSensorHealth(args.projectId)).probes
  } catch (err: any) {
    // No sensor report means no sensor can support anything, which the decision
    // reads as every required sensor missing -> FREEZE.
    sensorError = err?.message ?? String(err)
  }

  let intents: OwnershipIntentRecord[] = []
  if (table) {
    intents = await loadOwnershipIntents(prisma, args.projectId, table).catch(() => [])
  }

  const delegations = cls ? await loadGrants(args.projectId, cls.id).catch(() => []) : []

  let recentChanges: CorrelatedChange[] = []
  try {
    recentChanges = await changesBefore(args.projectId, new Date())
  } catch {
    recentChanges = []
  }

  const decision = decideAuthority({
    projectId: args.projectId,
    actionClassId,
    resource: table ? `${await resolveWorkspaceSchema(args.projectId)}.${table}` : resource,
    environment,
    principals,
    level: await projectLevel(args.projectId),
    probes,
    observation: sensorError
      ? { ...observation, resourceObservable: 'unknown', reason: `sensor report failed: ${sensorError}` }
      : observation,
    ownershipIntents: intents,
    delegations,
    recentChanges,
  })

  const usedGrant = delegations.find(
    d => d.id && decision.delegation?.satisfied && d.environment === environment,
  )
  const usedIntent = intents.find(i => !i.revokedAt && !i.supersededById)

  await writeReceipt(args.projectId, decision, principals)

  // A refused autonomous action is an operator-visible event. Without this the
  // only symptom of a gate that refuses too much is silence, which is the
  // failure mode this whole architecture exists to avoid.
  if (decision.decision !== 'AUTO_EXECUTE') {
    console.warn(
      `[Authority] ${decision.decision} project=${args.projectId} ` +
        `action=${actionClassId} narrowedBy=${decision.narrowedBy.join(',') || '-'} ` +
        `${decision.blocker ? `blocker=${decision.blocker}` : ''}`,
    )
  }

  return {
    decision,
    mayExecute: decision.decision === 'AUTO_EXECUTE',
    lease: {
      grantId: usedGrant?.id ?? null,
      grantVersion: usedGrant?.version ?? null,
      intentId: usedIntent?.id ?? null,
      intentVersion: usedIntent?.version ?? null,
      observedAt: observation.observedAt,
    },
  }
}

/**
 * Prove the decision still holds, immediately before mutating.
 *
 * A decision is a lease, not a certificate (RFC §10.4). The execution lock
 * serializes executors against each other; it does NOT serialize an executor
 * against an owner revoking a grant through the settings API, which never takes
 * that lock. So the grant is proven unchanged by VERSION rather than by a
 * re-read, because a re-read establishes only that some permission exists now.
 */
export async function revalidateAtMutationBoundary(
  gate: GateResult,
  projectId: string,
): Promise<{ stillValid: boolean; reason: string | null }> {
  // Grant: compare-and-set on version.
  if (gate.lease.grantId && gate.lease.grantVersion !== null) {
    const g = await revalidateGrant(gate.lease.grantId, gate.lease.grantVersion)
    if (!g.valid) return { stillValid: false, reason: g.reason }
  }

  // Intent: a superseded or revoked declaration no longer describes the table.
  if (gate.lease.intentId) {
    try {
      const i = await prisma.ownershipIntent.findUnique({ where: { id: gate.lease.intentId } })
      if (!i) return { stillValid: false, reason: 'ownership intent no longer exists' }
      if (i.revokedAt) return { stillValid: false, reason: 'ownership intent was revoked' }
      if (i.supersededById) return { stillValid: false, reason: 'ownership intent was superseded' }
      if (i.version !== gate.lease.intentVersion) {
        return {
          stillValid: false,
          reason: `ownership intent changed (v${gate.lease.intentVersion} -> v${i.version})`,
        }
      }
    } catch (err: any) {
      return { stillValid: false, reason: `intent could not be re-read: ${err?.message ?? err}` }
    }
  }

  // Observability: still visible to the role that will make the change.
  const obs = await observe(projectId, gate.decision.resource)
  if (obs.resourceObservable !== true) {
    return { stillValid: false, reason: obs.reason ?? 'resource is no longer observable' }
  }

  return { stillValid: true, reason: null }
}

/**
 * Write the decision receipt.
 *
 * Written for refusals too. "Why did nothing happen" is the second most common
 * question after "why did you touch my database", and a layer that only records
 * what it permitted cannot answer it.
 */
async function writeReceipt(
  projectId: string,
  decision: AuthorityDecision,
  principals: PrincipalSet,
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        projectId,
        action: `AUTHORITY_${decision.decision}`,
        type: 'autonomy',
        details: JSON.stringify({
          actionClass: decision.actionClassId,
          resource: decision.resource,
          environment: decision.environment,
          narrowedBy: decision.narrowedBy,
          reasons: decision.reasons,
          blocker: decision.blocker,
          intent: decision.intent,
          delegation: decision.delegation,
          capability: decision.capability,
          observation: decision.observation,
          evidence: decision.evidence,
        }),
        metadata: principalsToMetadata(principals) as any,
        timestamp: new Date(),
      },
    })
    .catch(() => {
      /* a missed receipt must never block or permit a mutation */
    })
}

/**
 * The compatibility path's own guard rail.
 *
 * These 30 finding types keep the behaviour they had before the gate existed,
 * with one correction: the deployment flag and the project dial are now
 * enforced HERE, at the mutation boundary. `runAutoFix` never checked them —
 * only `runReconciler` did — so a direct caller could execute with
 * `ENABLE_AUTONOMY_LIVE_EXECUTION=false`, which meant the operator's emergency
 * lever did not reach every path it was supposed to.
 *
 * Everything else about these repairs is unchanged: the circuit breaker, the
 * pre-snapshot, verification and recovery all still run inside the executor.
 * This is a bridge, and a bridge that quietly became more permissive than what
 * it replaced would be worse than the gap it was built to cover.
 */
export async function enforceLegacyCompatibility(
  projectId: string,
  findingType: string,
): Promise<{ allowed: boolean; reason: string | null }> {
  const { resolveExecutionMode } = await import('@/lib/autonomy/execution-mode')

  const level = await projectLevel(projectId)
  const mode = resolveExecutionMode(level)

  if (!mode.repairsAreApplied) {
    await recordCompatibilityUse(projectId, findingType, 'refused', mode.reason)
    return { allowed: false, reason: mode.explanation }
  }

  await recordCompatibilityUse(projectId, findingType, 'permitted', null)
  return { allowed: true, reason: null }
}

/**
 * Count the reliance rather than assume it.
 *
 * Every compatibility execution is recorded with `authorityPath`, so "how often
 * are we leaning on the bridge, and for what" is a query rather than a guess.
 * A migration plan that cannot measure what it is migrating tends not to finish.
 */
async function recordCompatibilityUse(
  projectId: string,
  findingType: string,
  outcome: 'permitted' | 'refused',
  reason: string | null,
): Promise<void> {
  const principals = await loopPrincipals(prisma, projectId, 'reconciler').catch(() => null)
  await prisma.auditLog
    .create({
      data: {
        projectId,
        action: 'AUTHORITY_LEGACY_COMPATIBILITY',
        type: 'autonomy',
        details: JSON.stringify({
          authorityPath: 'legacy_compatibility',
          findingType,
          narrowedBy: ['action_class_unregistered'],
          outcome,
          reason,
          note:
            'Executed under the enumerated legacy compatibility bridge. This type has ' +
            'no declared action class yet; see LEGACY_AUTONOMY_COMPAT_TYPES.',
        }),
        metadata: principals ? (principalsToMetadata(principals) as any) : undefined,
        timestamp: new Date(),
      },
    })
    .catch(() => {
      /* a missed receipt must never block or permit a mutation */
    })
}

/**
 * Make the repair follow the declared intent, not the executor's own inference.
 *
 * The Authority Decision authorizes a policy rewrite BECAUSE a declared intent
 * says who owns a row. Before this, the executor then chose the owner column
 * itself, by heuristic: `buildFixAction` resolves `template: 'auto'` against the
 * live schema. For a table with one owner-like column the two agree by accident;
 * for a table carrying both `user_id` and `owner_id` with an intent naming
 * `owner_id`, the decision would authorize and the executor would scope rows on
 * the wrong column. Authorization would be intent-aware and execution would not.
 *
 * `buildFixAction` already honours `details.userIdColumn` and
 * `details.rlsTemplate`, so this passes the intent's column through rather than
 * re-deriving it. Only for an authorization-shaped class, and only when the
 * decision says the intent was satisfied: anything else is returned unchanged,
 * so no other repair's behaviour moves.
 */
export function applyIntentToFixDetails(
  decision: AuthorityDecision,
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (decision.decision !== 'AUTO_EXECUTE') return details
  if (decision.actionClassId !== 'tighten_policy') return details
  const intent = decision.intent
  if (!intent?.satisfied || !intent.ownerColumn) return details
  return { ...details, rlsTemplate: 'own_rows', userIdColumn: intent.ownerColumn }
}
