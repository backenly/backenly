/**
 * A FAILED FIX IS NOT A HUMAN DECISION
 * ====================================
 * `pending_approval` is written by two different things that mean opposite
 * things:
 *
 *   • the classifier rating a fix `approval` — a human owns it, forever;
 *   • `_escalate` parking an `auto` fix that RAN and did not work.
 *
 * The reconciler treated both as terminal, so the second kind had no path back.
 * Production, 2026-07-18: seven `missing_fk` fixes failed with
 * `42P17 infinite recursion detected in policy for relation
 * "organization_members"`. The recursive policy was repaired days afterwards and
 * the same ALTER TABLE succeeds today. The seven findings never moved. For the
 * thirteen days after, the loop re-detected all seven every sixty seconds and
 * logged `applied=0 escalated=0 deferred=0 attempted=0` — 7,636 consecutive
 * no-op runs, each one writing an AUTONOMY_LIVE_RUN row that reads like work.
 *
 * These assertions pin the rule that ends that: retry a failure, never retry a
 * policy decision, and give up after a bounded number of attempts.
 */

import { describe, it, expect } from '@jest/globals'
import {
  shouldRetryEscalation,
  ESCALATION_RETRY_BACKOFF_HOURS,
} from '@/lib/autonomy/reconciler'

const NOW = new Date('2026-08-01T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

describe('escalation retry — policy vs failure', () => {
  it('never retries a fix the classifier gates on a human', () => {
    // Even an ancient, never-retried escalation stays put when it is Tier-2 work.
    const d = shouldRetryEscalation(false, { at: hoursAgo(24 * 365) }, NOW)
    expect(d.retry).toBe(false)
    expect(d.reason).toMatch(/human/i)
  })

  it('retries an auto-fixable failure once the backoff has elapsed', () => {
    const d = shouldRetryEscalation(true, { at: hoursAgo(2), retryCount: 0 }, NOW)
    expect(d.retry).toBe(true)
    expect(d.attempt).toBe(1)
  })

  it('backs off inside the window instead of retrying every tick', () => {
    // The loop ticks every 60s. Without this the recovery path would hammer a
    // failing fix once a minute, which is the pathology it replaces.
    const d = shouldRetryEscalation(true, { at: hoursAgo(0.5), retryCount: 0 }, NOW)
    expect(d.retry).toBe(false)
    expect(d.reason).toMatch(/backing off/i)
  })

  it('widens the backoff with each successive attempt', () => {
    // Attempt 2's rung is 6h, so 2h of silence is enough for attempt 1 but not
    // for attempt 2 — otherwise the ladder would be decorative.
    expect(shouldRetryEscalation(true, { at: hoursAgo(2), retryCount: 0 }, NOW).retry).toBe(true)
    expect(shouldRetryEscalation(true, { at: hoursAgo(2), retryCount: 1 }, NOW).retry).toBe(false)
    expect(shouldRetryEscalation(true, { at: hoursAgo(8), retryCount: 1 }, NOW).retry).toBe(true)
  })

  it('gives up permanently after the last rung', () => {
    const exhausted = ESCALATION_RETRY_BACKOFF_HOURS.length
    const d = shouldRetryEscalation(true, { at: hoursAgo(24 * 365), retryCount: exhausted }, NOW)
    expect(d.retry).toBe(false)
    expect(d.reason).toMatch(/permanently/i)
  })

  it('rescues rows that predate the retry bookkeeping', () => {
    // The seven stuck production findings carry no `escalation` object at all —
    // they were escalated before `_escalate` recorded one. Stranding them would
    // leave the exact incident this fix exists for unresolved.
    expect(shouldRetryEscalation(true, undefined, NOW).retry).toBe(true)
    expect(shouldRetryEscalation(true, {}, NOW).retry).toBe(true)
  })

  it('does not read an unparseable timestamp as "just now"', () => {
    // `Date.parse` returns NaN on junk. A NaN comparison is false, which would
    // have silently meant "backoff satisfied" — retrying every single tick.
    // Retrying is the correct answer here; the write stamps a real timestamp and
    // the row enters the ladder, so it cannot recur.
    const d = shouldRetryEscalation(true, { at: 'not-a-date', retryCount: 0 }, NOW)
    expect(d.retry).toBe(true)
    expect(d.attempt).toBe(1)
  })

  it('prefers lastRetryAt over the original failure time', () => {
    // `at` is refreshed by _escalate on each failure, but `lastRetryAt` is what
    // the reconciler stamps when it hands the finding back. Reading the older
    // field would let a just-retried finding retry again immediately.
    const d = shouldRetryEscalation(
      true,
      { at: hoursAgo(500), lastRetryAt: hoursAgo(0.25), retryCount: 1 },
      NOW,
    )
    expect(d.retry).toBe(false)
  })

  it('bounds total attempts so a permanently broken fix cannot loop', () => {
    let escalation: Record<string, unknown> = {}
    let attempts = 0
    // Simulate a fix that always fails, with unlimited time between ticks.
    for (let i = 0; i < 50; i++) {
      const d = shouldRetryEscalation(true, escalation, new Date(NOW.getTime() + i * 3600_000 * 100))
      if (!d.retry) break
      attempts++
      escalation = { retryCount: d.attempt, lastRetryAt: new Date(NOW.getTime() + i * 3600_000 * 100).toISOString() }
    }
    expect(attempts).toBe(ESCALATION_RETRY_BACKOFF_HOURS.length)
  })
})
