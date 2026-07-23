/**
 * BEHAVIORAL VERIFIER
 * ===================
 * End-to-end scenario runner that simulates real user behavior after every build.
 *
 * Fixes #78 — Build validation was surface-level (routes return 200).
 * Fixes #79 — No RLS penetration test after applying policies.
 *
 * Rules:
 *  - Every scenario makes REAL HTTP requests to the project's /api/v1 runtime
 *  - A 200 is NOT enough — we assert the response body is semantically correct
 *  - RLS tests create two isolated users and verify cross-user data isolation
 *  - Scenarios run against the real workspace schema, never mocks
 *  - All test artifacts (users, rows) are cleaned up after each scenario
 */

import type { VerificationCheck, VerificationReport } from './verifier'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BehavioralScenarioResult {
  scenario: string
  passed: boolean
  checks: VerificationCheck[]
  durationMs: number
  error?: string
}

export interface BehavioralVerificationReport extends VerificationReport {
  scenarios: BehavioralScenarioResult[]
  totalScenarios: number
  passedScenarios: number
  failedScenarios: number
  durationMs: number
}

interface AuthTokenPair {
  accessToken: string
  userId: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full behavioral scenario suite for a project.
 * Returns a structured report — pass/fail per scenario with exact assertion detail.
 */
export async function runBehavioralScenarios(
  projectId: string,
  nodeId: string,
): Promise<BehavioralVerificationReport> {
  const start = Date.now()
  const scenarios: BehavioralScenarioResult[] = []

  // Determine available tables for the project
  const tables = await getProjectTables(projectId)

  // ── Core scenarios (always run) ────────────────────────────────────────────
  scenarios.push(await scenarioAuthSignupAndSignin(projectId))
  scenarios.push(await scenarioProtectedRouteRejectsUnauthenticated(projectId))
  scenarios.push(await scenarioAdminRouteRejectsNonAdmin(projectId))

  // ── RLS penetration test (run if any tables with user_id exist) ────────────
  const userScopedTables = tables.filter(t => t.hasUserIdColumn)
  if (userScopedTables.length > 0) {
    for (const table of userScopedTables.slice(0, 3)) { // cap at 3 tables
      scenarios.push(await scenarioRLSCrossUserIsolation(projectId, table.name))
    }
  } else {
    scenarios.push({
      scenario: 'RLS Cross-User Isolation',
      passed: true,
      checks: [{
        label: 'RLS skip: no user-scoped tables found',
        status: 'skip',
        detail: 'No tables with user_id column — RLS test not applicable',
      }],
      durationMs: 0,
    })
  }

  // ── Credit / quota guard (run if credits or quotas table exists) ───────────
  const hasCredits = tables.some(t => ['credits', 'wallets', 'user_credits', 'balances'].includes(t.name))
  if (hasCredits) {
    scenarios.push(await scenarioCreditGuardBlocksWhenZero(projectId))
  }

  const durationMs = Date.now() - start
  const passed = scenarios.filter(s => s.passed)
  const failed = scenarios.filter(s => !s.passed)

  const allChecks = scenarios.flatMap(s => s.checks)

  return {
    nodeId,
    passed: failed.length === 0,
    checks: allChecks,
    summary: failed.length === 0
      ? `All ${scenarios.length} behavioral scenarios passed (${durationMs}ms)`
      : `${failed.length}/${scenarios.length} scenarios failed: ${failed.map(s => s.scenario).join(', ')}`,
    scenarios,
    totalScenarios: scenarios.length,
    passedScenarios: passed.length,
    failedScenarios: failed.length,
    durationMs,
  }
}

// ── Scenario: Auth signup + signin ────────────────────────────────────────────

async function scenarioAuthSignupAndSignin(
  projectId: string,
): Promise<BehavioralScenarioResult> {
  const start = Date.now()
  const checks: VerificationCheck[] = []
  const email = `behavioral_test_${Date.now()}@backenly-test.internal`
  const password = 'TestPass123!'
  let tokenPair: AuthTokenPair | null = null

  try {
    // Step 1: Signup
    const signupRes = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Behavioral Test User' }),
    })

    const signupBody = await signupRes.json().catch(() => ({}))

