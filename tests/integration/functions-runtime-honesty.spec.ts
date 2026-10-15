/**
 * Function runs are honest about what they do (medium findings FN-11, FN-14).
 *
 * FN-11: the creation check called a generated HTTP handler for real, as the
 * project's admin, outside the run log and run count. A "GET /send-digest
 * that emails every subscriber" emailed every subscriber at creation, and no
 * run appeared anywhere; a POST that needs no input did the same. The check
 * now asks every handler for its contract (`?describe=1`, which the generation
 * contract requires on every method), and every check is recorded in the
 * function's run log.
 *
 * FN-14: ctx.db.query capped every read at 100 rows, silently, so a job that
 * meant to visit every row saw an arbitrary 100. It now takes an explicit
 * { limit, offset, orderBy } (default 100, at most 1000), and the cap, the
 * order and the equality-only filter are documented where agents and the
 * generator read.
 *
 * Real function, log and workspace rows. Only the model call that writes the
 * handler is stubbed (CI has no model provider), as function-create-truthful
 * does.
 */
jest.mock('@/lib/ai/llm/chat', () => {
  const actual = jest.requireActual('@/lib/ai/llm/chat')
  return {
    ...actual,
    chat: jest.fn(async () => {
      const next = (global as any).__CANNED_CODE__?.shift()
      if (typeof next !== 'string') throw new Error('test: no canned code queued for chat()')
      return { text: next, result: {} }
    }),
  }
})

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const ROOT = process.cwd()

let ownerId: string
let projectId: string

// Answers its contract when asked; otherwise does "the work", which here is a
// throw that a real-work creation check would report as a failure.
const DESCRIBES_ITSELF = `
import { NextResponse } from 'next/server'
export async function GET(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.get('describe') === '1') {
    return NextResponse.json({ method: 'GET', returns: { sent: 'number of digests sent' } })
  }
  throw new Error('the work ran: every subscriber was emailed')
}
`

