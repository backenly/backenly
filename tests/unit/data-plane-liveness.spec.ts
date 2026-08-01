/**
 * "HEALTHY" MUST NOT BE PRINTABLE DURING AN OUTAGE
 * ===============================================
 *
 * Two months of production findings, every project:
 *
 *   contract_surface_broken   298    ← a customer cannot reach their backend
 *   missing_fk                 29
 *   missing_rate_limit         28    (detector since retired)
 *   verification_failed         4
 *   orphan_table                3
 *   missing_fk_index            2
 *   workflow_broken             1
 *
 * The top line — ~80% of every real fault ever recorded — was not one of the
 * seventeen invariants. `computeDesiredStateDiff` could return `satisfied: true`
 * and `summarizeDesiredState` could print "Backend is healthy — all guarantees
 * hold" while the project's REST API returned 502s.
 *
 * These pin the two rules that make the new `data_plane_is_answering` invariant
 * trustworthy rather than merely present:
 *
 *   1. an unverified data plane is UNKNOWN, never healthy (the staleness rule)
 *   2. broken surfaces have distinct identities (the gapIdentity rule)
 *
 * Rule 1 matters most. Reading "no open finding" as "healthy" would have rebuilt
 * the exact bug the invariant is a response to, one level up: silence that
 * cannot be distinguished from never having looked.
 *
 * Database-free, so it runs in the `typecheck + unit tests` job on every push.
 */

import { describe, it, expect } from '@jest/globals'
import { isHeartbeatStale } from '@/lib/autonomy/data-plane-liveness'
import { gapIdentity } from '@/lib/autonomy/desired-state'

const NOW = new Date('2026-08-01T12:00:00.000Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('contract-sweep heartbeat staleness', () => {
  it('treats a missing heartbeat as stale, never as healthy', () => {
    // The whole point. A project the sweep has never verified has NOT been
    // proven to be answering, and the probe must refuse to say otherwise.
    expect(isHeartbeatStale(null, NOW)).toBe(true)
  })

  it('accepts a heartbeat from the last sweep', () => {
    // Sweep cadence is 15 minutes.
    expect(isHeartbeatStale({ verifiedAt: minsAgo(2) }, NOW)).toBe(false)
    expect(isHeartbeatStale({ verifiedAt: minsAgo(14) }, NOW)).toBe(false)
  })

  it('tolerates one missed sweep plus jitter', () => {
    // Flapping against its own scheduler would make the invariant noise, and
    // noise is how a real signal gets ignored.
    expect(isHeartbeatStale({ verifiedAt: minsAgo(31) }, NOW)).toBe(false)
    expect(isHeartbeatStale({ verifiedAt: minsAgo(44) }, NOW)).toBe(false)
  })

  it('rejects a heartbeat old enough to mean the sweep is dead', () => {
    expect(isHeartbeatStale({ verifiedAt: minsAgo(46) }, NOW)).toBe(true)
    expect(isHeartbeatStale({ verifiedAt: minsAgo(60 * 24) }, NOW)).toBe(true)
  })

  it('does not read an unparseable timestamp as fresh', () => {
    // Date.parse returns NaN on junk, and every comparison against NaN is
    // false — which would have made a corrupt heartbeat read as up-to-date.
    expect(isHeartbeatStale({ verifiedAt: 'not-a-date' }, NOW)).toBe(true)
    expect(isHeartbeatStale({ verifiedAt: '' }, NOW)).toBe(true)
  })
})

describe('gapIdentity discriminates broken surfaces', () => {
  it('gives each surface its own identity', () => {
    // Before this, contract_surface_broken details carried no location, no
    // table and no workflow, so every surface collapsed to the identity
    // `contract_surface_broken::`. `reapObserverFindings` keys these rows
    // through gapIdentity, so with two surfaces down, one recovering could
    // withdraw the other's still-valid finding.
    const db = gapIdentity('contract_surface_broken', { surface: 'db' })
    const storage = gapIdentity('contract_surface_broken', { surface: 'storage' })
    const runtime = gapIdentity('contract_surface_broken', { surface: 'runtime' })

    expect(new Set([db, storage, runtime]).size).toBe(3)
    expect(db).toContain('db')
  })

  it('is stable for the same surface', () => {
    expect(gapIdentity('contract_surface_broken', { surface: 'db', httpStatus: 502 })).toBe(
      gapIdentity('contract_surface_broken', { surface: 'db', httpStatus: 503 }),
    )
  })

  it('still prefers an explicit location over the surface', () => {
    // `location` remains the most-specific locator for every other type.
    expect(gapIdentity('contract_surface_broken', { location: 'x', surface: 'db' })).toContain('x')
  })

  it('has not disturbed workflow or table identities', () => {
    expect(gapIdentity('workflow_broken', { workflow: 'user_auth_flow' })).toContain('user_auth_flow')
    expect(gapIdentity('missing_fk_index', { tableName: 't', columnName: 'c' })).toContain('t.c')
  })
})
