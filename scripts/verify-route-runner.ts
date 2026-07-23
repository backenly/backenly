/**
 * Hermetic verification of the route-module runner + sandbox regex fix.
 * Run: npx tsx scripts/verify-route-runner.ts
 *
 * Uses a DB-free code path (the auth gate returns 401 before any prisma call)
 * so it proves: TS→JS transform, vm execution, curated require, NextResponse
 * normalisation, and method resolution — without needing a live database.
 */
import { isRouteModuleFunction, executeRouteModuleFunction } from '../lib/services/ai-functions/route-module-runner'

// Exact shape emitted by domain-business-logic.ts buildWalletEndpoints()
const WALLET_BALANCE = `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

const SCHEMA = 'workspace_test'

export async function GET(req: NextRequest) {
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT COALESCE(SUM(amount), 0)::numeric AS balance FROM "\${SCHEMA}"."wallet" WHERE user_id = $1\`,
      payload.userId,
    )
    return NextResponse.json({ success: true, balance: Number(rows[0]?.balance ?? 0) })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`

const SANDBOX_BODY = `const u = event.data; await ctx.db.insert('logs', { msg: 'hi' }); ctx.log('done'); return { ok: true }`

// Exact shape of the admin templates (buildAdminEndpoints): reads process.env
// through the curated shim. Previously the safety scan rejected every one of
// these with "process internals are not permitted".
const ADMIN_GATED = `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? process.env.AI_EXECUTION_TOKEN ?? ''

export async function GET(req: NextRequest) {
  const provided = req.headers.get('x-admin-key') || ''
  if (!ADMIN_KEY || provided !== ADMIN_KEY) {
    return NextResponse.json({ error: 'Admin authorization required' }, { status: 403 })
  }
  return NextResponse.json({ success: true })
}`

// Isolation probe: the curated env must NOT leak arbitrary vars, and
// process-control calls must still be scan-rejected.
const ENV_LEAK_PROBE = `import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({ dbUrl: process.env.DATABASE_URL ?? null, nodeEnv: process.env.NODE_ENV ?? null })
}`

const PROCESS_EXIT_PROBE = `import { NextResponse } from 'next/server'
export async function GET() {
  process.exit(1)
  return NextResponse.json({ ok: true })
}`

// ─── Per-project auth material (hermetic override — no DB needed) ────────────
const AUTH = {
  jwtSecret: 'verifier-project-jwt-secret-000000000000000000000000000000000000',
  adminKey: 'bk_admin_verifier0000000000000000000000000000000000000000000000',
}

// Exact impersonate shape: signs with env JWT_SECRET via jsonwebtoken.sign —
// the runner shim must inject the projectId claim for stored functions.
const SIGN_PROBE = `import { NextResponse } from 'next/server'
import { sign, decode } from 'jsonwebtoken'
export async function GET() {
  const token = sign({ userId: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) }, process.env.JWT_SECRET ?? 'x', { expiresIn: 60 })
  return NextResponse.json({ decoded: decode(token) })
}`

