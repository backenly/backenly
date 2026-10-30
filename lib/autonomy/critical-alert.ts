/**
 * What the critical-issue email says about each issue.
 *
 * notifyCritical (lib/services/workspace-observer.ts) emails a project's owner
 * about criticals still open after the repair loop had its chance. The email
 * (lib/notifications/health-alert-email.ts) lists them as the Autonomy page's
 * review queue does: one row per root cause, folded by the queue's own
 * grouping (lib/core/finding-groups.ts) and titled with the queue's own
 * sentence, so the inbox and the page it links to cannot disagree about what
 * is wrong.
 *
 * Under each row it says why the issue waits for a person, from what is known
 * about it, in this order:
 *   1. Backenly repaired it before and it came back, or a repair did not hold:
 *      the opposite story from a repair never attempted, so it comes first, as
 *      it does in the queue (heldBecauseFor in lib/autonomy/trust-report.ts);
 *   2. no repair exists: the first sentence of the hint the queue shows in
 *      place of a button (getManualRemediationHint), which says what Backenly
 *      will not do and why;
 *   3. the repair always waits for a person: the classifier's reason
 *      (classifyFix), the sentence the queue shows for a guardrail;
 *   4. a repair is ready and the autonomy settings hold it back
 *      (`notAppliedBecause`, written by the observer).
 * Otherwise a row is its title alone, rather than a guess.
 *
 * Pure: no database, so it is tested on findings alone.
 */
import { groupFindings, type FindingGroup, type GroupableFinding } from '@/lib/core/finding-groups'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import type { HealthAlertIssue } from '@/lib/notifications/health-alert-email'

/** A finding as the observer holds it when it emails. */
export interface AlertFinding {
  type: string
  severity: string
  details: Record<string, unknown> | null
}

/** Rows kept in the notification. The email shows the first few and counts the rest. */
const MAX_ISSUES = 20

export function criticalAlertIssues(findings: AlertFinding[]): HealthAlertIssue[] {
  const groups = groupFindings(
    findings.map((f, i) => ({ id: String(i), type: f.type, severity: f.severity, details: f.details })),
  )
  return groups.slice(0, MAX_ISSUES).map((group) => ({
    title: group.title,
    subjects: group.members.length > 1 ? group.subjects : [],
    findings: group.members.length,
    explanation: named(whyItWaits(group), group),
  }))
}

/**
 * The explanation's names, as the row's title shows them. The queue's hints
 * quote a table ("orders"); the email sets it in mono as the title does, the
 * same backtick convention the summaries use. A row that folds several tables
 * names them above its explanation, which comes from the first of them, so
 * there it says "these tables" instead of naming that one alone.
 */
function named(explanation: string | null, group: FindingGroup<GroupableFinding>): string | null {
  if (!explanation) return explanation
  const folded = group.members.length > 1
  return group.subjects.reduce(
    (out, name) => out.split(`"${name}"`).join(folded ? 'these tables' : `\`${name}\``),
    explanation,
  )
}

function whyItWaits(group: FindingGroup<GroupableFinding>): string | null {
  const head = group.members[0]
  const d = (head.details ?? {}) as Record<string, unknown>

  const tried =
    text((d.escalation as { reason?: unknown } | undefined)?.reason) ??
    (d.escalated === true ? text(d.escalationReason) : null) ??
    text((d.recurrence as { note?: unknown } | undefined)?.note)
  if (tried) return sentence(tried)

  if (!group.actionable) {
    const hint = getManualRemediationHint(head.type, head.details)
    if (hint) return firstSentence(hint)
  }

  const fix = classifyFix(head.type, head.details)
  if (fix.decision === 'approval') return sentence(fix.reason)

  if (group.actionable && text(d.notAppliedBecause)) {
    return 'Backenly has a fix ready, and your autonomy settings hold it for your approval.'
  }
  return null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The text as a sentence: some reasons are written without a full stop. */
function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`
}

/**
 * The first sentence of a hint: the queue's hints go on to the detail an
 * email leaves to the page. A full stop inside "e.g." does not end one.
 */
function firstSentence(value: string): string {
  const end = /[.!?](?=\s+["“(]?[A-Z])/g
  let match: RegExpExecArray | null
  while ((match = end.exec(value))) {
    if (/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(value.slice(Math.max(0, match.index - 4), match.index + 1))) continue
    return value.slice(0, match.index + 1)
  }
  return sentence(value.trim())
}
