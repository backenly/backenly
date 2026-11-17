/**
 * Function code imports Backenly's helpers from one module, @backenly/functions,
 * and answers with the Web Response (production QA re-test 2026-11-16, #44).
 *
 * An http function had to import next/server, @/lib/db, @/lib/auth/jwt and
 * @/lib/auth/session: paths inside Backenly's own source tree, so code an agent
 * wrote was tied to Backenly's file layout. Now:
 *
 *   import { db, asService, verifyToken, isAdminRequest, createSession } from '@backenly/functions'
 *   export async function POST(request: Request) { … return Response.json(body, { status }) }
 *
 * The old paths still load, so every deployed function runs unchanged, but
 * nothing Backenly writes or says names them any more: not the generator's
 * contract, not the templates, not deploy_code's refusals and advice, not the
 * tool text.
 *
 * Each module here runs in a real runner process (no database: the runner's
 * database is asked for on the first query, and these never make one).
 */

import fs from 'fs'
import path from 'path'
import ts from 'typescript'

import { executeRouteModuleFunction, validateRouteModule, WITHHELD_READ_REFUSED } from '@/lib/services/ai-functions/route-module-runner'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { __ROUTE_MODULE_CONTRACT } from '@/lib/ai/function-generator'
import { generateDomainEndpoints } from '@/lib/ai/build-runtime/domain-business-logic'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { mcpTools } from '@/lib/mcp/protocol/remote-server'

const ROOT = path.join(__dirname, '..', '..')
const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const ADMIN = `bk_admin_${'b'.repeat(64)}`
const AUTH = { jwtSecret: 'functions-module-test-secret-not-a-real-one', adminKey: ADMIN }

