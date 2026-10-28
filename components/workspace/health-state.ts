/**
 * What the dashboard may claim about health, decided in one place.
 *
 * Kept free of React so the rules are tested directly: the quiet headline
 * speaks only for checks that ran recently, and the heal animation fires only
 * for repairs a re-check confirmed.
 */

/** A loop pass older than this no longer supports a claim about now. */
export const LOOP_STALE_MS = 15 * 60_000

export interface SensorSummary {
  at: string
  total: number
  ran: number
  errored: Array<{ id: string; title: string; error: string }>
  disabled: Array<{ id: string; title: string; reason: string }>
}

export interface ResolvedRow {
  id: string
  closedBy: string
}

/**
 * The headline and body for a project with nothing open. An absence of findings
 * is evidence of health only for checks that ran, recently, and could see.
 *
 * `caveat` is true when the page cannot vouch for the backend: the latest load
 * failed, the loop's last pass is stale, or a check could not run. The
 * Overview shows the quiet state only then; otherwise the loop says it all.
 */
export function quietState(args: {
  /** null until the first load succeeds. */
  health: { lastReconciledAt: string | null; sensors?: SensorSummary | null } | null
  /** The latest load failed. An earlier payload is then no longer current. */
  healthError: boolean
  autonomyOff: boolean
  /** When the payload was read (epoch ms). Not known means not fresh. */
  now: number
  formatAgo: (iso: string) => string
}): { headline: string; body: string; caveat: boolean } {
  const { health, healthError, autonomyOff, now, formatAgo } = args

  if (healthError) {
    return {
      headline: 'Can’t confirm health right now',
      body: 'The latest health check did not load, so this page is not claiming anything either way. It retries on its own.',
      caveat: true,
    }
  }
  if (!health) return { headline: 'Checking your backend', body: 'Loading the latest checks.', caveat: false }

  const reconciledMs = health.lastReconciledAt ? Date.parse(health.lastReconciledAt) : NaN
  const loopFresh =
    Number.isFinite(reconciledMs) && Number.isFinite(now) && now > 0 && now - reconciledMs < LOOP_STALE_MS
  if (!loopFresh) {
    return {
      headline: 'No recent check to report',
      body: health.lastReconciledAt
        ? `The self-healing loop last checked this backend ${formatAgo(health.lastReconciledAt)}, so this page cannot speak for its current state.`
        : 'The self-healing loop has not checked this backend recently, so this page cannot speak for its current state.',
      caveat: true,
    }
  }

  const sensors = health.sensors ?? null
  const blind = sensors?.errored ?? []
  if (blind.length > 0) {
    return {
      headline: `${blind.length} check${blind.length === 1 ? '' : 's'} could not run`,
      body:
        `No issues were found by the checks that ran, but ` +
        `${blind.map((b) => b.title).slice(0, 3).join(', ')}${blind.length > 3 ? ' and others' : ''} ` +
        `could not complete, so problems there would not show up here.`,
      caveat: true,
    }
  }

  const off = sensors?.disabled.length ?? 0
  const checked = sensors
    ? `No issues found by the ${sensors.ran} check${sensors.ran === 1 ? '' : 's'} of schema, APIs, auth and storage on the last pass` +
      (off > 0 ? ` (${off} more ${off === 1 ? 'is' : 'are'} off on this install)` : '') +
      '. '
    : 'No issues found by the monitored checks. '
  return {
    headline: autonomyOff ? 'No issues detected' : 'No issues detected. Self-healing on watch',
    body:
      checked +
      (autonomyOff
        ? 'Self-healing is off for this project, so Backenly reports issues but does not repair them.'
        : 'Backenly keeps re-checking and repairs safe issues on its own. Only auth or destructive changes wait for you.'),
    caveat: false,
  }
}

/**
 * Repairs in `resolved` that a re-check confirmed and that `seen` has not
 * shown yet. Only these may animate a heal; a dismissal, a withdrawal or an
 * unconfirmed repair never does.
 */
export function freshlyVerifiedRepairs(resolved: readonly ResolvedRow[], seen: ReadonlySet<string>): string[] {
  return resolved.filter((r) => r.closedBy === 'autonomy_verified' && !seen.has(r.id)).map((r) => r.id)
}
