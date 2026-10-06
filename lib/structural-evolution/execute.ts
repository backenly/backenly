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
 *   mutations are off by default       FLAGS.ENABLE_EVOLUTION_MUTATIONS, ANDed
 *                                      with the caller's wish, never ORed
 *
 * Rollback is NOT automatic. A failed rung halts the ladder and records why;
 * undoing is a separate decision (./rollback.ts) with its own guard.
 */

import { prisma } from '@/lib/db'
import { FLAGS } from '@/lib/config/flags'
import { withMaintenanceSingleFlight } from '@/lib/autonomy/maintenance/single-flight'
import { enqueue } from '@/lib/queue'
import { readLiveEvolutionApproval } from './consent'
import { requiredTier, type ExtractionPlan, type ExtractionStep } from './plan'
import { runStep, rungAlreadyApplied } from './primitives'
import { inspectEvolutionChain } from './backfill-job'
import { resolveExtractionPlan, isResolveRefusal } from './resolve'

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
  steps: ExtractionStepOutcome[]
}

const NON_MUTATING: ReadonlyArray<ExtractionStep['kind']> = ['rehearse', 'verify']

export async function executeExtraction(input: {
  projectId: string
  planId: string
  /** ANDed with FLAGS.ENABLE_EVOLUTION_MUTATIONS. A caller can narrow, never widen. */
  mutationsEnabled?: boolean
}): Promise<ExtractionRunOutcome> {
  const flight = await withMaintenanceSingleFlight(input.projectId, () => runLadder(input))
  if (!flight.ran) {
    return {
      status: 'in_flight_elsewhere',
      executionId: null,
      planVersion: null,
      haltReason: 'another process is already running a ladder on this project',
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
  const mutationsEnabled = (input.mutationsEnabled ?? true) && FLAGS.ENABLE_EVOLUTION_MUTATIONS

  const refuse = async (reason: string, plan?: ExtractionPlan): Promise<ExtractionRunOutcome> => {
    const executionId = plan ? await openExecution(projectId, plan, 'refused', reason) : null
    return { status: 'refused', executionId, planVersion: plan?.planVersion ?? null, haltReason: reason, steps: [] }
  }

  const approval = await readLiveEvolutionApproval(projectId, planId)
  if (!approval) return refuse('nobody has consented to this extraction, or the consent was withdrawn')

  const resolved = await resolveExtractionPlan(projectId, approval.spec)
  if (isResolveRefusal(resolved)) return refuse(resolved.refusal)
  const { plan } = resolved

  if (plan.planId !== planId) return refuse('the approved spec does not describe this plan')
  if (plan.planVersion !== approval.planVersion) {
    return refuse(
      `the plan rebuilt from the live catalog is version ${plan.planVersion}, and consent is for ${approval.planVersion}. ` +
        `${plan.spec.host} or its access changed since it was approved; it has to be re-read and re-approved.`,
      plan,
    )
  }
  if (plan.validity !== 'executable') {
    return refuse(`the plan is ${plan.validity}: ${plan.blockedReasons.join('; ')}`, plan)
  }
  const tier = requiredTier(plan)
  if (tier > approval.maxTier) return refuse(`the ladder needs tier ${tier} and consent covers ${approval.maxTier}`, plan)

  const executionId = await openExecution(projectId, plan, 'running', null, approval.id)
  const steps: ExtractionStepOutcome[] = []

  for (const step of plan.steps) {
    if (step.capability === 'human_only') {
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'awaiting_human', detail: step.why })
      continue
    }
    if (step.capability !== 'implemented') {
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) is ${step.capability}`)
    }

    // Consent is re-read here, not remembered from the top of the ladder.
    const live = await readLiveEvolutionApproval(projectId, planId)
    if (!live || live.planVersion !== plan.planVersion) {
      return halt(executionId, plan, steps, `consent for version ${plan.planVersion} was withdrawn before step ${step.ordinal} (${step.kind})`)
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
          return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) is paused and mutations are disabled for this run`)
        }
        const resumed = await enqueue('evolution_backfill', job.resumeFrom as unknown as Record<string, unknown>, { projectId })
        await prisma.maintenanceStepExecution.update({ where: { id: existing.id }, data: { backgroundJobId: resumed.id } })
        steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'dispatched', detail: `resumed from key ${job.resumeFrom.cursor ?? 'start'} as job ${resumed.id}` })
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
        return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) failed: ${job.detail}`)
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
      const adopted = await rungAlreadyApplied(plan, step)
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
        preconditionEvidence: { declared: step.preconditions, tier: step.tier, sql: step.sql },
        rollback: step.rollback ? { ...step.rollback } : undefined,
        resourceIdentity: { kind: 'extraction', schema: plan.schema, host: plan.spec.host, satellite: plan.spec.satellite },
      },
      update: { executionId, status: 'running', startedAt: new Date() },
    })

    let outcome
    try {
      outcome = await runStep(projectId, plan, step)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.maintenanceStepExecution.update({
        where: { id: row.id },
        data: { status: 'failed', completedAt: new Date(), result: { error: message } },
      })
      steps.push({ ordinal: step.ordinal, kind: step.kind, status: 'failed', detail: message })
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) threw: ${message}`)
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
      return halt(executionId, plan, steps, `step ${step.ordinal} (${step.kind}) failed: ${outcome.detail}`)
    }
  }

  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'completed', completedAt: new Date(), haltReason: null },
  })
  return { status: 'completed', executionId, planVersion: plan.planVersion, haltReason: null, steps }
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
): Promise<ExtractionRunOutcome> {
  await prisma.maintenanceExecution.update({
    where: { id: executionId },
    data: { status: 'halted', haltReason: reason, completedAt: new Date() },
  })
  return { status: 'halted', executionId, planVersion: plan.planVersion, haltReason: reason, steps }
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
  return { status: 'awaiting_background_work', executionId, planVersion: plan.planVersion, haltReason: reason, steps }
}