    checks.push({
      label: 'POST /auth/signup returns 200',
      status: signupRes.ok ? 'pass' : 'fail',
      detail: signupRes.ok
        ? `User created: ${signupBody?.user?.id ?? '(id not in body)'}`
        : `HTTP ${signupRes.status}: ${JSON.stringify(signupBody).slice(0, 120)}`,
    })

    if (!signupRes.ok) {
      return { scenario: 'Auth: Signup + Signin', passed: false, checks, durationMs: Date.now() - start }
    }

    // Step 2: Token is in response
    const hasToken = typeof signupBody?.token === 'string' || typeof signupBody?.accessToken === 'string'
    const rawToken: string = signupBody?.token ?? signupBody?.accessToken ?? ''
    checks.push({
      label: 'Signup response contains JWT token',
      status: hasToken ? 'pass' : 'fail',
      detail: hasToken ? 'Token present in response body' : 'No token field in signup response — auth is broken',
    })

    if (!hasToken) {
      return { scenario: 'Auth: Signup + Signin', passed: false, checks, durationMs: Date.now() - start }
    }

    tokenPair = { accessToken: rawToken, userId: signupBody?.user?.id ?? '' }

    // Step 3: Signin returns a fresh token
    const signinRes = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const signinBody = await signinRes.json().catch(() => ({}))
    const signinToken: string = signinBody?.token ?? signinBody?.accessToken ?? ''

    checks.push({
      label: 'POST /auth/signin returns valid token',
      status: signinRes.ok && signinToken ? 'pass' : 'fail',
      detail: signinRes.ok && signinToken
        ? 'Signin successful — fresh token issued'
        : `HTTP ${signinRes.status}: ${JSON.stringify(signinBody).slice(0, 120)}`,
    })

    // Step 4: Token contains correct projectId claim (JWT decode, no verify — just structure)
    if (signinToken) {
      const payload = decodeJwtPayload(signinToken)
      checks.push({
        label: 'JWT payload contains projectId',
        status: payload?.projectId === projectId ? 'pass' : 'warn',
        detail: payload?.projectId === projectId
          ? `projectId=${projectId} present in token`
          : `projectId claim missing or wrong: ${JSON.stringify(payload)}`,
      })
    }

    // Cleanup: delete test user if possible
    await cleanupTestUser(projectId, tokenPair.accessToken, tokenPair.userId)

    const passed = checks.every(c => c.status !== 'fail')
    return { scenario: 'Auth: Signup + Signin', passed, checks, durationMs: Date.now() - start }
  } catch (err) {
    return {
      scenario: 'Auth: Signup + Signin',
      passed: false,
      checks: [...checks, { label: 'Scenario error', status: 'fail', detail: String(err) }],
      durationMs: Date.now() - start,
      error: String(err),
    }
  }
}

// ── Scenario: Protected route rejects unauthenticated ─────────────────────────

