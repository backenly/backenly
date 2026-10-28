/**
 * SELF-HEAL REWRITES ONLY THE CODE BACKENLY WROTE, AND NEVER SILENTLY
 * ===================================================================
 * `functions { action: "deploy_code" }` promises the module "is stored exactly
 * as written, with no model reading or rewriting it". The runtime self-healer
 * broke that promise after the fact: any thrown run on the public endpoint, a
 * trigger or cron fired a model rewrite that stored new code as
 * `status:'active', lastError:null` — with NO audit row. The agent's next read
 * returned code it never wrote, and its deploy receipt's sha matched nothing.
 *
 * The row now records who wrote the code (`codeOrigin`): 'agent' rows are
 * never model-rewritten (the error stays for the agent to read), 'generated'
 * rows still heal — and every rewrite leaves an AI_FUNCTION_SELF_HEALED audit
 * row carrying the before/after code hashes.
 *
 * The LLM is the only mock (delegating, canned fix). deployFunctionCode, the
 * executor, the fixers, the vm runner and the database are real.
 */

import { createHash, randomUUID } from 'crypto'

jest.mock('@/lib/ai/llm/chat', () => {
  const actual = jest.requireActual('@/lib/ai/llm/chat')
  return {
    ...actual,
    chat: jest.fn(async () => ({ text: (global as any).__FIX_CODE__ ?? '', result: {} })),
  }
})

import { prisma } from '@/lib/db/prisma'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { executeAiFunction, autoFixRouteModuleFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// Passes the deploy validation gate (compiles, evaluates, exports POST), then
// throws on every invocation — the "deployed, then first failure" shape.
const BROKEN = `import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  throw new Error('relation "orders" does not exist')
}`

const GOOD = `import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  return NextResponse.json({ ok: true })
}`

let ownerId = ''
let projectId = ''

async function pollCode(id: string, until: (code: string) => boolean, ms = 4000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const row = await prisma.aiFunction.findUnique({ where: { id }, select: { generatedCode: true } })
    if (row && until(row.generatedCode)) return row.generatedCode
    if (Date.now() - start > ms) return row?.generatedCode ?? ''
    await new Promise((r) => setTimeout(r, 150))
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ;(global as any).__FIX_CODE__ = GOOD
  ownerId = (
    await prisma.user.create({
      data: { email: `fn-heal-${randomUUID()}@test.invalid`, name: 'Heal Consent Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `fn-heal-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('who wrote the code is recorded', () => {
  it('deploy_code marks the row agent-owned', async () => {
    const res = await deployFunctionCode(
      { userId: ownerId, projectId },
      { name: 'agent-owned', code: BROKEN, trigger: 'http', method: 'POST' },
    )
    expect(res.ok).toBe(true)
    const row = await prisma.aiFunction.findFirst({ where: { projectId, name: 'agent-owned' } })
    expect(row?.codeOrigin).toBe('agent')
  }, 60_000)

  it("a row created without an origin reads 'generated' — Backenly's own code heals as before", async () => {
    const row = await prisma.aiFunction.create({
      data: {
        projectId,
        name: 'backenly-generated',
        description: 'generated probe',
        generatedCode: BROKEN,
        triggerType: 'http',
        triggerTable: 'POST /fn/backenly-generated',
        status: 'active',
      },
    })
    expect(row.codeOrigin).toBe('generated')
  })
})

describe('the fixer refuses agent code and documents generated rewrites', () => {
  it('an agent-owned module is never model-rewritten, even when asked directly', async () => {
    const row = await prisma.aiFunction.findFirstOrThrow({ where: { projectId, name: 'agent-owned' } })
    const ok = await autoFixRouteModuleFunction(row.id, projectId, 'thrown at runtime', row.generatedCode, row.description, row.triggerTable)
    expect(ok).toBe(false)
    const after = await prisma.aiFunction.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.generatedCode).toBe(BROKEN) // exactly as written
    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'AI_FUNCTION_SELF_HEALED', details: { contains: row.id } },
    })
    expect(audit).toBeNull()
  }, 60_000)

  it('a generated module heals, and the rewrite leaves an audit row with both hashes', async () => {
    const row = await prisma.aiFunction.findFirstOrThrow({ where: { projectId, name: 'backenly-generated' } })
    const ok = await autoFixRouteModuleFunction(row.id, projectId, 'thrown at runtime', row.generatedCode, row.description, row.triggerTable)
    expect(ok).toBe(true)
    const after = await prisma.aiFunction.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.generatedCode).toBe(GOOD)
    expect(after.status).toBe('active')

    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'AI_FUNCTION_SELF_HEALED', details: { contains: row.id } },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details ?? '{}')
    expect(details.previousCodeSha256).toBe(sha(BROKEN))
    expect(details.newCodeSha256).toBe(sha(GOOD))
  }, 60_000)
})

describe('the runtime failure path honours the same consent', () => {
  it('a thrown run on agent code records the error and leaves the bytes alone', async () => {
    const row = await prisma.aiFunction.findFirstOrThrow({ where: { projectId, name: 'agent-owned' } })
    // Default caller — the public /fn/, trigger and cron paths pass no selfHeal
    // flag, which is exactly the surface that used to rewrite.
    const result = await executeAiFunction(row.id, projectId, { type: 'manual', data: {} })
    expect(result.success).toBe(false)
    // The fire-and-forget heal (if any) gets ample time, then must have done nothing.
    await new Promise((r) => setTimeout(r, 1500))
    const after = await prisma.aiFunction.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.generatedCode).toBe(BROKEN)
    expect(after.status).toBe('error')
    expect(after.lastError).toContain('does not exist')
  }, 60_000)

  it('a thrown run on generated code still heals it — the doctrine is kept, with a trace', async () => {
    const fn = await prisma.aiFunction.create({
      data: {
        projectId,
        name: 'generated-heals',
        description: 'generated heal probe',
        generatedCode: BROKEN,
        triggerType: 'http',
        triggerTable: 'POST /fn/generated-heals',
        status: 'active',
      },
    })
    const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} })
    expect(result.success).toBe(false)
    const healed = await pollCode(fn.id, (c) => c === GOOD)
    expect(healed).toBe(GOOD)
    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'AI_FUNCTION_SELF_HEALED', details: { contains: fn.id } },
    })
    expect(audit).not.toBeNull()
  }, 60_000)
})
