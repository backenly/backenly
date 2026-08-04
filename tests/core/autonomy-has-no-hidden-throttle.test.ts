/**
 * Autonomy runs every minute, on every plan, or it is not the product.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * The loop had five independent throttles, none of them visible from any
 * dashboard, and every one of them defended by a reasonable-sounding comment
 * about degrading safely:
 *
 *   Plan.autonomyScanIntervalMin  @default(360)          six hours
 *   Plan.autonomyMaxLevel         @default(CONSERVATIVE)  Tier 0 only
 *   SAFE_CADENCE_MIN              1440                    once a day
 *   SAFE_FALLBACK_LEVEL           CONSERVATIVE            Tier 0 only
 *   the contract sweep cron       every 15 minutes        outage detection floor
 *
 * They shared a mistaken premise: that slowing down or narrowing scope is
 * always the cautious choice. For cadence it is not a safety property at all —
 * every real safety gate (tier classifier, circuit breaker, pre-fix snapshot,
 * post-fix re-probe, change-freeze) runs per ATTEMPT and does not care how
 * often the loop looks. For the level ceiling it is worse than neutral: Tier 1
 * is where `missing_rls` lives, so "degrading safely" meant silently ceasing to
 * close row-level-security holes.
 *
 * None of them fired in normal operation, which is precisely why they survived.
 * They only engaged when a Plan or Subscription row could not be read — and a
 * loop that has quietly dropped to once a day looks identical, from every
 * surface, to one running every minute.
 *
 * These assertions are deliberately blunt and deliberately annoying to change.
 * If a future plan genuinely needs a lower ceiling, it belongs in the seed as an
 * explicit per-plan value, not in a default or a fallback where it applies to
 * everyone who hits an error path.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  SAFE_FALLBACK_LEVEL,
  DEFAULT_LEVEL,
  getProjectAutonomyLevel,
  isTierAutoAllowed,
} from '@/lib/autonomy/autonomy-level'

const prisma = new PrismaClient()
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

afterAll(async () => {
  await prisma.$disconnect()
})

describe('no cadence throttle survives anywhere', () => {
  it('the Prisma default for scan interval is every minute, not six hours', () => {
    const schema = read('prisma/schema.prisma')
    const m = schema.match(/autonomyScanIntervalMin\s+Int\s+@default\((\d+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(1)
  })

  it('the reconciler cadence fallback is every minute, not a day', () => {
    // Not exported — asserted at the source, which is also where a future
    // "let's be careful" edit would land.
    const src = read('lib/autonomy/reconciler.ts')
    const m = src.match(/const SAFE_CADENCE_MIN\s*=\s*([\d_]+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1].replace(/_/g, ''))).toBe(1)
  })

  it('the autonomy reconciler cron fires every minute', () => {
    const src = read('instrumentation.ts')
    expect(src).toMatch(/cron\.schedule\('\* \* \* \* \*'[\s\S]{0,400}?ENABLE_AUTONOMY_RECONCILER/)
  })

  it('the contract sweep fires every minute — it is the data plane outage detector', () => {
    const src = read('instrumentation.ts')
    // Any */N schedule around runContractSweep is a detection-latency floor on
    // ~80% of real faults, so the sweep must not be on one.
    const sweepBlock = src.slice(
      Math.max(0, src.indexOf('runContractSweep') - 1500),
      src.indexOf('runContractSweep') + 200,
    )
    expect(sweepBlock).toContain("cron.schedule('* * * * *'")
    expect(sweepBlock).not.toMatch(/cron\.schedule\('\*\/\d+ \* \* \* \*'/)
  })

  it('the infra scan fires every minute — it is the only writer that can withdraw an infra finding', () => {
    const src = read('instrumentation.ts')
    const idx = src.indexOf('runAndStoreInfraIntelligence')
    const block = src.slice(Math.max(0, idx - 2200), idx + 200)
    expect(block).toContain("cron.schedule('* * * * *'")
    // Any daily/interval schedule here is a floor on how long a stale infra
    // finding sits in the review queue, and the module contains no model call
    // that would justify one.
    expect(block).not.toMatch(/cron\.schedule\('[\d*\/ ]*\d+ \* \* \*'/)
  })

  it('the background monitor does not fall back to an hourly floor', () => {
    const src = read('lib/ai/background-monitor.ts')
    const m = src.match(/AUTONOMY_SCAN_INTERVAL_MIN\)\s*\|\|\s*(\d+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(1)
  })
})

describe('no capability throttle survives anywhere', () => {
  it('the Prisma default dial ceiling is the full dial', () => {
    const schema = read('prisma/schema.prisma')
    const m = schema.match(/autonomyMaxLevel\s+String\s+@default\("([A-Z]+)"\)/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('AGGRESSIVE')
  })

  it('an unresolvable plan does not silently withdraw Tier-1 repair', () => {
    expect(SAFE_FALLBACK_LEVEL).toBe('AGGRESSIVE')
    expect(DEFAULT_LEVEL).toBe('AGGRESSIVE')
    // The band this protects: RLS repair is Tier 1. A CONSERVATIVE fallback
    // makes it unreachable, which is the failure this pins down.
    expect(isTierAutoAllowed(SAFE_FALLBACK_LEVEL, 1)).toBe(true)
  })

  it('resolves to the full dial for a project whose owner has no subscription', async () => {
    // The exact production shape the old fallback punished: a real project, a
    // real owner, no readable Subscription row.
    const userId = randomUUID()
    const projectId = randomUUID()
    await prisma.user.create({
      data: {
        id: userId,
        email: `nothrottle+${userId.slice(0, 8)}@backenly.test`,
        name: 'no-throttle fixture',
        password: 'not-a-real-hash',
      },
    })
    await prisma.project.create({
      data: { id: projectId, name: 'no-throttle', userId } as any,
    })

    try {
      const level = await getProjectAutonomyLevel(projectId)
      expect(level).toBe('AGGRESSIVE')
      expect(isTierAutoAllowed(level, 1)).toBe(true)
    } finally {
      await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
    }
  }, 120_000)

  it('still refuses Tier 2 and above at the widest setting — the floor is not a dial', () => {
    // The counterweight to everything above. Raising the ceiling must not have
    // moved the floor: auth, external credentials, destructive and irreversible
    // changes require a human at every level.
    for (const level of ['OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] as const) {
      expect(isTierAutoAllowed(level, 2)).toBe(false)
      expect(isTierAutoAllowed(level, 3)).toBe(false)
    }
  })
})