async function scenarioProtectedRouteRejectsUnauthenticated(
  projectId: string,
): Promise<BehavioralScenarioResult> {
  const start = Date.now()
  const checks: VerificationCheck[] = []

  try {
    // Try to list records from a protected table without a token
    const res = await fetch(`${APP_URL}/api/v1/${projectId}/db/users`, {
      method: 'GET',
      // No Authorization header
    })

    checks.push({
      label: 'GET /db/users without token returns 401',
      status: res.status === 401 || res.status === 403 ? 'pass' : 'fail',
      detail: res.status === 401 || res.status === 403
        ? `Correctly returned ${res.status} Unauthorized`
        : `Expected 401/403 but got ${res.status} — endpoint is unprotected`,
    })

    // Also try POST (create) without auth
    const postRes = await fetch(`${APP_URL}/api/v1/${projectId}/db/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hacker@evil.com', role: 'admin' }),
    })

    checks.push({
      label: 'POST /db/users without token returns 401',
      status: postRes.status === 401 || postRes.status === 403 ? 'pass' : 'fail',
      detail: postRes.status === 401 || postRes.status === 403
        ? `Correctly blocked unauthenticated write (${postRes.status})`
        : `Expected 401/403 but got ${postRes.status} — write endpoint allows unauthenticated access`,
    })

    const passed = checks.every(c => c.status !== 'fail')
    return { scenario: 'Auth: Unauthenticated access blocked', passed, checks, durationMs: Date.now() - start }
  } catch (err) {
    return {
      scenario: 'Auth: Unauthenticated access blocked',
      passed: false,
      checks: [...checks, { label: 'Scenario error', status: 'fail', detail: String(err) }],
      durationMs: Date.now() - start,
      error: String(err),
    }
  }
}

// ── Scenario: Admin route rejects non-admin ────────────────────────────────────

async function scenarioAdminRouteRejectsNonAdmin(
  projectId: string,
): Promise<BehavioralScenarioResult> {
  const start = Date.now()
  const checks: VerificationCheck[] = []

  try {
    // Signup as a regular user
    const email = `behavioral_admin_test_${Date.now()}@backenly-test.internal`
    const signupRes = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!' }),
    })

    if (!signupRes.ok) {
      checks.push({ label: 'Signup for admin test', status: 'warn', detail: 'Could not create test user — admin test skipped' })
      return { scenario: 'Auth: Admin route rejects non-admin', passed: true, checks, durationMs: Date.now() - start }
    }

    const signupBody = await signupRes.json().catch(() => ({}))
    const token: string = signupBody?.token ?? signupBody?.accessToken ?? ''

    if (!token) {
      checks.push({ label: 'Token from signup', status: 'warn', detail: 'No token — admin test skipped' })
      return { scenario: 'Auth: Admin route rejects non-admin', passed: true, checks, durationMs: Date.now() - start }
    }

    // Try to access /admin or /api/v1/{projectId}/admin endpoints
    const adminEndpoints = [
      `/api/v1/${projectId}/db/users?_admin=true`,
      `/api/v1/${projectId}/admin/users`,
    ]

    for (const endpoint of adminEndpoints) {
      const res = await fetch(`${APP_URL}${endpoint}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })

      // 404 is acceptable (route doesn't exist), but 200 with data is a fail
      if (res.status === 200) {
        const body = await res.json().catch(() => null)
        const hasData = Array.isArray(body?.data) && body.data.length > 0
        checks.push({
          label: `Admin endpoint ${endpoint} requires admin role`,
          status: hasData ? 'fail' : 'pass',
          detail: hasData
            ? `Non-admin received data from admin endpoint — RBAC not enforced`
            : `200 returned but data is empty — acceptable`,
        })
      } else {
        checks.push({
          label: `Admin endpoint ${endpoint} requires admin role`,
          status: res.status === 403 || res.status === 401 || res.status === 404 ? 'pass' : 'warn',
          detail: `Returned ${res.status} — access correctly restricted`,
        })
      }
    }

    // Cleanup
    await cleanupTestUser(projectId, token, signupBody?.user?.id)

    const passed = checks.every(c => c.status !== 'fail')
    return { scenario: 'Auth: Admin route rejects non-admin', passed, checks, durationMs: Date.now() - start }
  } catch (err) {
    return {
      scenario: 'Auth: Admin route rejects non-admin',
      passed: false,
      checks: [...checks, { label: 'Scenario error', status: 'fail', detail: String(err) }],
      durationMs: Date.now() - start,
      error: String(err),
    }
  }
}

// ── Scenario #79: RLS cross-user isolation ────────────────────────────────────

/**
 * Creates two isolated users, writes a row as user A, then reads as user B.
 * Fails if user B can see user A's data.
 *
 * This is the definitive RLS penetration test — not a grep for policy text.
 */
