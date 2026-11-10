/**
 * THE RELEASE STEP FOR STORED FUNCTIONS THAT READ THE WITHHELD VARIABLES
 * =====================================================================
 *
 * Route functions no longer receive the project's signing secret or admin key
 * (route-module-runner.ts). Projects store copies of Backenly's templates that
 * read them: an admin gate, which would now answer 403 to everyone, and an
 * impersonation endpoint, which signed sessions with the secret.
 * scripts/stop-functions-reading-withheld-env.ts reports every stored function
 * that reads one of them and rewrites only the exact template code, each as a
 * governed change. Real ledger, real project.
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution } from '@/lib/changes/ledger'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { executeRouteModuleFunction, validateRouteModule } from '@/lib/services/ai-functions/route-module-runner'
import {
  applyWithheldEnvRewrites,
  findFunctionsReadingWithheldEnv,
  IMPERSONATION_REFUSAL,
} from '@/lib/services/ai-functions/withheld-env-migration'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
const original = { edition: process.env.BACKENLY_EDITION, engine: process.env.ENGINE_MODE }

// Backenly's admin template as projects store it, before this release.
const ADMIN_TEMPLATE = `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? process.env.AI_EXECUTION_TOKEN ?? ''

export async function GET(req: NextRequest) {
  try {
    const key = req.headers.get('x-admin-key') ?? req.headers.get('authorization')?.replace('Bearer ', '')
    if (!key || key !== ADMIN_KEY) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`

// Backenly's impersonation template, shortened to what identifies it.
const IMPERSONATION_TEMPLATE = `import { NextRequest, NextResponse } from 'next/server'
import { sign } from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET ?? ''
const IMPERSONATION_DURATION = 3600

export async function POST(req: NextRequest) {
  const token = sign({ userId: 'x', impersonated: true }, JWT_SECRET, { expiresIn: IMPERSONATION_DURATION })
  return NextResponse.json({ token })
}`

const AGENT_CODE = `import { NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
export async function POST() {
  return NextResponse.json({ token: jwt.sign({ userId: 'x' }, process.env.JWT_SECRET) })
}`

const OTHER_GENERATED = `import { NextResponse } from 'next/server'
export async function GET(req) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_API_KEY) return NextResponse.json({}, { status: 403 })
  return NextResponse.json({ ok: true })
}`

const ids: Record<string, string> = {}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `withheld-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'function-withheld-env-migration', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  const make = async (name: string, generatedCode: string, codeOrigin: string, triggerType = 'manual') =>
    (ids[name] = (await prisma.aiFunction.create({
      // history: test fixture, the stored state the release step finds.
      data: { projectId, name, description: name, generatedCode, codeOrigin, triggerType },
    })).id)
  await make('admin-users-list', ADMIN_TEMPLATE, 'generated')
  await make('admin-impersonate', IMPERSONATION_TEMPLATE, 'generated')
  await make('agent-signer', AGENT_CODE, 'agent')
  await make('other-gate', OTHER_GENERATED, 'generated')
  await make('plain', `import { NextResponse } from 'next/server'\nexport async function GET() { return NextResponse.json({ plan: process.env.PLAN }) }`, 'generated')
}, 120_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<{ nspname: string }[]>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = original.edition
  process.env.ENGINE_MODE = original.engine
}, 120_000)

const codeOf = async (name: string) => (await prisma.aiFunction.findUniqueOrThrow({ where: { id: ids[name] } })).generatedCode

it('reports every stored function that reads one, and what the release step does with it', async () => {
  const found = await findFunctionsReadingWithheldEnv(projectId)
  expect(found.map((f) => [f.name, f.reads, f.action])).toEqual([
    ['admin-impersonate', 'JWT_SECRET', 'replace_impersonation'],
    ['admin-users-list', 'ADMIN_API_KEY', 'rewrite_admin_gate'],
    ['agent-signer', 'JWT_SECRET', 'owner_must_change'],
    ['other-gate', 'ADMIN_API_KEY', 'owner_must_change'],
  ])
  // Reporting changes nothing.
  expect(await codeOf('admin-users-list')).toBe(ADMIN_TEMPLATE)
}, 60_000)

it('rewrites only Backenly’s template code, each as a change History can restore', async () => {
  const results = await applyWithheldEnvRewrites(await findFunctionsReadingWithheldEnv(projectId))
  expect(results).toEqual([
    { functionId: ids['admin-impersonate'], changed: true, changeId: expect.any(String) },
    { functionId: ids['admin-users-list'], changed: true, changeId: expect.any(String) },
  ])

  const gate = await codeOf('admin-users-list')
  expect(gate).toContain("import { isAdminRequest } from '@/lib/auth/jwt'")
  expect(gate).toContain("if (!isAdminRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })")
  expect(gate).not.toMatch(/ADMIN_KEY|ADMIN_API_KEY|AI_EXECUTION_TOKEN/)
  expect(validateRouteModule(gate, 'GET')).toMatchObject({ valid: true })
  expect(await codeOf('admin-impersonate')).toBe(IMPERSONATION_REFUSAL)
  expect(await codeOf('agent-signer')).toBe(AGENT_CODE)
  expect(await codeOf('other-gate')).toBe(OTHER_GENERATED)
  expect(await findFunctionsReadingWithheldEnv(projectId)).toHaveLength(2)

  // The rewritten gate admits the project's admin key, and nobody else.
  const key = 'bk_admin_' + 'b'.repeat(64)
  const call = (headers: Record<string, string>) =>
    executeRouteModuleFunction(gate, projectId, { type: 'manual', data: {} }, 'GET /fn/admin-users-list', {
      authMaterial: { jwtSecret: 'x'.repeat(40), adminKey: key },
      headers,
    })
  expect((await call({})).returnValue.status).toBe(403)
  expect((await call({ 'x-admin-key': key })).returnValue).toEqual({ status: 200, body: { ok: true } })

  // History keeps the template's code: restoring the change brings it back.
  const change = results.find((r) => r.functionId === ids['admin-users-list'])!.changeId!
  expect(await recoverChange(projectId, change, { mode: 'manual', actorUserId: ownerId, acknowledged: null })).toMatchObject({ ok: true })
  expect(await codeOf('admin-users-list')).toBe(ADMIN_TEMPLATE)
}, 120_000)

it('says in the deploy answer when new code runs SQL as the service role', async () => {
  const deploy = (name: string, code: string) =>
    withChangeAttribution({ source: 'mcp' }, () => deployFunctionCode({ userId: ownerId, projectId }, { name, trigger: 'http', code }))
  const trusted = await deploy('checkout', `import { NextResponse } from 'next/server'
import { asService } from '@/lib/db'
export async function POST() {
  const rows = await asService((db) => db.$queryRawUnsafe('SELECT 1 AS one'))
  return NextResponse.json({ rows })
}`)
  expect(trusted).toMatchObject({ ok: true, data: { runsAsService: true } })
  expect(trusted.summary).toContain('Its asService blocks run as the service role, so row-level security does not apply to their SQL')

  const plain = await deploy('ping', `import { NextResponse } from 'next/server'
export async function POST() { return NextResponse.json({ ok: true }) }`)
  expect(plain).toMatchObject({ ok: true, data: { runsAsService: false } })
  expect(plain.summary).not.toContain('asService')
}, 120_000)
