/**
 * THE MAINTENANCE ENTRY POINT — one plan, named explicitly, three modes
 * =====================================================================
 *
 *   npx tsx scripts/run-maintenance-plan.ts \
 *     --project <id> --finding <id> --plan <id> --plan-version <hash> \
 *     --mode dry-run
 *
 *   npx tsx scripts/run-maintenance-plan.ts  *     --project <id> --finding <id> --plan <id> --plan-version <hash>  *     --mode observe --execution <id> [--window-ms <ms>]
 *
 *   ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS=true \
 *   npx tsx scripts/run-maintenance-plan.ts \
 *     --project <id> --finding <id> --plan <id> --plan-version <hash> \
 *     --mode execute --bindings <file.json> \
 *     --confirm "<project>:<plan>:<planVersion>"
 *
 * ── It discovers nothing ────────────────────────────────────────────────────
 *
 * Every identifier is supplied. There is no "run all eligible maintenance" and
 * there must not be until one plan has gone end to end in production: that
 * function is a scheduler, and a scheduler turns this from "one controlled
 * exercise" into "autonomous for everyone" in a single commit.
 *
 * ── The identifiers are assertions ──────────────────────────────────────────
 *
 * Plans are not stored. `--plan` and `--plan-version` are checked against a
 * freshly rebuilt plan, and a mismatch refuses. Since `planVersion` covers the
 * ladder, the catalog fingerprint and the capability table, a mismatch means one
 * of those moved since the operator read them — which is when a plan should not
 * run, not something to reconcile silently.
 *
 * ── The CLI can only narrow permission ──────────────────────────────────────
 *
 * `--mode execute` does not enable mutations. It asks to use permission the
 * ENVIRONMENT already granted through `ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS`,
 * and refuses when that flag is off. There is no argument to this script that
 * can turn writing on, which is what keeps "someone ran a command" and "this
 * deployment may write" separate facts.
 */

