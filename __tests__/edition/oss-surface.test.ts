/**
 * What a public checkout does and does not contain after the ownership cut.
 *
 * Phase 6 removed Backenly's back office from this repository. The risk in a
 * change that large is not that something breaks loudly; it is that something
 * leaves quietly that should have stayed, or stays quietly that should have
 * left. Both are invisible in a diff of seventy files.
 *
 * So this asserts the SHAPE of the public tree: the back office is gone, the
 * product is not, and the Phase 7 surfaces are still here because Phase 7 has
 * not run.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/')),
)

const trackedUnder = (prefix: string) => [...tracked].filter((p) => p.startsWith(prefix))

describe('the back office is absent', () => {
  it.each([
    ['app/admin/', 'admin console'],
    ['app/api/admin/', 'admin API'],
    ['lib/admin/', 'founder auth'],
    ['lib/billing/', 'commercial billing'],
    ['app/api/billing/', 'billing API'],
    ['app/app/billing/', 'billing pages'],
    ['app/api/referral/', 'referral API'],
    ['app/app/referral/', 'referral page'],
    ['lib/trust/', 'Cloud admission scoring'],
    ['lib/analytics/', 'founder funnel telemetry'],
    ['lib/platform/', 'founder kill-switch writer'],
  ])('%s is no longer tracked (%s)', (prefix) => {
    expect(trackedUnder(prefix)).toEqual([])
  })

  it.each([
    'prisma/seed-billing.ts',
    'components/app/AmplitudeAnalytics.tsx',
    'app/api/users/route.ts',
    'app/api/cron/grace-check/route.ts',
    'app/api/cron/process-grace-periods/route.ts',
  ])('%s is no longer tracked', (file) => {
    expect(tracked.has(file)).toBe(false)
  })
})

describe('the product is still here', () => {
  it.each([
    'lib/entitlements/policy.ts',
    'lib/platform-controls/signup-slot.ts',
    'lib/platform-controls/blocklist.ts',
    'lib/platform-controls/security-events.ts',
    'lib/platform-controls/project-lockdown.ts',
    'lib/platform-controls/account-standing.ts',
    'lib/projects/sandbox-lifecycle.ts',
    'lib/projects/milestones.ts',
    'lib/usage/db-storage.ts',
    'lib/fleet/db-storage-sweep.ts',
    'lib/auth/signup-email-eligibility.ts',
    'app/api/cron/autonomy/route.ts',
    'app/api/cron/daily-backup/route.ts',
    'app/api/cron/storage-cleanup/route.ts',
    'app/api/cron/workspace-observer/route.ts',
    'app/api/cron/reap-abandoned-signups/route.ts',
  ])('%s is tracked', (file) => {
    expect(tracked.has(file)).toBe(true)
  })

  it('the sibling user routes stayed, because only one of them was back office', () => {
    // app/api/users is a MIXED directory. Claiming the whole thing would have
    // removed two public product routes with it.
    expect(tracked.has('app/api/users/[userId]/route.ts')).toBe(true)
    expect(tracked.has('app/api/users/stats/route.ts')).toBe(true)
  })

  it('the public gate-and-charge test stayed, because it tests a public contract', () => {
    // __tests__/billing is mixed too: two suites moved private, this one did
    // not, because enforceAiCredits and chargeAiCredits are both public.
    expect(tracked.has('__tests__/billing/model-backed-tools-are-charged.test.ts')).toBe(true)
  })
})

describe('Phase 7 has not happened', () => {
  it('org and fleet surfaces are still public', () => {
    // Removing these here would be Phase 7 work done early and unannounced.
    expect(trackedUnder('app/api/org/').length).toBe(7)
    expect(tracked.has('lib/org/index.ts')).toBe(true)
    expect(tracked.has('components/cloud/OrgSwitcher.tsx')).toBe(true)
    expect(trackedUnder('scripts/fleet/').length).toBe(5)
  })

  it('the transition list holds exactly the Phase 7 remainder', () => {
    const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'overlay-allowlist.json'), 'utf8'))
    const remaining: string[] = allowlist.transition.grandfathered

    expect(remaining).toHaveLength(14)
    // Every survivor must be an org, fleet or Cloud-UI path. Anything else
    // means a Phase 6 file was left behind rather than moved.
    for (const p of remaining) {
      expect(p).toMatch(/^(app\/api\/org\/|lib\/org\/|components\/cloud\/|scripts\/fleet\/)/)
    }
  })
})

describe('db:seed on a public checkout', () => {
  it('needs no billing seeder and no Plan row', () => {
    expect(tracked.has('prisma/seed-billing.ts')).toBe(false)
    expect(tracked.has('scripts/db-seed.ts')).toBe(true)

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    // Pointing straight at a file OSS does not ship would make db:seed fail
    // with a module-not-found on a fresh clone.
    expect(pkg.scripts['db:seed']).not.toContain('prisma/seed-billing.ts')
    expect(pkg.scripts['db:seed']).toContain('scripts/db-seed.ts')
  })

  it('succeeds, and says why there is nothing to do', () => {
    const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/db-seed.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(out).toMatch(/No billing seed in this checkout/)
  })

  it('does not manufacture a Plan or Subscription to keep an old assumption alive', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/db-seed.ts'), 'utf8')
    expect(src).not.toMatch(/plan\.(create|upsert)/i)
    expect(src).not.toMatch(/subscription\.(create|upsert)/i)
  })
})

describe('the Cloud-only environment template is gone', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')

  it.each([
    'PADDLE_VENDOR_ID',
    'PADDLE_API_KEY',
    'PADDLE_PUBLIC_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PLAN_ID_PRO',
    'PADDLE_PLAN_ID_ENTERPRISE',
    'PADDLE_ENVIRONMENT',
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
  ])('%s is not offered to self-hosters', (name) => {
    expect(env).not.toContain(`${name}=`)
  })

  it.each([
    // CRON_SECRET guards ten public self-host cron routes including autonomy.
    'CRON_SECRET',
    // Its route, /api/cron/reap-abandoned-signups, is still public.
    'ABANDONED_SIGNUP_GRACE_DAYS',
    'JWT_SECRET',
    'POSTGREST_JWT_SECRET',
    'STORAGE_SECRET',
    'DATABASE_URL',
    'ENABLE_AUTONOMY_RECONCILER',
    'ENABLE_AUTONOMY_LIVE_EXECUTION',
  ])('%s is still documented', (name) => {
    expect(env).toContain(`${name}=`)
  })
})