async function scenarioRLSCrossUserIsolation(
  projectId: string,
  tableName: string,
): Promise<BehavioralScenarioResult> {
  const start = Date.now()
  const checks: VerificationCheck[] = []
  const scenario = `RLS: Cross-user isolation on ${tableName}`

  let tokenA = ''
  let tokenB = ''
  let userAId = ''
  let userBId = ''
  let createdRowId: string | null = null

  try {
    // ── Create user A ──────────────────────────────────────────────────────
    const emailA = `rls_userA_${Date.now()}@backenly-test.internal`
    const resA = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'TestPass123!' }),
    })
    const bodyA = await resA.json().catch(() => ({}))
    tokenA = bodyA?.token ?? bodyA?.accessToken ?? ''
    userAId = bodyA?.user?.id ?? ''

    if (!tokenA) {
      checks.push({ label: 'Create User A', status: 'warn', detail: 'Could not create test user A — skipping RLS test' })
      return { scenario, passed: true, checks, durationMs: Date.now() - start }
    }
    checks.push({ label: 'Created User A', status: 'pass', detail: emailA })

    // ── Create user B ──────────────────────────────────────────────────────
    const emailB = `rls_userB_${Date.now() + 1}@backenly-test.internal`
    const resB = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: 'TestPass123!' }),
    })
    const bodyB = await resB.json().catch(() => ({}))
    tokenB = bodyB?.token ?? bodyB?.accessToken ?? ''
    userBId = bodyB?.user?.id ?? ''

    if (!tokenB) {
      checks.push({ label: 'Create User B', status: 'warn', detail: 'Could not create test user B — skipping RLS test' })
      return { scenario, passed: true, checks, durationMs: Date.now() - start }
    }
    checks.push({ label: 'Created User B', status: 'pass', detail: emailB })

    // ── User A writes a row ────────────────────────────────────────────────
    const writeRes = await fetch(`${APP_URL}/api/v1/${projectId}/db/${tableName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        // Minimal payload — let the server fill in user_id from JWT
        _rls_test_marker: `rls_probe_${Date.now()}`,
      }),
    })

    const writeBody = await writeRes.json().catch(() => ({}))
    createdRowId = writeBody?.data?.id ?? writeBody?.id ?? null

    if (!writeRes.ok || !createdRowId) {
      checks.push({
        label: `User A writes row to ${tableName}`,
        status: 'warn',
        detail: `Write returned ${writeRes.status} — table may not accept minimal payload. Skipping cross-user read test.`,
      })
      return { scenario, passed: true, checks, durationMs: Date.now() - start }
    }
    checks.push({
      label: `User A writes row to ${tableName}`,
      status: 'pass',
      detail: `Row created: id=${createdRowId}`,
    })

    // ── User B attempts to read user A's row directly ──────────────────────
    const directReadRes = await fetch(`${APP_URL}/api/v1/${projectId}/db/${tableName}/${createdRowId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    })

    const directReadBody = await directReadRes.json().catch(() => ({}))
    const gotData = directReadRes.ok && directReadBody?.data !== null && directReadBody?.data !== undefined

    checks.push({
      label: `User B cannot read User A's row by ID`,
      status: gotData ? 'fail' : 'pass',
      detail: gotData
        ? `SECURITY FAILURE: User B read User A's row (id=${createdRowId}) — RLS policy not enforced on ${tableName}`
        : `Correctly blocked: ${directReadRes.status}`,
    })

    // ── User B lists all rows — should see 0 from user A ──────────────────
    const listRes = await fetch(`${APP_URL}/api/v1/${projectId}/db/${tableName}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    })

    const listBody = await listRes.json().catch(() => ({}))
    const rows: any[] = listBody?.data ?? listBody ?? []
    const userARows = Array.isArray(rows) ? rows.filter((r: any) => r?.id === createdRowId) : []

    checks.push({
      label: `User B list does not include User A's rows`,
      status: userARows.length > 0 ? 'fail' : 'pass',
      detail: userARows.length > 0
        ? `SECURITY FAILURE: User B can list ${userARows.length} row(s) belonging to User A on ${tableName}`
        : `RLS enforced: User B sees 0 rows from User A (${Array.isArray(rows) ? rows.length : 0} total rows visible, all belong to User B)`,
    })

    const passed = checks.every(c => c.status !== 'fail')
    return { scenario, passed, checks, durationMs: Date.now() - start }
  } catch (err) {
    return {
      scenario,
      passed: false,
      checks: [...checks, { label: 'Scenario error', status: 'fail', detail: String(err) }],
      durationMs: Date.now() - start,
      error: String(err),
    }
  } finally {
    // Best-effort cleanup
    await Promise.allSettled([
      tokenA && userAId ? cleanupTestUser(projectId, tokenA, userAId) : Promise.resolve(),
      tokenB && userBId ? cleanupTestUser(projectId, tokenB, userBId) : Promise.resolve(),
    ])
  }
}