import { readFileSync } from 'node:fs'
import { FLAGS } from '@/lib/config/flags'
import { DEFAULT_LEVEL, type AutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { dryRunPlan } from '@/lib/autonomy/maintenance/dry-run'
import { executeMaintenancePlan, type StepBinding } from '@/lib/autonomy/maintenance/execute'
import { isRefusal, resolveMaintenancePlan } from '@/lib/autonomy/maintenance/resolve'
import { OPTIONAL_TERMINAL_STEPS } from '@/lib/autonomy/maintenance/step'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

/**
 * Which database did we actually connect to?
 *
 * The launcher checks that the secret's ARN names a production resource, but
 * that is a check on a pointer: it passes whether or not the secret's contents
 * point where the ARN suggests. This is the check on the connection, and it is
 * the same guard `tools/managed-db/runner/entrypoint.sh` applies to migrations,
 * for the same reason — a mutation lands in whatever it reaches.
 *
 * Parsed after the LAST '@' so a password containing '/' cannot shift the
 * fields. A URL with no path yields host:port, which matches nothing and
 * refuses: the failure direction we want.
 */
function assertExpectedDatabase(): void {
  const expected = process.env.EXPECT_DATABASE?.trim()
  if (!expected) return
  const url = process.env.DATABASE_URL ?? ''
  if (!url) die('EXPECT_DATABASE is set but DATABASE_URL is empty')
  const actual = url.slice(url.lastIndexOf('@') + 1).replace(/^[^/]*\/?/, '').split('?')[0]
  if (actual !== expected) die(`connected database is "${actual}", expected "${expected}"`)
  console.error(`  database: ${actual} (matches EXPECT_DATABASE)`)
}

async function main(): Promise<void> {
  const projectId = arg('--project')
  const findingId = arg('--finding')
  const planId = arg('--plan')
  const planVersion = arg('--plan-version')
  const mode = arg('--mode')

  if (!projectId || !findingId || !planId || !planVersion) {
    die('--project, --finding, --plan and --plan-version are all required; this script discovers nothing')
  }
  if (mode !== 'dry-run' && mode !== 'execute' && mode !== 'observe') {
    die('--mode must be dry-run, execute or observe')
  }
  // observe's own arguments, checked here with the rest of the database-free
  // preconditions. A run that cannot proceed must not read a production
  // catalog to discover that.
  if (mode === 'observe') {
    if (!arg('--execution')) die('--execution <id> is required for --mode observe')
    const w = Number(arg('--window-ms') ?? 15 * 60 * 1000)
    if (!Number.isFinite(w) || w <= 0) die('--window-ms must be a positive number')
  }
  if (arg('--bindings') && arg('--bindings-json')) die('pass --bindings or --bindings-json, not both')

  // Before anything reads or writes. Applies to dry-run too: a report about the
  // wrong database is worse than no report.
  assertExpectedDatabase()

  // Every precondition that does not need the database is checked FIRST, so a
  // run that cannot proceed never reads a production catalog to find that out.
  // It also means these refusals are reachable without a database at all, which
  // is how they are tested.
  if (mode === 'execute') {
    if (!FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS) {
      die(
        'ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is not set in this environment. ' +
          'No argument to this script can turn mutations on.',
      )
    }
    const expected = `${projectId}:${planId}:${planVersion}`
    if (arg('--confirm') !== expected) die(`--confirm must be exactly "${expected}"`)
    if (!arg('--bindings') && !arg('--bindings-json')) {
      die('--bindings <file.json> or --bindings-json <json> is required to execute: the executor takes typed data, never generated SQL')
    }
  }

  const resolved = await resolveMaintenancePlan({ projectId, findingId })
  if (isRefusal(resolved)) die(resolved.refusal)

  const { plan, catalogFingerprint, table } = resolved

  // The assertions. Checked before anything else looks at the plan.
  if (plan.planId !== planId) {
    die(`plan id is ${plan.planId}, not ${planId}; the finding or its subsystem changed`)
  }
  if (plan.planVersion !== planVersion) {
    die(
      `plan version is ${plan.planVersion}, not ${planVersion}. planVersion covers the ladder, the ` +
        'catalog fingerprint and the executor capability table, so one of those moved. Re-read the plan.',
    )
  }

  const autonomyLevel = (process.env.AUTONOMY_LEVEL as AutonomyLevel) || DEFAULT_LEVEL
  const approvedPlanVersion = process.env.MAINTENANCE_APPROVED_PLAN_VERSION?.trim() || null
  const approvalId = process.env.MAINTENANCE_APPROVAL_ID?.trim() || null

  // A file locally; inline JSON in a container, which has no file to read.
  //
  // Bindings are the one thing that cannot be rebuilt from the database: they
  // are the operator's mapping from a plan's abstract params to real columns.
  // The PLAN is still rebuilt rather than transported — only this mapping
  // crosses the boundary, and it is typed data, never SQL.
  const bindingsPath = arg('--bindings')
  const bindingsJson = arg('--bindings-json')
  const bindings: Record<number, StepBinding> | undefined = bindingsJson
    ? JSON.parse(bindingsJson)
    : bindingsPath
      ? JSON.parse(readFileSync(bindingsPath, 'utf8'))
      : undefined

  // The column the ladder is about, used to inventory readers. Taken from the
  // binding rather than guessed, so the report describes the same column the
  // execution would touch.
  const sourceColumn = (() => {
    for (const b of Object.values(bindings ?? {})) {
      if ('sourceColumn' in b) return b.sourceColumn
    }
    return null
  })()

  if (mode === 'dry-run') {
    const report = await dryRunPlan({
      plan,
      projectId,
      table,
      sourceColumn: sourceColumn ?? '',
      // Omitted on purpose: the dry run reads the catalog itself.
      autonomyLevel,
      approvedPlanVersion,
      // Read, never set. A dry run reports on the environment it found.
      mutationsEnvironmentEnabled: FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS,
      bindings,
    })
    console.log(JSON.stringify(report, null, 2))
    // Exit 0 for any report that was produced: "would refuse" is an answer, and
    // a non-zero exit would make a correct refusal look like a broken run.
    process.exit(0)
  }

  // ── execute ────────────────────────────────────────────────────────────────
  //
  // ── observe ────────────────────────────────────────────────────────────────
  //
  // The window after a reader switch, and the repair's effect on the subsystem.
  //
  // Phase 7 asks whether moving the readers made anything worse and restores
  // the recorded bytes if it did. Phase 8 asks whether the repair helped at
  // all. Both were built and neither had a caller, which meant the switch had
  // no observation window in practice and no outcome was ever measured — the
  // two properties that make a reader switch reversible and a remedy learnable.
  //
  // One execution, named explicitly, like everything else here. It resolves the
  // plan first, so it inherits every identity assertion the other modes get.
  if (mode === 'observe') {
    // Both already validated above, before any database read.
    const executionId = arg('--execution')!
    const windowMs = Number(arg('--window-ms') ?? 15 * 60 * 1000)

    const { prisma } = await import('@/lib/db')
    const execution = await prisma.maintenanceExecution.findUnique({
      where: { id: executionId },
      select: { id: true, projectId: true, planId: true, completedAt: true, createdAt: true },
    })
    if (!execution) die(`execution ${executionId} does not exist`)
    if (execution.projectId !== projectId) {
      die(`execution ${executionId} belongs to project ${execution.projectId}, not ${projectId}`)
    }
    if (execution.planId !== planId) {
      die(`execution ${executionId} is for plan ${execution.planId}, not ${planId}`)
    }

    const switchStep = await prisma.maintenanceStepExecution.findFirst({
      where: { executionId, stepKind: 'switch_readers', status: 'completed' },
      select: { result: true, completedAt: true },
    })
    if (!switchStep) die(`execution ${executionId} has no completed switch_readers step to observe`)

    const switched = ((switchStep.result as { switchedReaders?: unknown })?.switchedReaders ?? []) as Array<{
      id: string
      name: string
      previousCode: string
    }>
    const switchedAt = switchStep.completedAt ?? execution.completedAt ?? execution.createdAt

    const { observeSwitch } = await import('@/lib/autonomy/maintenance/observe')
    const { measureRepairOutcome } = await import('@/lib/autonomy/maintenance/outcome')

    const observation = await observeSwitch(projectId, switchedAt, windowMs)
    const outcome = await measureRepairOutcome(projectId, switchedAt, windowMs)

    // A regression reverts. The bytes come from the ledger row the switch
    // wrote, so this restores exactly what was there and never regenerates it.
    let reverted: { reverted: number; failures: string[] } | null = null
    // `shouldRevert`, not a re-derivation of it. observe.ts documents it as
    // "the revert trigger, stated once", and deciding again here is how the
    // caller and the module come to disagree. The first version of this read
    // `observation.verdict`, which does not exist, so it was silently never
    // true and a regressed production run reverted nothing.
    if (observation.shouldRevert) {
      if (!FLAGS.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS) {
        console.log('  regression observed, and mutations are disabled here, so nothing was reverted')
      } else {
        const { revertReaders } = await import('@/lib/autonomy/maintenance/primitives/switch-readers')
        reverted = await revertReaders(switched)
      }
    }

    console.log(
      JSON.stringify(
        {
          executionId,
          switchedAt,
          windowMs,
          readersObserved: switched.length,
          observation,
          // Phase 8. Ranking and priors only; it can never change detection
          // truth, an approval requirement, or a safety tier.
          outcome,
          reverted,
        },
        null,
        2,
      ),
    )
    process.exit(observation.shouldRevert && !reverted ? 1 : 0)
  }

  // The environment flag and the confirmation were checked above, before the
  // database was touched. What is left needs the resolved plan.

  if (!bindings) die('--bindings <file.json> or --bindings-json <json> is required to execute')

  const needed = plan.steps.filter(s => !OPTIONAL_TERMINAL_STEPS.includes(s.kind))
  for (const s of needed) {
    if (bindings[s.ordinal]?.kind !== s.kind) {
      die(`step ${s.ordinal} is ${s.kind} but its binding is ${bindings[s.ordinal]?.kind ?? 'missing'}`)
    }
  }

  console.log(`\nMaintenance execution — ${projectId} ${planId}@${planVersion}\n`)
  const outcome = await executeMaintenancePlan({
    plan,
    projectId,
    // Omitted on purpose: the executor reads the catalog itself.
    autonomyLevel,
    bindings,
    approvedPlanVersion,
    approvalId,
    // Not a permission: this ANDs with the environment flag, which was already
    // checked above. Passing true here cannot widen anything.
    mutationsEnabled: true,
  })

  console.log(JSON.stringify(outcome, null, 2))
  for (const s of outcome.steps) {
    console.log(`  ${String(s.ordinal).padStart(2)} ${s.kind.padEnd(16)} ${s.status.padEnd(16)} ${s.detail}`)
  }
  console.log(`\n  ${outcome.status}${outcome.haltReason ? `: ${outcome.haltReason}` : ''}`)

  process.exit(outcome.status === 'completed' ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
