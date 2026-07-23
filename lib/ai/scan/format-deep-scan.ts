/**
 * DEEP SCAN FORMATTER
 * ===================
 * Renders a DeepScanReport into the markdown shown in chat.
 *
 * Layout (in order — never lead with raw tables):
 *   1. Executive Summary          — one paragraph, plain English
 *   2. Launch Readiness Score     — 0–100 with axis breakdown
 *   3. What is Built              — grouped by product capability
 *   4. What is Missing            — non-dev language, severity-tagged
 *   5. Risks Before Launch        — Critical / High / Medium / Low
 *   6. Recommended Next Actions   — 3–5 concrete steps
 *   7. Auto-fixable vs Needs User
 *   8. Proof                      — raw counts at the bottom only
 */

import type { DeepScanReport, LaunchVerdict, Severity } from './deep-scan'

const VERDICT_LABEL: Record<LaunchVerdict, string> = {
  production_ready:   'Production Ready',
  needs_launch_fixes: 'Needs Launch Fixes',
  credentials_needed: 'Credentials Needed',
  structure_ready:    'Structure Ready',
  not_started:        'Not Started',
}

const VERDICT_ICON: Record<LaunchVerdict, string> = {
  production_ready:   '✅',
  needs_launch_fixes: '🚧',
  credentials_needed: '🔑',
  structure_ready:    '🏗️',
  not_started:        '⚪',
}

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '⚪',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high:     'High',
  medium:   'Medium',
  low:      'Low',
}

export function formatDeepScan(report: DeepScanReport): string {
  const lines: string[] = []

  // ── Executive header — feels like million-dollar software ─────────────
  const verdictLine = `${VERDICT_ICON[report.verdict]} ${VERDICT_LABEL[report.verdict]}`
  lines.push(`**${verdictLine}**`)
  lines.push('')

  // ── Launch Readiness Score — the single most important number ─────────
  const scoreLabel = report.score >= 80 ? 'Launch-ready'
    : report.score >= 60 ? 'Needs attention'
    : report.score >= 40 ? 'Core complete'
    : 'Early stage'
  lines.push(`**Launch Readiness: ${report.score}/100** — ${scoreLabel}`)
  lines.push(scoreBar(report.score))
  lines.push('')

  // ── 1. Executive Summary ───────────────────────────────────────────────
  lines.push(report.executiveSummary)
  lines.push('')

  // ── 2. What is Built — grouped by capability ──────────────────────────
  if (report.built.length > 0) {
    lines.push('**Backend Capabilities**')
    for (const cap of report.built) {
      lines.push(`  ✓ **${cap.title}** — ${cap.summary}`)
    }
    lines.push('')
  }

  // ── 3. Launch Risks — severity-grouped ────────────────────────────────
  if (report.risks.length > 0) {
    lines.push('**Launch Risks**')
    const grouped: Record<Severity, typeof report.risks> = { critical: [], high: [], medium: [], low: [] }
    for (const r of report.risks) grouped[r.severity].push(r)

    for (const sev of ['critical', 'high', 'medium', 'low'] as Severity[]) {
      const items = grouped[sev]
      if (items.length === 0) continue
      lines.push(`  ${SEVERITY_ICON[sev]} **${SEVERITY_LABEL[sev]}**`)
      for (const r of items.slice(0, 3)) {
        lines.push(`    • ${r.title} — ${r.recommendation}`)
      }
      if (items.length > 3) lines.push(`    • …and ${items.length - 3} more`)
    }
    lines.push('')
  }

  // ── 4. What is Missing ────────────────────────────────────────────────
  if (report.missing.length > 0) {
    lines.push('**Missing Before Launch**')
    for (const m of report.missing.slice(0, 8)) {
      lines.push(`  ${SEVERITY_ICON[m.severity]} ${m.title} — ${m.why}`)
    }
    if (report.missing.length > 8) lines.push(`  …and ${report.missing.length - 8} more`)
    lines.push('')
  }

  // ── 5. Recommended Next Actions ───────────────────────────────────────
  if (report.nextActions.length > 0) {
    lines.push('**Recommended Next Actions**')
    report.nextActions.slice(0, 5).forEach((a, i) => {
      const tag = a.autoFixable ? ' — Backenly can fix this automatically' : ''
      lines.push(`  ${i + 1}. **${a.title}**${tag}`)
    })
    lines.push('')
  }

  // ── 6. Auto-fixable vs Needs You ──────────────────────────────────────
  if (report.autoFixable.length > 0 || report.needsUser.length > 0) {
    if (report.autoFixable.length > 0) {
      lines.push(`  *Backenly can auto-fix:* ${report.autoFixable.slice(0, 3).join(', ')}${report.autoFixable.length > 3 ? `, +${report.autoFixable.length - 3} more` : ''}`)
    }
    if (report.needsUser.length > 0) {
      lines.push(`  *Needs your input:* ${report.needsUser.slice(0, 3).join(', ')}${report.needsUser.length > 3 ? `, +${report.needsUser.length - 3} more` : ''}`)
    }
    lines.push('')
  }

  // ── 7. Score breakdown by axis ────────────────────────────────────────
  if (report.breakdown.length > 0) {
    lines.push('**Score Breakdown**')
    for (const axis of report.breakdown) {
      const bar = miniBar(axis.score)
      lines.push(`  ${bar} ${axis.label.padEnd(18)} ${pct(axis.score)} — ${axis.note}`)
    }
    lines.push('')
  }

  // ── 8. Proof counts at the bottom only ────────────────────────────────
  const p = report.proof
  const proofParts: string[] = [
    `${p.tables} table${p.tables !== 1 ? 's' : ''}`,
    `${p.apis} API${p.apis !== 1 ? 's' : ''}`,
    p.authEnabled ? (p.authProviders.length > 0 ? `Auth (${p.authProviders.join('+')})` : 'Auth') : 'No auth',
    `${p.buckets} bucket${p.buckets !== 1 ? 's' : ''}`,
    p.integrations.length > 0 ? p.integrations.join(', ') : 'No integrations',
  ]
  if (p.blockedItems > 0) proofParts.push(`${p.blockedItems} blocked`)
  if (p.failedNodes > 0) proofParts.push(`${p.failedNodes} failed`)
  lines.push(`*${proofParts.join(' · ')} — scanned ${new Date(report.evaluatedAt).toLocaleTimeString()}, read-only.*`)

  return lines.join('\n')
}

// ── helpers ───────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(Math.max(0, Math.min(100, n))).toString().padStart(3, ' ')}%`
}

function scoreBar(score: number): string {
  const s = Math.max(0, Math.min(100, score))
  const filled = Math.round((s / 100) * 20)
  const color = s >= 80 ? '█' : s >= 60 ? '▓' : s >= 40 ? '▒' : '░'
  return `[${color.repeat(filled)}${'░'.repeat(20 - filled)}] ${s}/100`
}

function miniBar(score: number): string {
  const s = Math.max(0, Math.min(100, score))
  if (s >= 80) return '✓'
  if (s >= 60) return '~'
  return '✗'
}
