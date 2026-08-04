/**
 * The autonomy entitlement contract must exist in the repo, and it must say
 * what the loop and the price list both claim it says.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `prisma/seed-billing.ts` is the ONLY place that sets the three fields the
 * self-healing loop reads to decide how it may behave:
 *
 *   autonomyScanIntervalMin      how often a project is reconciled
 *   autonomyMaxLevel             the ceiling on the owner's risk dial
 *   autonomyMaxActionsPerWindow  the per-window fix cap
 *
 * Four modules cite that file by name as their source of truth — the reconciler's
 * cadence gate, autonomy-level's plan clamp, the circuit breaker's unlimited
 * branch, and AGENTS.md. None of them IMPORT it, because it is a CLI seed
 * script rather than a library. That made it invisible to a reachability sweep,
 * and on 2026-08-04 commit c3e069f6 deleted it as "unreachable from every entry
 * point" along with 251 genuinely dead files.
 *
 * Deleting it does not fail a build, a typecheck, or any existing test. It fails
 * the product, quietly, because the fallbacks it was covering are far more
 * conservative than what is sold:
 *
 *   • the schema defaults are `autonomyScanIntervalMin = 360` (six hours) and
 *     `autonomyMaxLevel = "CONSERVATIVE"`
 *   • with no Plan row at all, the resolvers fall back further still — a 1440
 *     minute cadence (once a day) and a CONSERVATIVE ceiling
 *
 * CONSERVATIVE means the dial permits Tier 0 only. Tier 1 is where `missing_rls`
 * lives. So the difference between this file existing and not existing is
 * whether the platform ever autonomously closes a row-level-security hole, and
 * the pricing page sells "self-healing every minute, repairing everything it
 * safely can" either way.
 *
 * Asserted as text rather than by importing the module, because importing it
 * runs the seed against whatever DATABASE_URL is set.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const SEED_PATH = join(process.cwd(), 'prisma', 'seed-billing.ts')

describe('prisma/seed-billing.ts — the autonomy entitlement contract', () => {
  it('exists', () => {
    expect(existsSync(SEED_PATH)).toBe(true)
  })

  it('seeds all three plan codes', () => {
    const src = readFileSync(SEED_PATH, 'utf8')
    for (const code of ['SANDBOX', 'BUILDER', 'SCALE']) {
      expect(src).toContain(`name: '${code}'`)
    }
  })

  it('gives every plan the every-minute cadence the price list sells', () => {
    const src = readFileSync(SEED_PATH, 'utf8')
    const cadences = [...src.matchAll(/autonomyScanIntervalMin:\s*(\d+)/g)].map(m => Number(m[1]))
    expect(cadences.length).toBe(3)
    // Free included. A plan throttled below the cron period would make the
    // product contradict its own pricing page.
    for (const c of cadences) expect(c).toBe(1)
  })

  it('gives every plan the full dial, so Tier-1 security fixes are reachable', () => {
    const src = readFileSync(SEED_PATH, 'utf8')
    const levels = [...src.matchAll(/autonomyMaxLevel:\s*'([A-Z]+)'/g)].map(m => m[1])
    expect(levels.length).toBe(3)
    // Anything below AGGRESSIVE/BALANCED caps the dial at Tier 0 and the loop
    // stops being able to apply RLS on its own.
    for (const l of levels) expect(l).toBe('AGGRESSIVE')
  })

  it('leaves healing uncapped per window on every plan', () => {
    const src = readFileSync(SEED_PATH, 'utf8')
    const caps = [...src.matchAll(/autonomyMaxActionsPerWindow:\s*([a-z0-9]+)/g)].map(m => m[1])
    expect(caps.length).toBe(3)
    // null = unlimited. The anti-storm ceiling in the circuit breaker is what
    // bounds a flapping detector; this field is not a pricing lever.
    for (const c of caps) expect(c).toBe('null')
  })

  it('is runnable as a first-class entry point, not just a loose file', () => {
    // The reachability sweep that deleted it looked for imports. A seed script
    // has none by nature, so the defence is that `npm run db:seed` names it.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts?.['db:seed']).toContain('prisma/seed-billing.ts')
  })
})
