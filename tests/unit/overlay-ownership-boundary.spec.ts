/**
 * Phase 4 ownership boundaries, and the guard that protects them.
 *
 * Phase 4 moved four things so that entire DIRECTORIES can later become private
 * overlay ownership units, instead of private and public files sharing one
 * directory forever. The moves themselves are trivial to undo by accident: an
 * editor auto-import, a merge, a "this file feels like it belongs in lib/auth"
 * judgement call. Nothing about the code stops it. This does.
 *
 * The second half is the more important half. `scripts/verify-overlay-boundary.ts`
 * is the guard that keeps the private overlay add-only, and a guard nobody has
 * ever watched fail is not known to work -- Phase 1 learned that from suites
 * that passed vacuously against a stub. So every rule it claims to enforce is
 * mutation-tested here: the map is deliberately broken, and the guard must
 * reject it.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ROOT = process.cwd()
const VERIFIER = 'scripts/verify-overlay-boundary.ts'
const ALLOWLIST_PATH = path.join(ROOT, 'overlay-allowlist.json')

interface Allowlist {
  version: number
  private: string[]
  transition?: { grandfathered: string[]; expiresAfterPhase?: number }
}

const allowlist: Allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))

/** Files git actually tracks. The only honest answer to "is this public?". */
const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean),
)

/**
 * This spec names the old paths in its own assertions, so it matches every
 * regex below. Exempting exactly this one file keeps the audit honest for
 * everything else; a broader "skip tests" rule would let a real stale import
 * hide in any suite.
 */
const SELF = 'tests/unit/overlay-ownership-boundary.spec.ts'

/** Content of every tracked text file, for import audits that must not miss a form. */
function trackedFilesMatching(re: RegExp): string[] {
  const hits: string[] = []
  for (const file of tracked) {
    if (file === SELF) continue
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|prisma|ya?ml|sh|example)$/.test(file)) continue
    let body: string
    try {
      body = fs.readFileSync(path.join(ROOT, file), 'utf8')
    } catch {
      continue
    }
    if (re.test(body)) hits.push(file)
  }
  return hits
}

interface Run {
  status: number
  stdout: string
  stderr: string
}