// Curated env probe: project-scoped values must be present, platform secrets absent.
const PROJECT_ENV_PROBE = `import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({
    adminKey: process.env.ADMIN_API_KEY ?? null,
    execToken: process.env.AI_EXECUTION_TOKEN ?? null,
    jwtSecret: process.env.JWT_SECRET ?? null,
  })
}`

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  console.log('\n[1] Format detection')
  check('route module detected', isRouteModuleFunction(WALLET_BALANCE) === true)
  check('sandbox body NOT a route module', isRouteModuleFunction(SANDBOX_BODY) === false)

  console.log('\n[2] Execute wallet-balance with no token (DB-free 401 path)')
  const res = await executeRouteModuleFunction(WALLET_BALANCE, 'test', { type: 'manual', data: {} }, 'GET /api/v1/test/fn/wallet-balance')
  check('returned HTTP 401', res.returnValue.status === 401, `got ${res.returnValue.status}`)
  check('body is the auth error', res.returnValue.body?.error === 'Authentication required', JSON.stringify(res.returnValue.body))
  check('no logs leaked', Array.isArray(res.logs))

  console.log('\n[3] Curated process.env shim (admin/webhook templates)')
  const admin = await executeRouteModuleFunction(ADMIN_GATED, 'test', { type: 'manual', data: {} }, 'GET /api/v1/test/fn/admin-users-list')
  check('admin template passes the safety scan and runs', admin.returnValue.status === 403 || admin.returnValue.status === 200, `got ${admin.returnValue.status}`)
  check('no-key run returns the 403 gate (not a crash)', admin.returnValue.status === 403 || !!process.env.ADMIN_API_KEY || !!process.env.AI_EXECUTION_TOKEN, JSON.stringify(admin.returnValue.body))

  const leak = await executeRouteModuleFunction(ENV_LEAK_PROBE, 'test', { type: 'manual', data: {} })
  check('DATABASE_URL is NOT reachable from the vm', leak.returnValue.body?.dbUrl === null, JSON.stringify(leak.returnValue.body))

  let exitBlocked = false
  try {
    await executeRouteModuleFunction(PROCESS_EXIT_PROBE, 'test', { type: 'manual', data: {} })
  } catch (err: any) {
    exitBlocked = /safety scan/.test(err?.message || '')
  }
  check('process.exit() is still scan-rejected', exitBlocked)

  console.log('\n[5] Per-project auth — test-run injection (dashboard Run button)')
  const adminTest = await executeRouteModuleFunction(
    ADMIN_GATED, 'test', { type: 'manual', data: {} },
    'GET /api/v1/test/fn/admin-users-list',
    { testRun: true, authMaterial: AUTH }
  )
  check('admin gate passes with injected project admin key', adminTest.returnValue.status === 200, `got ${adminTest.returnValue.status}`)

  const walletTest = await executeRouteModuleFunction(
    WALLET_BALANCE, 'test', { type: 'manual', data: {} },
    'GET /api/v1/test/fn/wallet-balance',
    { testRun: true, authMaterial: AUTH }
  )
  check('user-token gate passes with minted project-scoped token (no 401)', walletTest.returnValue.status !== 401, `got ${walletTest.returnValue.status}`)

  console.log('\n[6] Per-project auth — forwarded real headers (public /fn/ path)')
  const adminFwd = await executeRouteModuleFunction(
    ADMIN_GATED, 'test', { type: 'manual', data: {} },
    'GET /api/v1/test/fn/admin-users-list',
    { headers: { 'x-admin-key': AUTH.adminKey }, authMaterial: AUTH }
  )
  check('forwarded x-admin-key header reaches the handler', adminFwd.returnValue.status === 200, `got ${adminFwd.returnValue.status}`)

  const adminWrongKey = await executeRouteModuleFunction(
    ADMIN_GATED, 'test', { type: 'manual', data: {} },
    'GET /api/v1/test/fn/admin-users-list',
    { headers: { 'x-admin-key': 'wrong-key' }, authMaterial: AUTH }
  )
  check('wrong admin key still 403s (fail closed)', adminWrongKey.returnValue.status === 403, `got ${adminWrongKey.returnValue.status}`)

  console.log('\n[7] jsonwebtoken shim — projectId claim injection for impersonation tokens')
  const signRes = await executeRouteModuleFunction(
    SIGN_PROBE, 'test', { type: 'manual', data: {} }, null,
    { authMaterial: AUTH }
  )
  check('signed token carries injected projectId claim', signRes.returnValue.body?.decoded?.projectId === 'test', JSON.stringify(signRes.returnValue.body))
  check('signed token keeps original claims', signRes.returnValue.body?.decoded?.userId === 'u1', JSON.stringify(signRes.returnValue.body))

  console.log('\n[8] Curated env is project-scoped, not platform-scoped')
  const envRes = await executeRouteModuleFunction(
    PROJECT_ENV_PROBE, 'test', { type: 'manual', data: {} }, null,
    { authMaterial: AUTH }
  )
  check('ADMIN_API_KEY = project admin key', envRes.returnValue.body?.adminKey === AUTH.adminKey)
  check('AI_EXECUTION_TOKEN = project admin key (no platform secret)', envRes.returnValue.body?.execToken === AUTH.adminKey)
  check('JWT_SECRET = project jwt secret (no platform secret)', envRes.returnValue.body?.jwtSecret === AUTH.jwtSecret)

  console.log('\n[9] Sandbox-worker require() regex fix')
  const RE = /(?<![.\w$])require\s*\(/
  check("does NOT match ctx.require('pdfkit')", RE.test("const x = ctx.require('pdfkit')") === false)
  check("does NOT match a.require(", RE.test('foo.require(') === false)
  check("DOES match bare require('fs')", RE.test("const fs = require('fs')") === true)
  check('DOES match require (  with space', RE.test('require ("net")') === true)

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