// A POST that needs no input: an empty body has nothing to reject, so only the
// contract call keeps the check from doing its work.
const POST_DESCRIBES_ITSELF = `
import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  if (new URL(req.url).searchParams.get('describe') === '1') {
    return NextResponse.json({ method: 'POST', returns: { recalculated: 'number of stats' } })
  }
  throw new Error('the work ran: every stat was recalculated')
}
`

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `fn-runtime-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Functions Runtime Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (await prisma.project.create({ data: { name: 'fn-runtime', userId: ownerId }, select: { id: true } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "workspace_${projectId}"."items" (id serial PRIMARY KEY, label text)`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "workspace_${projectId}"."items" (label) SELECT 'item-' || g FROM generate_series(1, 250) g`,
  )
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('FN-11: the creation check asks, and is recorded', () => {
  it('a GET handler is asked for its contract, not run, and the check is in its run log', async () => {
    ;(global as any).__CANNED_CODE__ = [DESCRIBES_ITSELF, DESCRIBES_ITSELF]
    const res = await executeGenerateFunction({ name: 'send-digest', description: 'email every subscriber the digest', method: 'GET' }, projectId)
    expect(res.success).toBe(true)
    expect(res.message).not.toContain('FAILED')

    const fn = await prisma.aiFunction.findFirst({ where: { projectId, name: 'send-digest' }, select: { id: true, status: true } })
    expect(fn?.status).toBe('active')
    const logs = await prisma.aiFunctionLog.findMany({ where: { functionId: fn!.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ triggerType: 'creation_check', success: true })
    expect(logs[0].logs.join('\n')).toContain('GET ?describe=1')
    expect(logs[0].logs.join('\n')).toContain('HTTP 200')
  }, 120_000)

  it('a POST that needs no input is asked for its contract too, not run', async () => {
    ;(global as any).__CANNED_CODE__ = [POST_DESCRIBES_ITSELF, POST_DESCRIBES_ITSELF]
    const res = await executeGenerateFunction({ name: 'recalculate-stats', description: 'recalculate every stat', method: 'POST' }, projectId)
    expect(res.success).toBe(true)

    const fn = await prisma.aiFunction.findFirst({ where: { projectId, name: 'recalculate-stats' }, select: { id: true, status: true } })
    expect(fn?.status).toBe('active')
    const logs = await prisma.aiFunctionLog.findMany({ where: { functionId: fn!.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ triggerType: 'creation_check', success: true })
    expect(logs[0].logs.join('\n')).toContain('POST ?describe=1')
  }, 120_000)

  it('the generation contract asks every method to answer describe without doing the work', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'function-generator.ts'), 'utf8')
    expect(source).toContain('Answer ?describe=1 with the contract instead of doing the work, on every method you export')
    expect(source).toContain('so it must never do the work')
  })
})

describe('FN-14: ctx.db.query pages explicitly', () => {
  async function run(name: string, lines: string[]) {
    const fn = await prisma.aiFunction.create({
      data: { projectId, name, description: name, triggerType: 'manual', status: 'active', generatedCode: lines.join('\n') },
      select: { id: true },
    })
    return executeAiFunction(fn.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
  }

  it('limit and offset reach every row; the default page is still 100', async () => {
    const out = await run('count-items', [
      "const first = await ctx.db.query('items', undefined, { limit: 150 })",
      "const tail = await ctx.db.query('items', undefined, { limit: 1000, offset: 200 })",
      "const capped = await ctx.db.query('items', undefined, { limit: 5000 })",
      "const dflt = await ctx.db.query('items')",
      'return { first: first.length, tail: tail.length, capped: capped.length, dflt: dflt.length }',
    ])
    expect(out.success).toBe(true)
    expect(out.returnValue).toEqual({ first: 150, tail: 50, capped: 250, dflt: 100 })
  }, 120_000)

  it('pages under one orderBy visit every row exactly once, in order', async () => {
    // The walk the docs teach: offset pages under one fixed orderBy, ids first.
    const out = await run('walk-items', [
      'const ids = []',
      'for (let offset = 0; offset <= 1000; offset += 100) {',
      "  const page = await ctx.db.query('items', undefined, { limit: 100, offset, orderBy: { id: 'asc' } })",
      '  for (const row of page) ids.push(row.id)',
      '  if (page.length < 100) break',
      '}',
      "const newest = await ctx.db.query('items', undefined, { limit: 1, orderBy: { id: 'DESC' } })",
      'return {',
      '  seen: ids.length,',
      '  distinct: ids.filter((id, i) => ids.indexOf(id) === i).length,',
      '  ascending: ids.every((id, i) => i === 0 || id > ids[i - 1]),',
      '  newest: newest[0].id,',
      '}',
    ])
    expect(out.success).toBe(true)
    expect(out.returnValue).toEqual({ seen: 250, distinct: 250, ascending: true, newest: 250 })
  }, 120_000)

  it('an orderBy that is not a column name or a direction is refused, not dropped', async () => {
    const badColumn = await run('bad-order-column', [
      "return await ctx.db.query('items', undefined, { orderBy: { 'id; DROP TABLE items': 'asc' } })",
    ])
    expect(badColumn.success).toBe(false)
    expect(badColumn.error).toContain('is not a column name')

    const badDirection = await run('bad-order-direction', [
      "return await ctx.db.query('items', undefined, { orderBy: { id: 'sideways' } })",
    ])
    expect(badDirection.success).toBe(false)
    expect(badDirection.error).toContain("must be 'asc' or 'desc'")

    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "workspace_${projectId}"."items"`,
    )
    expect(n).toBe(250)
  }, 120_000)

  it('the cap, the order and the equality-only filter are documented where agents and the generator read', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'functions.md'), 'utf8')
    expect(docs).toContain('`ctx.db.query(table, where?, { limit, offset, orderBy }?)`')
    expect(docs).toContain('default 100, at most 1000')
    expect(docs).toContain('`where` matches by equality')
    expect(docs).toContain('page with `offset` under one fixed `orderBy`')
    const prompt = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'ai-functions', 'generator.ts'), 'utf8')
    expect(prompt).toContain('Returns at most opts.limit rows (default 100, max 1000)')
    expect(prompt).toContain('page with opts.offset under one fixed opts.orderBy')
  })
})
