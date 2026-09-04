/**
 * The prerequisite chain, defined once.
 *
 * The README quickstart is the acceptance script for a self-hosted install, so
 * a README that drifts from what `npm run bootstrap` prints is worse than no
 * README at all: it walks an operator down a path that does not reach a working
 * data plane. This chain has already caused that twice, both times found only
 * by executing it rather than reading it — a hardcoded application role, and
 * then a set of PostgreSQL roles that nothing in the repository created.
 *
 * So the steps live here, and __tests__/bootstrap/readme-matches-bootstrap.test.ts
 * asserts that both the script's output and README.md carry these commands, in
 * this order. Adding a step without documenting it fails the build.
 */

/**
 * What README.md writes where bootstrap prints the deployment's real id.
 *
 * A literal id in the README would be a different string on every deployment,
 * so the comparison substitutes this before matching.
 */
export const PROJECT_ID_PLACEHOLDER = '<PROJECT_ID>'

/**
 * Bootstrap's exit codes, which are a state machine and not a success flag.
 *
 * Defined here and USED by the script, so this is the value that runs rather
 * than a second description of it. The README documents these, and the test
 * asserts it documents all of them, so adding a state forces the documentation.
 */
export const BOOTSTRAP_EXIT = {
  /** Provisioned and operational. */
  ready: 0,
  /**
   * Refused before writing anything: more than one project, or a pinned
   * BACKENLY_PROJECT_ID that does not match what the database already holds.
   */
  refused: 2,
  /**
   * Core bootstrapped, prerequisites unmet. NOT ready — the data plane answers
   * PGRST106 until they are installed. Distinct from `ready` because a script
   * that prints warnings and exits 0 reads as success to every CI runner alive.
   */
  incomplete: 3,
} as const

export interface PrerequisiteStep {
  /** One line, above the command: why this step exists. */
  readonly note: string
  /** Typed verbatim by the operator. Absent when the step is not a command. */
  readonly command?: string
  /** A second route to the same end, when one exists. */
  readonly alternative?: string
}

/**
 * Unmet-prerequisite guidance for the PostgREST data plane.
 *
 * The ordering is not arbitrary and cannot be collapsed into one step.
 * setup-postgrest-roles.ts grants per workspace schema, so it needs the project
 * to exist, which means bootstrap must have run first and reported NOT ready.
 * Rerunning is the mechanism, not a workaround: bootstrap is a reconciler.
 */
export function postgrestPrerequisiteSteps(projectId: string): PrerequisiteStep[] {
  return [
    {
      note: 'if the role in your DATABASE_URL is NOT `backenly_user`:',
      command: `psql -c "ALTER DATABASE <db> SET backenly.app_role = '<your role>'"`,
    },
    {
      // Creating the roles is part of installing the SQL because its event
      // triggers grant to them: on a cluster that lacks them, the CREATE SCHEMA
      // those triggers fire on aborts, and step 2 cannot run until that schema
      // exists. Installing them here is what breaks that cycle.
      note: 'install the support objects, which also creates the PostgREST roles',
      command: 'bash scripts/postgrest-install.sh',
      alternative: 'psql -f scripts/sql/postgrest-schema-registry.sql, then postgrest-ddl-sync.sql',
    },
    {
      note: 'passwords, role membership and the per-schema grants',
      command: `npx tsx scripts/setup-postgrest-roles.ts --project ${projectId} --apply`,
    },
    {
      // No command: the binary, its config file and its service manager are the
      // operator's, and inventing one here would be guessing at their machine.
      note: 'start PostgREST against the connection string step 2 prints',
    },
  ]
}

/**
 * Direct database access: the `bkn_ro_`/`bkn_rw_` roles an operator hands out
 * as a psql connection string.
 *
 * Deliberately NOT part of the chain above. Backenly is fully operational
 * without it, so it is reported as its own unmet prerequisite rather than
 * folded into the data-plane steps, where it would read as required.
 */
export const DIRECT_ACCESS_PREREQUISITE: PrerequisiteStep = {
  note: 'privileged role helpers, for handing out direct database credentials',
  command: 'psql -d <database> -f scripts/setup-direct-access.sql',
}

/** Every command in the chain, in order. The list the README is checked against. */
export function prerequisiteCommands(projectId: string): string[] {
  return [...postgrestPrerequisiteSteps(projectId), DIRECT_ACCESS_PREREQUISITE]
    .map(s => s.command)
    .filter((c): c is string => Boolean(c))
}

/** Renders the steps into the block bootstrap prints under an unmet prerequisite. */
export function renderPrerequisiteSteps(steps: readonly PrerequisiteStep[]): string {
  const lines: string[] = ['As a superuser, in order:']
  steps.forEach((s, i) => {
    lines.push(`         ${i}. ${s.note}`)
    if (s.command) lines.push(`            ${s.command}`)
    if (s.alternative) lines.push(`            (or: ${s.alternative})`)
  })
  lines.push('       then rerun: npm run bootstrap')
  return lines.join('\n')
}
