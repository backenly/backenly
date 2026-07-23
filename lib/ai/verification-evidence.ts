/**
 * VERIFICATION EVIDENCE FENCE
 * ===========================
 * The behavioral verifier produces real evidence — "✓ Signup: test user
 * created", "✓ User B correctly denied — 0 rows returned" — but historically
 * that evidence died in logs while the chat showed only "checks passed".
 *
 * This module serialises the final check snapshot into a fenced block that
 * rides INSIDE the persisted assistant message:
 *
 *   ```verification
 *   { "v": 1, "passed": 5, "total": 6, "checks": [...] }
 *   ```
 *
 * Because it lives in the message content itself it needs zero extra SSE or
 * state plumbing: the live stream, the reattach path, and the refresh-from-DB
 * path all render the same content through formatStructuredResponse, which
 * detects the fence and renders a proper evidence card (StructuredResponse.tsx).
 *
 * Consumers:
 *   • lib/ai/brain/agent.ts        — blueprint builds (inline verification)
 *   • app/api/projects/[id]/execute/route.ts — agent-loop builds (route-side
 *     verification; also patches the persisted row so refresh keeps the card)
 */

import type { FixLoopResult } from './agentic-fix-loop'

export interface VerificationEvidenceCheck {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** error (failed) or skip reason (skipped) — absent on pass. */
  note?: string
  /** Ordered assertion outcomes from the live run, e.g. "✓ Signup: …". */
  evidence: string[]
}

export interface VerificationEvidencePayload {
  v: 1
  /** Checks that ran and passed. */
  passed: number
  /** Checks that ran (excludes skipped). */
  total: number
  /** Fixes the agentic loop applied automatically before the final pass. */
  repaired: number
  executedAt: string
  checks: VerificationEvidenceCheck[]
}

const MAX_EVIDENCE_LINES = 6
const MAX_LINE_CHARS = 140

export const VERIFICATION_FENCE_RE = /```verification\s*\n([\s\S]*?)\n```/

/** Build the fenced evidence block from a completed fix-loop run. */
export function buildVerificationFence(result: FixLoopResult): string {
  const checks = result.finalCheckSnapshot?.checks ?? []
  if (checks.length === 0) return ''

  const ran = checks.filter(c => !c.skipped)
  const payload: VerificationEvidencePayload = {
    v: 1,
    passed: ran.filter(c => c.passed).length,
    total: ran.length,
    repaired: result.appliedFixes,
    executedAt: result.finalCheckSnapshot?.executedAt ?? new Date().toISOString(),
    checks: checks.map(c => ({
      name: c.name,
      status: c.skipped ? 'skipped' : c.passed ? 'passed' : 'failed',
      ...(c.skipped && c.skipReason ? { note: clip(c.skipReason) } : {}),
      ...(!c.skipped && !c.passed && c.error ? { note: clip(c.error) } : {}),
      evidence: (c.details ?? []).slice(0, MAX_EVIDENCE_LINES).map(clip),
    })),
  }

  return '```verification\n' + JSON.stringify(payload) + '\n```'
}

/** Parse a verification fence out of message content. Null when absent/corrupt. */
export function parseVerificationFence(content: string): VerificationEvidencePayload | null {
  const match = content.match(VERIFICATION_FENCE_RE)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as VerificationEvidencePayload
    if (parsed?.v !== 1 || !Array.isArray(parsed.checks)) return null
    return parsed
  } catch {
    return null
  }
}

/** Message content with the fence removed (for rendering the prose part). */
export function stripVerificationFence(content: string): string {
  return content.replace(VERIFICATION_FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function clip(s: string): string {
  return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS - 1) + '…' : s
}
