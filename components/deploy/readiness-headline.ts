/**
 * The line at the top of the Deploy page's readiness card.
 *
 * It counted passes against every check and was green whenever nothing
 * blocked, so failing warnings read as "9 of 11 passing" in green, and a
 * check that was skipped (nothing to check yet) counted as one that failed.
 * Production QA (2026-11-09, report 86) read the card as an all-clear while
 * the app was broken.
 *
 * Now a blocker says how many to clear; a failing warning turns the line amber
 * and is counted; and only checks that ran are counted at all.
 */

export interface HeadlineCheck {
  status: 'pass' | 'fail' | 'skip'
  severity: 'blocking' | 'warning' | 'auto-fixable'
}

export function readinessHeadline(checks: HeadlineCheck[]): { tone: 'operational' | 'attention'; label: string } {
  const ran = checks.filter((c) => c.status !== 'skip')
  const passing = ran.filter((c) => c.status === 'pass').length
  const blocking = ran.filter((c) => c.status === 'fail' && c.severity === 'blocking').length
  const warnings = ran.filter((c) => c.status === 'fail' && c.severity !== 'blocking').length
  if (blocking > 0) return { tone: 'attention', label: `${blocking} to clear` }
  const counted = `${passing} of ${ran.length} passing`
  if (warnings > 0) {
    return { tone: 'attention', label: `${counted} · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` }
  }
  return { tone: 'operational', label: counted }
}
