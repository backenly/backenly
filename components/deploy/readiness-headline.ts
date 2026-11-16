/**
 * The Deploy page's Readiness section, said honestly.
 *
 * It counted passes against every check and was green whenever nothing
 * blocked, so failing warnings read as "9 of 11 passing" in green, and a
 * check that was skipped (nothing to check yet) counted as one that failed.
 * Production QA (2026-11-09, report 86) read the card as an all-clear while
 * the app was broken.
 *
 * Now (2026-11-16): only checks that ran are counted; "all pass" is said only
 * when every one of them passed; a failing check is its own row, with what
 * stops a publish counted by the server's own rule (lib/deployment/
 * readiness-scorer.ts buildReport: a blocking check, or a fixable one not
 * fixed yet); and each failing row links to the page where it is fixed.
 */

export interface HeadlineCheck {
  id?: string
  status: 'pass' | 'fail' | 'skip'
  severity: 'blocking' | 'warning' | 'auto-fixable'
  fixApplied?: boolean
}

export interface ReadinessSummary {
  /** Checks that ran. Skipped ones (nothing to check yet) are not counted. */
  ran: number
  passing: number
  /** Failing checks a publish stops on. */
  blocking: number
  /** Failing checks that do not stop a publish. */
  warnings: number
  /** Every check that ran passed (and at least one ran). */
  allPass: boolean
  /** The section's one line when every check passes: "All 11 checks pass. Publishing runs them again." */
  line: string
  /** Under the failing rows: "8 other checks pass." Empty when none passed. */
  othersLine: string
}

/** A failing check a publish stops on, by the server's rule (readiness-scorer.ts buildReport). */
export function stopsPublish(check: HeadlineCheck): boolean {
  return check.status === 'fail' && (check.severity === 'blocking' || (check.severity === 'auto-fixable' && !check.fixApplied))
}

export function readinessSummary(checks: readonly HeadlineCheck[]): ReadinessSummary {
  const ran = checks.filter((c) => c.status !== 'skip')
  const passing = ran.filter((c) => c.status === 'pass').length
  const blocking = ran.filter(stopsPublish).length
  const warnings = ran.filter((c) => c.status === 'fail' && !stopsPublish(c)).length
  const allPass = ran.length > 0 && passing === ran.length
  const line =
    ran.length === 0
      ? 'No checks have run yet.'
      : ran.length === 1
        ? 'The 1 check passes. Publishing runs it again.'
        : `All ${ran.length} checks pass. Publishing runs them again.`
  const othersLine = passing === 0 ? '' : `${passing} other ${passing === 1 ? 'check passes' : 'checks pass'}.`
  return { ran: ran.length, passing, blocking, warnings, allPass, line: allPass || ran.length === 0 ? line : '', othersLine }
}

/**
 * Where a failing check is fixed in the console, by check id. A check with no
 * page here (the server's own configuration, the project's JWT secret, which
 * only "Apply safe fixes" sets, the end-to-end behaviour checks) gets no link.
 */
const FIX_PAGE: Record<string, { path: string; label: string }> = {
  route_protection: { path: 'database', label: 'Database' },
  rls_applied: { path: 'database', label: 'Database' },
  verification: { path: 'database', label: 'Database' },
  security_audit: { path: 'database', label: 'Database' },
  end_user_auth_table: { path: 'auth', label: 'Auth & Users' },
  email_links: { path: 'auth', label: 'Auth & Users' },
  webhook_security: { path: 'webhooks', label: 'Webhooks' },
  function_triggers: { path: 'functions', label: 'Functions' },
  monitoring_basics: { path: 'monitoring', label: 'Monitoring' },
  open_findings: { path: 'autonomy', label: 'Autonomy' },
}

export function fixPageFor(checkId: string): { path: string; label: string } | null {
  return FIX_PAGE[checkId] ?? null
}

/**
 * A check's name as the console says it. env_vars tests the Backenly server's
 * own settings (DATABASE_URL, JWT_SECRET), not the project's secrets.
 */
export function checkName(check: { id: string; name: string }): string {
  return check.id === 'env_vars' ? 'Server configuration' : check.name
}
