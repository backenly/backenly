/**
 * THE GOVERNED EXECUTOR — the only thing that runs an extraction ladder
 * ====================================================================
 *
 * Mirrors `lib/autonomy/maintenance/execute.ts` deliberately, rule for rule,
 * because the risks are the same and a second set of rules for "a robot changes
 * a production schema" would be the one somebody forgets to harden:
 *
 *   one ladder per project at a time   the SAME advisory lock maintenance uses,
 *                                      so an extraction and a maintenance
 *                                      ladder can never interleave on one
 *                                      schema either
 *   the plan is rebuilt, not trusted   from the approved spec and the live
 *                                      catalog, at the start of every attempt;
 *                                      a version that no longer matches the
 *                                      consent refuses
 *   consent is re-read per rung        a withdrawal stops the rung that has
 *                                      not started, not just the ladder that
 *                                      has not begun
 *   all-or-nothing                     a ladder that is not executable runs no
 *                                      rung, including a runnable prefix
 *   dispatched is not done             the backfill hands off to BackgroundJob
 *                                      and the ladder stops until it finishes
 *   tier 3 is never run                `contract` is reached, recorded as a
 *                                      person's to do, and left
 *   mutations are off by default       FLAGS.ENABLE_EVOLUTION_MUTATIONS and the
 *                                      rollout's project list, ANDed with the
 *                                      caller's wish, never ORed
 *
 * Rollback is NOT automatic. A failed rung halts the ladder and records why;
 * undoing is a separate decision (./rollback.ts) with its own guard.
 */

import { prisma } from '@/lib/db'
import { FLAGS, evolutionAllowedFor } from '@/lib/config/flags'
import { withMaintenanceSingleFlight } from '@/lib/autonomy/maintenance/single-flight'
import { readLiveEvolutionApproval } from './consent'
import { requiredTier, type ExtractionPlan, type ExtractionStep } from './plan'
import { runStep, rungAlreadyApplied } from './primitives'
import { inspectEvolutionChain, queueEvolutionBackfill, stoppedForDrift } from './backfill-job'
import type { StopReason } from '@/lib/evolution-engine/primitive'
import { resolveExtractionPlan, isResolveRefusal } from './resolve'
import { workspaceAt } from './workspace'
import { dbWords, keptStatements } from './residency'

export type ExtractionRunStatus =
  | 'completed'
  | 'halted'
  | 'refused'
  | 'awaiting_background_work'
  | 'in_flight_elsewhere'

export interface ExtractionStepOutcome {
  ordinal: number
  kind: ExtractionStep['kind']
  status: 'completed' | 'dispatched' | 'skipped' | 'failed' | 'awaiting_human'
  detail: string
}

export interface ExtractionRunOutcome {
  status: ExtractionRunStatus
  executionId: string | null
  planVersion: string | null
  haltReason: string | null
  /** Why it stopped short, when it did: decides "paused, needs you" from "a step failed". */
  stoppedBecause: StopReason | null
  steps: ExtractionStepOutcome[]
}

const NON_MUTATING: ReadonlyArray<ExtractionStep['kind']> = ['rehearse', 'verify']

export async function executeExtraction(input: {
  projectId: string
  planId: string
  /** ANDed with FLAGS.ENABLE_EVOLUTION_MUTATIONS and evolutionAllowedFor. A caller can narrow, never widen. */
  mutationsEnabled?: boolean
}): Promise<ExtractionRunOutcome> {
  const flight = await withMaintenanceSingleFlight(input.projectId, () => runLadder(input))
  if (!flight.ran) {
    return {
      status: 'in_flight_elsewhere',
      executionId: null,
      planVersion: null,
      haltReason: 'another process is already running a ladder on this project',
      stoppedBecause: null,
      steps: [],
    }
  }
  return flight.value
}