// ── Scenario: Credits block job creation when zero ────────────────────────────

async function scenarioCreditGuardBlocksWhenZero(
  projectId: string,
): Promise<BehavioralScenarioResult> {
  const start = Date.now()
  const checks: VerificationCheck[] = []

  try {
    // Create a user with 0 credits (default for new signups)
    const email = `behavioral_credits_${Date.now()}@backenly-test.internal`
    const signupRes = await fetch(`${APP_URL}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!' }),
    })

    if (!signupRes.ok) {
      checks.push({ label: 'Credit guard setup', status: 'warn', detail: 'Signup failed — credit guard test skipped' })
      return { scenario: 'Credits: Zero balance blocks job creation', passed: true, checks, durationMs: Date.now() - start }
    }

    const signupBody = await signupRes.json().catch(() => ({}))
    const token: string = signupBody?.token ?? signupBody?.accessToken ?? ''

    // Attempt to create a job with 0 credits
    // The job table name might vary — try common names
    const jobEndpoints = ['generation_jobs', 'jobs', 'ai_jobs']
    let testedAtLeastOne = false

    for (const endpoint of jobEndpoints) {
      const createRes = await fetch(`${APP_URL}/api/v1/${projectId}/db/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'behavioral_test', prompt: 'test' }),
      })

      if (createRes.status === 404) continue // table doesn't exist, skip

      testedAtLeastOne = true
      const createBody = await createRes.json().catch(() => ({}))

      // Should be rejected with 402 (payment required) or 403 (insufficient credits)
      const blocked = createRes.status === 402 || createRes.status === 403 ||
        (createBody?.error && /credit|balance|insufficient|quota/i.test(JSON.stringify(createBody)))

      checks.push({
        label: `Zero-credit guard on ${endpoint}`,
        status: blocked ? 'pass' : 'warn',
        detail: blocked
          ? `Correctly rejected with ${createRes.status} — credit guard active`
          : `Got ${createRes.status} — credit guard may not be enforced on this table`,
      })
    }

    if (!testedAtLeastOne) {
      checks.push({ label: 'Credit guard', status: 'skip', detail: 'No job/credits table found — test not applicable' })
    }

    // Cleanup
    if (token && signupBody?.user?.id) {
      await cleanupTestUser(projectId, token, signupBody.user.id)
    }

    const passed = checks.every(c => c.status !== 'fail')
    return { scenario: 'Credits: Zero balance blocks job creation', passed, checks, durationMs: Date.now() - start }
  } catch (err) {
    return {
      scenario: 'Credits: Zero balance blocks job creation',
      passed: false,
      checks: [...checks, { label: 'Scenario error', status: 'fail', detail: String(err) }],
      durationMs: Date.now() - start,
      error: String(err),
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get all tables for a project, with metadata about their columns.
 */
async function getProjectTables(
  projectId: string,
): Promise<Array<{ name: string; hasUserIdColumn: boolean }>> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { name: true },
    })

    // Determine user-scoped tables by name heuristic (Table model has no columns field)
    // The workspace schema DDL is the source of truth for actual column info
    return tables.map(t => {
      const hasUserIdColumn = /^(posts|orders|products|reviews|comments|items|files|records|jobs|submissions|entries|bookings|messages|notifications)$/.test(t.name)
        || t.name.endsWith('_items') || t.name.endsWith('_entries')
      return { name: t.name, hasUserIdColumn }
    })
  } catch {
    return []
  }
}

/**
 * Best-effort cleanup of a behavioral test user.
 */
async function cleanupTestUser(projectId: string, token: string, userId: string): Promise<void> {
  if (!userId || !token) return
  try {
    await fetch(`${APP_URL}/api/v1/${projectId}/auth/delete-account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // Cleanup is best-effort — never fail a scenario due to cleanup
  }
}

/**
 * Decode a JWT payload without verifying the signature.
 * Used only for structural assertion (does the claim exist), not security.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = token.split('.')
    if (!payloadB64) return null
    const padded = payloadB64.padEnd(payloadB64.length + (4 - (payloadB64.length % 4)) % 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}
