/**
 * What a migration-runner task PROVED, read from its exit code and its logs.
 *
 * Shared by the staging and production launchers so the two cannot disagree
 * about what counts as success. Pure: no AWS, no database.
 *
 * The exit code is the authority for failure, and the logs are the authority
 * for success. A zero exit whose expected output never arrived is NOT a
 * success: the logs may be late, or the runner may have done something else.
 */

export type RunnerCommand = 'status' | 'deploy' | 'preflight' | 'verify' | 'baseline' | 'rollback'

export interface MigrationJobOutcome {
  exitCode: number
  observed: Record<string, boolean>
  message: string
}

export function readMigrationJobOutcome(
  command: RunnerCommand,
  text: string,
  containerExit: number | null,
): MigrationJobOutcome {
  const observed = {
    clean: /Database schema is up to date/i.test(text),
    noPending: /No pending migrations to apply/i.test(text),
    applied: /migration\(s\) have been applied|have been successfully applied/i.test(text),
    resolvedApplied: /marked as applied/i.test(text),
    preflightPassed: /PREFLIGHT PASSED/.test(text),
    preflightRefused: /refusing: ownership preflight failed/.test(text),
    absent: /ABSENT: \S+ left none of its declared effects behind/.test(text),
    rolledBack: /marked as rolled back\./i.test(text),
    verified: /VERIFIED: \S+ declared objects are all present/.test(text),
  }

  // `status` exits 1 when migrations are pending, which is an answer rather
  // than a failure, so it is passed through: the caller sees the code Prisma
  // chose.
  if (command === 'status') {
    return { exitCode: containerExit === 0 ? 0 : 1, observed, message: `status exited ${containerExit}` }
  }

  if (containerExit !== 0) {
    if (observed.preflightRefused) {
      return {
        exitCode: 1,
        observed,
        message:
          'REFUSED by the ownership preflight: the migration role cannot alter every migration-managed object. ' +
          'Nothing was applied and no migration history was written.',
      }
    }
    const where =
      command === 'deploy'
        ? 'the database may be partially migrated; read the Prisma error above'
        : 'read the runner output above'
    return { exitCode: 1, observed, message: `FAILED: ${command} exited ${containerExit}; ${where}` }
  }

  const proved =
    command === 'deploy' ? observed.preflightPassed && (observed.applied || observed.noPending)
    : command === 'preflight' ? observed.preflightPassed
    : command === 'verify' ? observed.verified
    : command === 'baseline' ? observed.resolvedApplied
    : /* rollback */ observed.absent && observed.rolledBack

  if (!proved) {
    return {
      exitCode: 1,
      observed,
      message: `FAILED: ${command} exited 0 but its outcome was never observed in the logs`,
    }
  }
  return { exitCode: 0, observed, message: `${command}: proved` }
}