async function runLadder(input: {
  projectId: string
  planId: string
  mutationsEnabled?: boolean
}): Promise<ExtractionRunOutcome> {
  const { projectId, planId } = input
  const mutationsEnabled = (input.mutationsEnabled ?? true) && FLAGS.ENABLE_EVOLUTION_MUTATIONS && evolutionAllowedFor(projectId)

  const refuse = async (reason: string, because: StopReason, plan?: ExtractionPlan): Promise<ExtractionRunOutcome> => {
    const executionId = plan ? await openExecution(projectId, plan, 'refused', reason) : null
    return { status: 'refused', executionId, planVersion: plan?.planVersion ?? null, haltReason: reason, stoppedBecause: because, steps: [] }
  }

  const approval = await readLiveEvolutionApproval(projectId, planId)
  if (!approval) return refuse('nobody has consented to this extraction, or the consent was withdrawn', 'consent')

  const resolved = await resolveExtractionPlan(projectId, approval.spec)
  if (isResolveRefusal(resolved)) return refuse(resolved.refusal, 'drift')
  const { plan } = resolved

  if (plan.planId !== planId) return refuse('the approved spec does not describe this plan', 'drift')
  if (plan.planVersion !== approval.planVersion) {
    return refuse(
      `the plan rebuilt from the live catalog is version ${plan.planVersion}, and consent is for ${approval.planVersion}. ` +
        `${plan.spec.host} or its access changed since it was approved; it has to be re-read and re-approved.`,
      'drift',
      plan,
    )
  }
  if (plan.validity !== 'executable') {
    return refuse(`the plan is ${plan.validity}: ${plan.blockedReasons.join('; ')}`, 'capability', plan)
  }
  const tier = requiredTier(plan)
  if (tier > approval.maxTier) return refuse(`the ladder needs tier ${tier} and consent covers ${approval.maxTier}`, 'consent', plan)

  const executionId = await openExecution(projectId, plan, 'running', null, approval.id)
  const steps: ExtractionStepOutcome[] = []
  // The project's tables, where they live (./workspace.ts), and what its
  // records at home may quote of the work (./residency.ts).
  const at = await workspaceAt(projectId)
  const { quote } = at
  // Every rung's schema change is a governed change (lib/changes/ledger.ts),
  // recorded as the person whose consent is bound to this exact plan version,
  // and grouped with the rest of this extraction's changes.
  const { withChangeAttribution } = await import('@/lib/changes/attribution')
  const { ChangeInProgressError } = await import('@/lib/changes/lock')
  const asApproved = <T>(fn: () => Promise<T>) =>
    withChangeAttribution({ source: 'approval', actorUserId: approval.approvedBy, groupId: `evolution:${planId}` }, fn)

  for (const step of plan.steps) {
    if (step.capability === 'human_only') {
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'awaiting_human', detail: step.why })
      continue
    }
    if (step.capability !== 'implemented') {
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) is ${step.capability}`, 'capability')
    }

    // Consent is re-read here, not remembered from the top of the ladder.
    const live = await readLiveEvolutionApproval(projectId, planId)
    if (!live || live.planVersion !== plan.planVersion) {
      return halt(executionId, plan, steps, `consent for version ${plan.planVersion} was withdrawn before step ${step.ordinal} (${step.kind})`, 'consent')
    }

    const existing = await prisma.maintenanceStepExecution.findUnique({ where: { idempotencyKey: step.idempotencyKey } })
    if (existing?.status === 'completed') {
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'skipped', detail: 'already applied under this plan version' })
      continue
    }
    if (existing?.status === 'dispatched' && existing.backgroundJobId) {
      const job = await inspectEvolutionChain(projectId, plan.planVersion, existing.backgroundJobId)
      if (job.state === 'paused' && job.resumeFrom) {
        // Paused by a withdrawn consent that is live again (re-read above):
        // the stopped batch is queued again exactly as it was, cursor and all.
        if (!mutationsEnabled) {
          return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) is paused and mutations are disabled for this run`, 'mutations_disabled')
        }
        const resumed = await queueEvolutionBackfill(job.resumeFrom)
        await prisma.maintenanceStepExecution.update({ where: { id: existing.id }, data: { backgroundJobId: resumed.id } })
        // The key it stopped at is a row's own value: not quoted in the ledger.
        steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'dispatched', detail: `resumed where it stopped, as job ${resumed.id}` })
        return awaiting(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) resumed as job ${resumed.id}`)
      }
      if (job.state === 'pending') {
        steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'dispatched', detail: job.detail })
        return awaiting(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) is waiting on job ${existing.backgroundJobId}`)
      }
      if (job.state === 'failed') {
        await prisma.maintenanceStepExecution.update({
          where: { id: existing.id },
          data: { status: 'failed', completedAt: new Date(), result: { error: job.detail } },
        })
        steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'failed', detail: job.detail })
        // A backfill that stopped because the table changed shape is drift, not a broken step.
        return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) failed: ${job.detail}`, stoppedForDrift(job.detail, plan.spec.host) ? 'drift' : 'rung_failed')
      }
      await prisma.maintenanceStepExecution.update({
        where: { id: existing.id },
        data: { status: 'completed', completedAt: new Date(), result: { resumed: true, detail: job.detail } },
      })
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'completed', detail: job.detail })
      continue
    }

    // The previous attempt may have committed this rung and stopped before the
    // ledger heard; a rung that cannot simply run twice is adopted instead.
    if (existing?.status === 'running') {
      const adopted = await rungAlreadyApplied(at, plan, step)
      if (adopted) {
        await prisma.maintenanceStepExecution.update({
          where: { id: existing.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            observedPostState: adopted.observed as object,
            postconditionEvidence: { declared: step.postconditions, detail: adopted.detail },
            result: { detail: adopted.detail, adopted: true },
          },
        })
        steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'completed', detail: adopted.detail })
        continue
      }
    }

    if (!NON_MUTATING.includes(step.kind) && !mutationsEnabled) {
      return halt(
        executionId,
        plan,
        steps,
        `step ${step.ordinal} (${step.kind}) would change the live schema and mutations are disabled for this run`,
        'mutations_disabled',
      )
    }

    const row = await prisma.maintenanceStepExecution.upsert({
      where: { idempotencyKey: step.idempotencyKey },
      create: {
        executionId,
        stepId: String(step.ordinal),
        stepKind: step.kind,
        ordinal: step.ordinal,
        idempotencyKey: step.idempotencyKey,
        status: 'running',
        startedAt: new Date(),
        // For a project kept elsewhere the statements stay out of this row: the
        // plan renders them, and planVersion, which consent binds to, hashes them.
        preconditionEvidence: {
          declared: step.preconditions,
          tier: step.tier,
          sql: keptStatements(step.sql, quote),
          ...(quote ? {} : { sqlWithheld: true }),
        },
        rollback: step.rollback ? { ...step.rollback, sql: keptStatements(step.rollback.sql, quote) } : undefined,
        resourceIdentity: { kind: 'extraction', schema: plan.schema, host: plan.spec.host, satellite: plan.spec.satellite },
      },
      update: { executionId, status: 'running', startedAt: new Date() },
    })

    let outcome
    try {
      outcome = await asApproved(() => runStep(projectId, plan, step))
    } catch (err) {
      if (err instanceof ChangeInProgressError) {
        // Another governed change holds the project's change lock, so this rung
        // did not start. Not a failure of the rung: it runs after that change.
        await prisma.maintenanceStepExecution.update({ where: { id: row.id }, data: { status: 'pending', startedAt: null } })
        await prisma.maintenanceExecution.update({
          where: { id: executionId },
          data: { status: 'halted', haltReason: err.message, completedAt: new Date() },
        })
        return { status: 'in_flight_elsewhere', executionId, planVersion: plan.planVersion, haltReason: err.message, stoppedBecause: null, steps }
      }
      const message = dbWords(err, quote)
      await prisma.maintenanceStepExecution.update({
        where: { id: row.id },
        data: { status: 'failed', completedAt: new Date(), result: { error: message } },
      })
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'failed', detail: message })
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) threw: ${message}`, 'rung_failed')
    }

    await prisma.maintenanceStepExecution.update({
      where: { id: row.id },
      data: {
        status: outcome.status,
        completedAt: new Date(),
        backgroundJobId: outcome.backgroundJobId ?? null,
        postconditionEvidence: { declared: step.postconditions, detail: outcome.detail },
        observedPostState: (outcome.observed ?? undefined) as object | undefined,
        result: JSON.parse(JSON.stringify({ detail: outcome.detail, ...(outcome.evidence ?? {}) })),
      },
    })
    steps.push({ ordinal: step.ordinal, kind: step.kind, status: outcome.status, detail: outcome.detail })

    if (outcome.status === 'dispatched') {
      return awaiting(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) dispatched job ${outcome.backgroundJobId}; run again once it completes`)
    }
    if (outcome.status === 'failed') {
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) failed: ${outcome.detail}`, step.kind === 'verify' ? 'verification' : 'rung_failed')
    }
  }

  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'completed', completedAt: new Date(), haltReason: null },
  })
  return { status: 'completed', executionId, planVersion: plan.planVersion, haltReason: null, stoppedBecause: null, steps }
}