function runVerifier(args: string[] = []): Run {
  const res = require('child_process').spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', VERIFIER, ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Run the guard against a deliberately broken ownership map. */
function runWithAllowlist(mutate: (a: Allowlist) => void, args: string[] = []): Run {
  const copy: Allowlist = JSON.parse(JSON.stringify(allowlist))
  mutate(copy)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-allowlist-'))
  const file = path.join(tmp, 'mutated.json')
  fs.writeFileSync(file, JSON.stringify(copy, null, 2))
  try {
    return runVerifier(['--allowlist', file, ...args])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function withOverlay(files: Record<string, string>, fn: (dir: string) => Run): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-tree-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, body)
    }
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// MOVE 1 -- quota kernel is public product, out of future-private lib/billing
// ---------------------------------------------------------------------------

describe('MOVE 1: quota kernel is public', () => {
  it('lives at lib/quota/kernel.ts', () => {
    expect(tracked.has('lib/quota/kernel.ts')).toBe(true)
  })

  it('no longer exists under lib/billing', () => {
    expect(tracked.has('lib/billing/quota-kernel.ts')).toBe(false)
  })

  it('is not under any private-owned path', () => {
    // Quota enforcement runs on the API, MCP, storage, realtime and end-user
    // auth hot paths. If the overlay owned it, the public product could not
    // enforce its own limits.
    for (const entry of allowlist.private) {
      const prefix = entry.endsWith('/**') ? entry.slice(0, -2) : entry
      expect('lib/quota/kernel.ts'.startsWith(prefix)).toBe(false)
    }
  })

  it('no tracked file references the old path in any form', () => {
    // Static imports, dynamic imports and prose all at once: the dynamic
    // `await import('./quota-kernel')` in lib/billing/index.ts was invisible to
    // an alias-shaped search and would have failed only at runtime.
    expect(trackedFilesMatching(/quota-kernel/)).toEqual([])
  })

  it('public runtime call sites import the public path', () => {
    const callers = [
      'lib/api/v1/middleware.ts',
      'lib/mcp/guard.ts',
      'lib/realtime/listener-hub.ts',
      'lib/services/storageQuota.ts',
      'lib/services/end-user-auth-flows.ts',
      'lib/ai/build-runtime/mutate.ts',
      'server/routes/oauth.ts',
      'app/api/v1/[projectId]/auth/signin/route.ts',
      'app/api/v1/[projectId]/auth/signup/route.ts',
    ]
    for (const caller of callers) {
      expect(tracked.has(caller)).toBe(true)
      const body = fs.readFileSync(path.join(ROOT, caller), 'utf8')
      expect(body).toMatch(/@\/lib\/quota\/kernel/)
    }
  })
})

// ---------------------------------------------------------------------------
// MOVE 2 -- back-office admin auth, and ONLY that, under lib/admin/auth
// ---------------------------------------------------------------------------

describe('MOVE 2: admin auth primitives', () => {
  const ADMIN_AUTH = ['requireFounder.ts', 'adminStepUp.ts', 'adminSigning.ts']

  it('left public tracking with the rest of the back office', () => {
    // Phase 4 moved these under lib/admin/auth so the whole directory could go
    // private in one piece. Phase 6 did that, so the assertion is now the
    // opposite one: nothing admin remains publicly tracked. What Phase 4 was
    // really guarding is the line below, that they never drifted back into
    // lib/auth alongside the product's own authentication.
    for (const f of ADMIN_AUTH) expect(tracked.has(`lib/admin/auth/${f}`)).toBe(false)
    expect([...tracked].filter(p => p.startsWith('lib/admin/'))).toEqual([])
  })

  it('no longer sit in lib/auth', () => {
    for (const f of ADMIN_AUTH) expect(tracked.has(`lib/auth/${f}`)).toBe(false)
  })

  it('left product and end-user auth in lib/auth', () => {
    // The failure this guards against is over-reach: sweeping the whole of
    // lib/auth private because three founder-console files lived there. These
    // are the primitives every project, API key, MCP and end-user request
    // depends on, and they are OSS.
    for (const f of [
      'middleware.ts',
      'jwt.ts',
      'jwt-secret.ts',
      'apiKeyAuth.ts',
      'session.ts',
      'rbac.ts',
      'project-access.ts',
      'password.ts',
      'oidc-delegation.ts',
    ]) {
      expect(tracked.has(`lib/auth/${f}`)).toBe(true)
    }
  })

  it('are referenced by nothing at the old paths', () => {
    expect(trackedFilesMatching(/lib\/auth\/(requireFounder|adminStepUp|adminSigning)/)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MOVE 3 -- trust / abuse intelligence under lib/trust
// ---------------------------------------------------------------------------

describe('MOVE 3: trust and admission intelligence', () => {
  // Phase 4 put four files under lib/trust. Phase 6 then classified them by
  // responsibility rather than by directory, and two legitimately left:
  //
  //   email-eligibility  -> lib/auth/signup-email-eligibility.ts
  //        pure, deterministic, already in the browser bundle, and imported by
  //        the public signup page. Client-safe validation, not intelligence.
  //   account-standing   -> lib/platform-controls/account-standing.ts
  //        suspension is an operator decision that public auth already enforces
  //        in lib/auth/{middleware,server,session}; its untrusted branch is
  //        inert in single-tenant because only Cloud scoring sets that level.
  //
  // What remains under lib/trust is the part that scores a stranger.
  const TRUST = ['bot-defense.ts', 'email-trust.ts']
  const LEFT_BY_CLASSIFICATION = {
    'lib/auth/signup-email-eligibility.ts': 'lib/trust/email-eligibility.ts',
    'lib/platform-controls/account-standing.ts': 'lib/trust/account-standing.ts',
  } as const

  it('left public tracking with the rest of the back office', () => {
    // Same story as MOVE 2. Phase 4 gathered the scoring under lib/trust so it
    // could leave in one piece; Phase 6 removed it. The two files Phase 6
    // reclassified are asserted separately below, because those did NOT leave.
    for (const f of TRUST) expect(tracked.has(`lib/trust/${f}`)).toBe(false)
    expect([...tracked].filter(p => p.startsWith('lib/trust/'))).toEqual([])
  })

  it('no longer sits in lib/auth', () => {
    for (const f of TRUST) expect(tracked.has(`lib/auth/${f}`)).toBe(false)
  })

  it('is referenced by nothing at the old paths', () => {
    expect(trackedFilesMatching(/lib\/auth\/(bot-defense|email-trust)\./)).toEqual([])
  })

  it('the two reclassified files moved rather than being copied', () => {
    // A copy would leave the public product depending on a module that is
    // leaving, which is exactly what the reclassification was for.
    for (const [now, before] of Object.entries(LEFT_BY_CLASSIFICATION)) {
      expect(tracked.has(now)).toBe(true)
      expect(tracked.has(before)).toBe(false)
    }
  })

  it('keeps the single-tenant first-operator admission gate where it was', () => {
    // Phase 3's clean-machine acceptance turns on this exception staying
    // exactly as narrow as it was: single-tenant edition AND zero platform
    // users. Phase 4 moved file paths; Phase 6 moved the gate into
    // lib/platform-controls and handed only the SCORING to the private seam.
    // The policy itself is unchanged and still public.
    const admission = fs.readFileSync(path.join(ROOT, 'lib/platform-controls/signup-admission.ts'), 'utf8')
    expect(admission).toMatch(/single-tenant|selfHostedRegistrationClosed/)
    expect(admission).toMatch(/firstSelfHostedOperator/)
    // The scoring is reached through the seam, never imported directly.
    expect(admission).toMatch(/@\/lib\/platform-signals/)
    expect(admission).not.toMatch(/@\/lib\/trust/)

    const slot = fs.readFileSync(path.join(ROOT, 'lib/platform-controls/signup-slot.ts'), 'utf8')
    expect(slot).toMatch(/BACKENLY_ALLOW_PUBLIC_SIGNUP/)
    expect(slot).toMatch(/pg_advisory_xact_lock/)
  })
})

// ---------------------------------------------------------------------------
// MOVE 4 -- Cloud UI and fleet tooling in whole private-ready directories
// ---------------------------------------------------------------------------

describe('MOVE 4: Cloud UI and fleet scripts', () => {
  it('OrgSwitcher is under components/cloud', () => {
    expect(tracked.has('components/cloud/OrgSwitcher.tsx')).toBe(true)
    expect(tracked.has('components/shell/OrgSwitcher.tsx')).toBe(false)
    expect(trackedFilesMatching(/components\/shell\/OrgSwitcher/)).toEqual([])
  })

  it('TopBar imports it from its new home', () => {
    const topbar = fs.readFileSync(path.join(ROOT, 'components/shell/TopBar.tsx'), 'utf8')
    expect(topbar).toMatch(/@\/components\/cloud\/OrgSwitcher/)
  })

  it('fleet-wide scripts are under scripts/fleet', () => {
    for (const s of [
      'autonomy-fleet-check',
      'purge-projects',
      'purge-orphan-schemas',
      'sandbox-cleanup',
      'load-test',
    ]) {
      expect(tracked.has(`scripts/fleet/${s}.ts`)).toBe(true)
      expect(tracked.has(`scripts/${s}.ts`)).toBe(false)
    }
  })

  it('keeps self-host and project-local scripts public', () => {
    // These are how someone stands up a single OSS deployment. Sweeping them
    // into scripts/fleet would hand the OSS operator's own setup tooling to
    // the private overlay in Phase 7 and leave self-hosting unusable.
    for (const s of [
      'scripts/bootstrap.ts',
      'scripts/bootstrap-prerequisites.ts',
      'scripts/postgrest-install.sh',
      'scripts/setup-postgrest-roles.ts',
      'scripts/preflight-oss.ts',
      'scripts/verify-project-authorization.ts',
      'scripts/verify-suite-accounting.ts',
      'scripts/run-stress-test-500.ts',
      'scripts/real-db-concurrency-test.ts',
    ]) {
      expect(tracked.has(s)).toBe(true)
      expect(s.startsWith('scripts/fleet/')).toBe(false)
    }
  })

  it('the moved load test resolves lib from its new depth', () => {
    // scripts/lib/ exists, so a stale `../lib/...` from scripts/fleet/ would
    // resolve into it rather than failing loudly.
    const body = fs.readFileSync(path.join(ROOT, 'scripts/fleet/load-test.ts'), 'utf8')
    expect(body).toMatch(/from '\.\.\/\.\.\/lib\//)
    expect(body).not.toMatch(/from '\.\.\/lib\//)
  })
})

// ---------------------------------------------------------------------------
// The ownership map
// ---------------------------------------------------------------------------

describe('overlay-allowlist.json', () => {
  it('declares exactly the intended private destinations', () => {
    expect([...allowlist.private].sort()).toEqual(
      [
        '__tests__/analytics/amplitude-config.test.tsx',
        '__tests__/analytics/amplitude-resilience.test.tsx',
        '__tests__/billing/cancellation-and-grace.test.ts',
        '__tests__/billing/free-plan-resolution.test.ts',
        '__tests__/cloud/**',
        '__tests__/lib/agent-ops.test.ts',
        '__tests__/security/admin-step-up.test.ts',
        'app/admin/**',
        'app/api/admin/**',
        'app/api/billing/**',
        'app/api/cron/grace-check/route.ts',
        'app/api/cron/process-grace-periods/route.ts',
        'app/api/org/**',
        'app/api/referral/**',
        'app/api/users/route.ts',
        'app/app/billing/**',
        'app/app/referral/**',
        'components/app/AmplitudeAnalytics.tsx',
        'components/cloud/**',
        'config/cloud/**',
        'lib/admin/**',
        'lib/analytics/**',
        'lib/billing/**',
        'lib/cloud/**',
        'lib/org/**',
        'lib/platform/**',
        'lib/trust/**',
        'prisma/seed-billing.ts',
        'scripts/fleet/**',
        'tests/auth/email-trust.test.ts',
        'tests/core/autonomy-entitlements-are-seeded.test.ts',
      ].sort(),
    )
  })

  it('uses a named file only where the directory is mixed', () => {
    // Whole-directory ownership is the default because it means the overlay
    // only ever ADDS files. Every exception below is a private file living in
    // a directory that also holds public product, where claiming the directory
    // would drag public code private with it:
    //
    //   app/api/users/         [userId] and stats are public product routes
    //   app/api/cron/          ten of its routes are self-host jobs
    //   components/app/        public product components
    //   __tests__/billing/     model-backed-tools-are-charged tests a public contract
    //   __tests__/lib/, __tests__/security/, tests/auth/, __tests__/analytics/
    //                          public suites live alongside
    //   prisma/                schema.prisma is public and single-copy
    //   tests/core/            the rest of tests/core is public autonomy coverage
    const files = allowlist.private.filter(p => !p.endsWith('/**'))
    expect(files.sort()).toEqual(
      [
        '__tests__/analytics/amplitude-config.test.tsx',
        '__tests__/analytics/amplitude-resilience.test.tsx',
        '__tests__/billing/cancellation-and-grace.test.ts',
        '__tests__/billing/free-plan-resolution.test.ts',
        '__tests__/lib/agent-ops.test.ts',
        '__tests__/security/admin-step-up.test.ts',
        'app/api/cron/grace-check/route.ts',
        'app/api/cron/process-grace-periods/route.ts',
        'app/api/users/route.ts',
        'components/app/AmplitudeAnalytics.tsx',
        'prisma/seed-billing.ts',
        'tests/auth/email-trust.test.ts',
        'tests/core/autonomy-entitlements-are-seeded.test.ts',
      ].sort(),
    )
  })

  it('owns no public product code', () => {
    // Cloud value is managed infrastructure and governance. Withholding the
    // brain, the data plane, the per-project reconciler, the runtime or the
    // published packages would be weakening the product to manufacture it.
    const forbidden = [
      'lib/ai/brain/',
      'lib/autonomy/',
      'lib/postgrest/',
      'lib/services/',
      'lib/edition/',
      'lib/quota/',
      'server/',
      'packages/',
    ]
    for (const entry of allowlist.private) {
      for (const pub of forbidden) {
        expect(entry.startsWith(pub)).toBe(false)
      }
    }
  })

  it('owns no shared infrastructure file', () => {
    for (const shared of [
      'package.json',
      'package-lock.json',
      'next.config.js',
      'middleware.ts',
      'ecosystem.config.js',
      'prisma/schema.prisma',
      'app/layout.tsx',
    ]) {
      expect(allowlist.private).not.toContain(shared)
    }
  })

  it('grandfathers only files that are really still public', () => {
    for (const file of allowlist.transition?.grandfathered ?? []) {
      expect(tracked.has(file)).toBe(true)
    }
  })

  it('grandfathers every public file under a private-owned path, and no others', () => {
    const prefixes = allowlist.private.filter(p => p.endsWith('/**')).map(p => p.slice(0, -2))
    const exact = new Set(allowlist.private.filter(p => !p.endsWith('/**')))
    const under = [...tracked]
      .filter(f => exact.has(f) || prefixes.some(pre => f.startsWith(pre)))
      .sort()
    expect([...(allowlist.transition?.grandfathered ?? [])].sort()).toEqual(under)
  })
})

// ---------------------------------------------------------------------------
// The guard itself, mutation-tested
// ---------------------------------------------------------------------------

describe('verify-overlay-boundary', () => {
  it('passes on the committed map', () => {
    const run = runVerifier()
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/ok \(transition\)/)
  })

  it('still fails in --strict mode today, so strict mode is known to work', () => {
    // Phase 8 flips CI to --strict once the grandfather list empties. A strict
    // mode that has never been observed rejecting anything would be a mode
    // nobody could trust at the moment it starts mattering.
    const run = runVerifier(['--strict'])
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/public file still tracked under private-owned/)
  })

  it('rejects private ownership of shared infrastructure', () => {
    const run = runWithAllowlist(a => a.private.push('package.json'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/shared public infrastructure/)
  })

  it('rejects private ownership of a shared file via its parent directory', () => {
    const run = runWithAllowlist(a => a.private.push('prisma/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/shared public infrastructure "prisma\/schema\.prisma"/)
  })

  it('rejects private ownership of public product code', () => {
    const run = runWithAllowlist(a => a.private.push('lib/ai/brain/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/public product code/)
  })

  it('rejects private ownership of the relocated quota kernel', () => {
    const run = runWithAllowlist(a => a.private.push('lib/quota/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/public product code "lib\/quota\//)
  })

  it('rejects a directory entry that is not whole-directory', () => {
    const run = runWithAllowlist(a => a.private.push('lib/billing'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/missing the "\/\*\*" suffix/)
  })

  it('rejects a mid-path wildcard', () => {
    const run = runWithAllowlist(a => a.private.push('app/*/admin/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/may only wildcard a whole trailing directory/)
  })

  it('rejects an upward traversal', () => {
    const run = runWithAllowlist(a => a.private.push('../secrets/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/must not traverse upward/)
  })

  it('rejects a duplicated entry', () => {
    const run = runWithAllowlist(a => a.private.push('lib/billing/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/listed twice/)
  })

  it('rejects a NEW public file under a private-owned path', () => {
    // The transition state must not be able to widen silently. Claiming a
    // directory that still holds ungrandfathered public files is exactly how
    // it would.
    const run = runWithAllowlist(a => a.private.push('lib/notifications/**'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/new public file under private-owned/)
  })

  it('rejects a grandfather entry for a file that no longer exists', () => {
    // Phase 6/7 delete files and must prune the list in the same commit, so
    // the exemption cannot outlive the thing it exempts.
    const run = runWithAllowlist(a => a.transition?.grandfathered.push('lib/billing/gone.ts'))
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/stale grandfather entry/)
  })

  it('accepts an overlay that only adds files in allowlisted paths', () => {
    const run = withOverlay(
      { 'lib/cloud/fleet.ts': 'export const x = 1\n', 'config/cloud/app.json': '{}\n' },
      dir => runVerifier(['--overlay', dir]),
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/ok \(overlay/)
  })

  it('fails when an overlay file would overwrite a tracked public file', () => {
    // The whole point of the boundary: the public repository must stay a
    // truthful description of what Cloud runs.
    // lib/org/index.ts is the right example now: allowlisted for the overlay
    // AND still tracked publicly, because Phase 7 has not moved it yet. A path
    // Phase 6 already removed would test nothing, since the overlay is meant
    // to provide those.
    const run = withOverlay({ 'lib/org/index.ts': '// clobbered\n' }, dir =>
      runVerifier(['--overlay', dir]),
    )
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/would overwrite a tracked public file/)
  })

  it('fails when an overlay file lands outside every allowlisted path', () => {
    const run = withOverlay({ 'lib/ai/brain/secret-operator.ts': 'export const y = 2\n' }, dir =>
      runVerifier(['--overlay', dir]),
    )
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/outside every allowlisted private path/)
  })

  it('fails closed when the ownership map is missing', () => {
    const run = runVerifier(['--allowlist', 'does-not-exist.json'])
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/ownership map not found/)
  })
})