/** The four paths inside Backenly's source tree functions imported before @backenly/functions. */
const SOURCE_PATHS = ['next/server', '@/lib/db', '@/lib/auth/jwt', '@/lib/auth/session']
const NAMES_A_SOURCE_PATH = /['"`](?:next\/server|@\/lib\/(?:db|auth\/jwt|auth\/session))['"`]/
const HELPERS = ['db', 'asService', 'verifyToken', 'isAdminRequest', 'createSession']

function run(code: string, headers: Record<string, string> = {}, data: Record<string, unknown> = {}) {
  return executeRouteModuleFunction(code, PROJECT_ID, { type: 'manual', data }, 'POST /fn/t', { authMaterial: AUTH, headers })
}

/** The modules a function's code imports, in order. */
const importsOf = (code: string) => [...code.matchAll(/^\s*import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('a function written with @backenly/functions and the Web Response', () => {
  it('answers with the status, body and headers its Response.json carries', async () => {
    const { returnValue, headers } = await run(`
      import { verifyToken, isAdminRequest } from '@backenly/functions'
      export async function POST(request: Request) {
        const { name } = await request.json()
        return Response.json(
          { hello: name, admin: isAdminRequest(request), signedIn: verifyToken('not-a-token') !== null },
          { status: 201, headers: { 'cache-control': 'no-store' } },
        )
      }
    `, { 'x-admin-key': ADMIN }, { name: 'Ada' })
    expect(returnValue).toEqual({ status: 201, body: { hello: 'Ada', admin: true, signedIn: false } })
    expect(headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store' })
  })

  it('validates at deploy time, where on main the module is refused', async () => {
    const check = await validateRouteModule(`
      import { db, asService, verifyToken, isAdminRequest, createSession } from '@backenly/functions'
      export async function GET(request: Request) {
        return Response.json({ helpers: [typeof db.$queryRawUnsafe, typeof asService, typeof verifyToken, typeof isAdminRequest, typeof createSession] })
      }
    `)
    expect(check).toEqual({ valid: true, methods: ['GET'] })
  })

  it('gets every helper the module exports', async () => {
    const { returnValue } = await run(`
      import * as functions from '@backenly/functions'
      export async function GET() {
        return Response.json({ exports: Object.keys(functions).filter((k) => k !== 'default').sort(), db: Object.keys(functions.db).sort() })
      }
    `)
    expect(returnValue.body).toEqual({
      exports: ['Headers', 'Request', 'Response', 'asService', 'createSession', 'db', 'isAdminRequest', 'verifyToken'],
      db: ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$transaction'],
    })
  })

  it.each([
    ['no body', 'new Response(null, { status: 204 })', { status: 204, body: null }, undefined],
    ['JSON it wrote itself', "new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })", { status: 200, body: { ok: true } }, undefined],
    ['text', "new Response('pong', { status: 202 })", { status: 202, body: 'pong' }, true],
    ['text that only claims to be JSON', "new Response('not json', { headers: { 'content-type': 'application/json' } })", { status: 200, body: 'not json' }, true],
  ])('reads a Response with %s', async (_what, answer, expected, text) => {
    const result = await run(`export async function POST() { return ${answer} }`)
    expect(result.returnValue).toEqual(expected)
    expect(result.text).toBe(text)
    if (text) expect(result.headers['content-type']).toMatch(/^(text\/plain|application\/json)/)
  })

  it('reads the request as a Web Request is read, and has Web Crypto without an import', async () => {
    const { returnValue } = await run(`
      export async function POST(request: Request) {
        const url = new URL(request.url)
        return Response.json({
          q: url.searchParams.get('q'),
          headers: Object.fromEntries(request.headers),
          id: crypto.randomUUID(),
        })
      }
    `, { 'x-admin-key': ADMIN }, { q: 'mugs' })
    expect(returnValue.body.q).toBe('mugs')
    expect(returnValue.body.headers).toMatchObject({ 'x-admin-key': ADMIN, 'content-type': 'application/json' })
    expect(returnValue.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('a function written with the paths it imported before', () => {
  it('still runs, with NextResponse.json as it always answered', async () => {
    const { returnValue, headers } = await run(`
      import { NextRequest, NextResponse } from 'next/server'
      import { prisma, asService } from '@/lib/db'
      import { verifyToken, isAdminRequest } from '@/lib/auth/jwt'
      import { createSession } from '@/lib/auth/session'
      export async function POST(req: NextRequest) {
        return NextResponse.json(
          { admin: isAdminRequest(req), helpers: [typeof prisma.$queryRawUnsafe, typeof asService, typeof verifyToken, typeof createSession] },
          { status: 202 },
        )
      }
    `, { 'x-admin-key': ADMIN })
    expect(returnValue).toEqual({ status: 202, body: { admin: true, helpers: ['function', 'function', 'function', 'function'] } })
    expect(headers).toEqual({ 'content-type': 'application/json' })
  })
})

describe('what Backenly writes for a function', () => {
  it('the generator’s contract has the model import from @backenly/functions and answer with Response.json', () => {
    const contract = __ROUTE_MODULE_CONTRACT
    expect(contract).toContain("Imports allowed ONLY from: '@backenly/functions' (db, asService, verifyToken, isAdminRequest, createSession)")
    expect(contract).toContain('Response.json(body, { status })')
    expect(contract).toContain('(request: Request,')
    for (const p of SOURCE_PATHS) expect(contract).not.toContain(p)
    expect(contract).not.toMatch(/NextResponse|NextRequest|\bprisma\b/)
  })

  const KINDS = ['users', 'jobs', 'credits', 'subscriptions', 'projects', 'payments', 'audit_logs', 'orders', 'sales', 'sellers', 'products', 'inventory', 'transactions']
  const endpoints = KINDS.flatMap((t) => generateDomainEndpoints(t, PROJECT_ID, KINDS, { includeSchemaEndpoint: true }))

  it('every endpoint the templates write imports only @backenly/functions and the three packages, and uses only what it imports', () => {
    expect(endpoints.length).toBeGreaterThan(20)
    for (const e of endpoints) {
      const imports = importsOf(e.code)
      expect({ name: e.name, imports: imports.filter((m) => !['@backenly/functions', 'crypto', 'bcryptjs', 'jsonwebtoken'].includes(m)) }).toEqual({ name: e.name, imports: [] })
      expect({ name: e.name, old: e.code.match(/NextResponse|NextRequest|\bprisma\b/g) }).toEqual({ name: e.name, old: null })
      const line = e.code.match(/^import \{ ([^}]*) \} from '@backenly\/functions'$/m)
      const imported = line ? line[1].split(',').map((n) => n.trim()) : []
      const body = e.code.replace(/^import .*$/gm, '')
      const used = HELPERS.filter((h) => new RegExp(String.raw`(?<![\w$.])${h}\b`).test(body))
      expect({ name: e.name, imported: [...imported].sort() }).toEqual({ name: e.name, imported: [...used].sort() })
    }
  })

  it('every endpoint the templates write passes deploy-time validation', async () => {
    // <table>-full does not compile on main either (a const declaration inside
    // an array literal), which is its own fix; its imports are checked above.
    for (const e of endpoints.filter((x) => !x.name.endsWith('-full'))) {
      expect({ name: e.name, check: await validateRouteModule(e.code, e.method) }).toMatchObject({ name: e.name, check: { valid: true } })
    }
  }, 120_000)

  it('no text in lib/ names a path inside Backenly’s source tree for function code to import', () => {
    // Every string and template literal in lib/, so the model's prompts, the
    // templates (also the ones minimal-executor keeps), refusals, hints and tool
    // text. The runner itself (.cjs) still serves the old paths, and the
    // migration that rewrites old template code in place matches their text.
    const skip = new Set(['lib/services/ai-functions/withheld-env-migration.ts'])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !skip.has(rel)) scan(rel)
      }
    }
    const scan = (rel: string) => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      if (!/next\/server|@\/lib\/(?:db|auth)/.test(text)) return
      const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const visit = (node: ts.Node) => {
        let literal: string | null = null
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text
        else if (ts.isTemplateExpression(node)) literal = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('${}')
        if (literal !== null && NAMES_A_SOURCE_PATH.test(literal)) {
          found.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    walk('lib')
    expect(found).toEqual([])
  })
})

describe('deploy_code says @backenly/functions', () => {
  const actor = { userId: 'u1', projectId: PROJECT_ID }
  const deploy = (code: string) => deployFunctionCode(actor, { name: 'x', code, trigger: 'http' })

  it('when a module imports what the runner does not have, naming exactly what it may import', async () => {
    const r = await deploy(`
      import { prisma } from '@/lib/db/prisma'
      export async function GET() { return Response.json({ n: await prisma.user.count() }) }
    `)
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toContain('Module "@/lib/db/prisma" is not available to route functions.')
    const allowed = r.summary.slice(r.summary.indexOf('Allowed: '))
    expect(allowed).toBe('Allowed: @backenly/functions (db, asService, verifyToken, isAdminRequest, createSession), crypto, bcryptjs, jsonwebtoken.')
  })

  it('when the code for an http function is not a route module', async () => {
    const r = await deploy('const rows = await ctx.db.query("orders")\nreturn rows')
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toContain("from '@backenly/functions'")
    expect(r.summary).toContain('Response.json(body)')
    for (const p of SOURCE_PATHS) expect(r.summary).not.toContain(p)
  })

  it('when the code reads a variable functions no longer get', async () => {
    const r = await deploy(`
      import { verifyToken } from '@backenly/functions'
      export async function GET() { return Response.json({ k: process.env.ADMIN_API_KEY }) }
    `)
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toContain(WITHHELD_READ_REFUSED)
    expect(WITHHELD_READ_REFUSED).toContain("Import the helpers from '@backenly/functions'")
    for (const p of SOURCE_PATHS) expect(WITHHELD_READ_REFUSED).not.toContain(p)
  })

  it('in the tool text an agent reads', () => {
    const deployTool = BRAIN_TOOLS.find((t) => t.function.name === 'deploy_function_code')!.function
    expect(deployTool.description).toContain("import { db, verifyToken } from '@backenly/functions'")
    expect(deployTool.description).toContain('Response.json(body)')
    for (const p of SOURCE_PATHS) expect(deployTool.description).not.toContain(p)

    const functions = (mcpTools(false) as unknown as Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }>)
      .find((t) => t.name === 'functions')!
    expect(functions.inputSchema.properties.code.description).toContain('@backenly/functions')
  })
})