async function openExecution(
  projectId: string,
  plan: ExtractionPlan,
  status: string,
  haltReason: string | null,
  approvalId: string | null = null,
): Promise<string> {
  const last = await prisma.maintenanceExecution.findFirst({
    where: { planId: plan.planId },
    orderBy: { planVersion: 'desc' },
    select: { planVersion: true },
  })
  const row = await prisma.maintenanceExecution.create({
    data: {
      projectId,
      findingId: plan.proposalKey,
      planId: plan.planId,
      // An attempt counter, as in the maintenance ledger: the content hash is
      // the approval's to hold, and (planId, attempt) is what must be unique.
      planVersion: (last?.planVersion ?? 0) + 1,
      catalogFingerprint: plan.basisFingerprint,
      approvalId,
      tier: String(requiredTier(plan)),
      status,
      haltReason,
      startedAt: status === 'running' ? new Date() : null,
      completedAt: status === 'refused' ? new Date() : null,
    },
  })
  return row.id
}

async function halt(
  executionId: string,
  plan: ExtractionPlan,
  steps: ExtractionStepOutcome[],
  reason: string,
  because: StopReason,
): Promise<ExtractionRunOutcome> {
  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'halted', haltReason: reason, completedAt: new Date() },
  })
  return { status: 'halted', executionId, planVersion: plan.planVersion, haltReason: reason, stoppedBecause: because, steps }
}

async function awaiting(
  executionId: string,
  plan: ExtractionPlan,
  steps: ExtractionStepOutcome[],
  reason: string,
): Promise<ExtractionRunOutcome> {
  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'awaiting_background_work', haltReason: reason },
  })
  return { status: 'awaiting_background_work', executionId, planVersion: plan.planVersion, haltReason: reason, stoppedBecause: null, steps }
}
