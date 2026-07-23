/**
 * PROPOSAL RENDERER
 * =================
 * Turns a Proposal into the markdown affordance that appears at the end of
 * the assistant's recommendation list. The renderer is the agent's "way out"
 * of an open-ended advisory response — it surfaces a one-keystroke call-to-
 * action so the user never has to guess what to type next.
 */

import type { ApplyProposalReport, Proposal } from './types'

/** Append a "what next" affordance to an assistant list response so the
 *  user has a one-keystroke path forward. Kept compact — agentic products
 *  feel best when the affordance is decisive, not chatty. */
export function buildApplyAffordance(proposal: Proposal): string {
  const executable = proposal.items.filter(i => i.executable)
  const blocked = proposal.items.filter(i => !i.executable)

  if (executable.length === 0 && blocked.length === 0) return ''

  const lines: string[] = ['', '---', '']

  if (executable.length > 0) {
    const verb = executable.length === 1 ? 'item' : 'items'
    lines.push(`I can apply **${executable.length} ${verb}** for you now — reply \`apply\` to start, or \`apply 1, 3, 5\` to pick specific ones.`)
  } else {
    lines.push(`No items in this list can be auto-applied from inside Backenly. Items below need credentials, manual work, or infra you control.`)
  }

  if (blocked.length > 0) {
    const credentialBlocked = blocked.filter(b => b.blocker === 'needs_credential')
    const infraBlocked = blocked.filter(b => b.blocker === 'infra_only')
    const informational = blocked.filter(b => b.blocker === 'already_handled')
    const manual = blocked.filter(b => b.blocker === 'needs_user_input' || b.blocker === 'unsupported')

    const segs: string[] = []
    if (credentialBlocked.length) segs.push(`${credentialBlocked.length} need a key/credential`)
    if (infraBlocked.length) segs.push(`${infraBlocked.length} live outside Backenly (infra)`)
    if (informational.length) segs.push(`${informational.length} are already handled by the platform`)
    if (manual.length) segs.push(`${manual.length} need manual decisions from you`)
    if (segs.length) {
      lines.push('')
      lines.push(`The remaining ${blocked.length}: ${segs.join(' · ')}.`)
    }
  }

  return lines.join('\n')
}

/** Render a one-line execution summary after `applyProposal` finishes. */
export function renderApplyReport(report: ApplyProposalReport): string {
  const lines: string[] = []
  const { succeeded, failed, skipped, attempted, items } = report

  if (attempted === 0) {
    return 'Nothing applied — every item in this proposal needs credentials, infra changes, or is already handled by the platform.'
  }

  const head = succeeded === attempted
    ? `Applied **${succeeded}/${attempted}** items.`
    : failed > 0
      ? `Applied **${succeeded}/${attempted}** items · ${failed} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}.`
      : `Applied **${succeeded}/${attempted}** items.`
  lines.push(head)
  lines.push('')

  for (const item of items) {
    if (item.status === 'done') {
      lines.push(`✓ ${item.title}${item.proof ? ` — ${item.proof}` : ''}`)
    } else if (item.status === 'failed') {
      lines.push(`✗ ${item.title}${item.error ? ` — ${item.error}` : ''}`)
    } else if (item.status === 'skipped') {
      lines.push(`◦ ${item.title} — skipped`)
    }
  }

  return lines.join('\n')
}
