/**
 * What a public checkout does and does not contain after the ownership cut.
 *
 * Phase 6 removed Backenly's back office from this repository. The risk in a
 * change that large is not that something breaks loudly; it is that something
 * leaves quietly that should have stayed, or stays quietly that should have
 * left. Both are invisible in a diff of seventy files.
 *
 * So this asserts the SHAPE of the public tree: the back office is gone
 * (Phase 6), the organization and fleet control plane is gone (Phase 7), and
 * the product is still here.
 *
 * These are OSS contracts, and they are only meaningful in a checkout with no
 * Cloud overlay applied. Composed Cloud restores every file this suite asserts
 * is absent, and its db:seed really does run the billing seeder, so running
 * these there would report failures for the composition working correctly. The
 * suite states that precondition rather than leaving private CI to maintain an
 * exclusion list.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/** True when the Cloud overlay has been applied over this checkout. */
const composed = fs.existsSync(path.join(process.cwd(), 'lib/cloud/manifest.json'))
const describeOss = composed ? describe.skip : describe

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/')),
)

const trackedUnder = (prefix: string) => [...tracked].filter((p) => p.startsWith(prefix))

/**
 * A file with its comments blanked.
 *
 * These assertions are about what the code DOES. Several of the modules
 * below explain in prose what used to live in them and why it left, and a
 * raw-text `not.toMatch` would read that history as the thing itself.
 */
function code(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describeOss('the back office is absent', () => {
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

describeOss('the product is still here', () => {
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

describeOss('the org and fleet control plane is absent', () => {
  it.each([
    ['app/api/org/', 'organization APIs'],
    ['lib/org/', 'organization implementation'],
    ['components/cloud/', 'Cloud-only UI'],
    ['scripts/fleet/', 'fleet operations tooling'],
    ['lib/fleet/', 'fleet orchestration'],
    ['app/app/members/', 'members page'],
    ['app/app/invite/', 'invite acceptance page'],
  ])('%s is no longer tracked (%s)', (prefix) => {
    expect(trackedUnder(prefix)).toEqual([])
  })

  it('the project access route left, and its per-project siblings stayed', () => {
    // app/api/projects/[id] is a MIXED directory: one route is team management
    // and roughly seventy are per-project product. Claiming the directory would
    // have taken the product with it.
    expect(tracked.has('app/api/projects/[id]/access/route.ts')).toBe(false)
    expect(tracked.has('app/api/projects/[id]/route.ts')).toBe(true)
    expect(tracked.has('app/api/projects/[id]/ai-functions/route.ts')).toBe(true)
    expect(tracked.has('app/api/projects/[id]/audit-logs/route.ts')).toBe(true)
  })

  it('the public project route stayed, and stayed thin', () => {
    // Explicit architecture: this route is public in both editions. What left
    // is the Cloud logic inside it, not the route.
    expect(tracked.has('app/api/projects/route.ts')).toBe(true)
    const src = code('app/api/projects/route.ts')
    expect(src).toMatch(/getProjectLifecycle/)
    // No organization attachment, no inline provisioning, no fleet listing.
    expect(src).not.toMatch(/ensurePersonalOrg/)
    expect(src).not.toMatch(/project\.create/)
    expect(src).not.toMatch(/project\.findMany/)
  })

  it('has no transition configuration left to grandfather anything', () => {
    // Phase 7 emptied the list; Phase 8 removed the key. Asserting the KEY is
    // gone rather than that the list is empty matters: reading
    // `transition.grandfathered` off an absent object throws, so the previous
    // form of this test could not survive its own success.
    const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'overlay-allowlist.json'), 'utf8'))
    expect(allowlist.transition).toBeUndefined()
  })

  it('no public module imports the organization layer', () => {
    const offenders = [...tracked]
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => /from '(@\/lib\/org|\.\.?\/org)'/.test(fs.readFileSync(path.join(ROOT, p), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describeOss('the per-project product stayed', () => {
  it('per-project PostgREST registration is still public', () => {
    // The cut line: registering ONE project schema is product, and the autonomy
    // healer auto-fixes schema_not_registered with it. Asking the Project table
    // which of every registered schema is still live is fleet, and moved.
    const src = code('lib/postgrest/registration.ts')
    expect(src).toMatch(/export async function ensureSchemaRegistered/)
    expect(src).toMatch(/export async function unregisteredSchemas/)
    expect(src).not.toMatch(/export async function reconcileAllSchemas/)
    expect(src).not.toMatch(/export async function registeredOrphans/)
  })

  it('per-project DB storage measurement is still public', () => {
    const src = code('lib/usage/db-storage.ts')
    expect(src).toMatch(/export async function snapshotProjectDbStorage/)
    // The sweep stayed too, but it enumerates nothing: it asks FleetScheduler.
    expect(src).toMatch(/getFleetScheduler/)
    expect(src).not.toMatch(/project\.findMany/)
  })

  it('no scheduled route enumerates projects without asking the scheduler', () => {
    // The Phase 7 invariant, stated mechanically: the public product does not
    // decide WHICH projects a background pass covers. A cron route may still
    // read project rows -- several report names or storage -- but only for ids
    // FleetScheduler handed it.
    //
    // Checked by import rather than by inspecting the `where`, because that is
    // the part a future edit would forget. Adding a fan-out to a route that
    // never imported the seam is the exact regression this catches.
    const offenders = [...tracked]
      .filter((p) => p.startsWith('app/api/cron/') && p.endsWith('.ts'))
      .filter((p) => /project\.findMany/.test(code(p)))
      .filter((p) => !/getFleetScheduler/.test(code(p)))
    expect(offenders).toEqual([])
  })

  it('the autonomy cron fans out without knowing how to find the fleet', () => {
    const src = code('app/api/cron/autonomy/route.ts')
    expect(src).toMatch(/getFleetScheduler\(\)\.activeTargets/)
    expect(src).toMatch(/runReconciler/)
    expect(src).not.toMatch(/project\.findMany/)
  })
})

describeOss('db:seed on a public checkout', () => {
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

describeOss('the Cloud-only environment template is gone', () => {
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
    // Phase 8: the template ships the edition explicitly even though an unset
    // one now resolves to single-tenant, because compose-cloud.sh refuses to
    // guess and reads this file when the environment is silent.
    'BACKENLY_EDITION',
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
