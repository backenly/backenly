/**
 * ROUTE-MODULE RUNNER — INVOCATION CONTRACT LOCK
 * ===============================================
 * Every handler shape the LLM generator legitimately emits MUST execute
 * without a contract crash. This suite exists because generated functions
 * once crashed in production with:
 *
 *   "Cannot destructure property 'params' of 'undefined'"
 *
 * — the runner called handler(req) with no second argument. The fix (and the
 * req.nextUrl / req.cookies / req.method shims) are locked here: if any of
 * these cases ever fails again, the generated-function surface is broken for
 * every agent-created HTTP endpoint. Do not delete or weaken these cases.
 *
 * No DB required: authMaterial is injected via the test hook.
 */

import {
  executeRouteModuleFunction,
  validateRouteModule,
  isRouteModuleFunction,
} from '@/lib/services/ai-functions/route-module-runner'

const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const AUTH = { jwtSecret: null, adminKey: null }

function run(code: string, data: Record<string, any> = {}, hint: string | null = 'GET /fn/test') {
  return executeRouteModuleFunction(code, PROJECT_ID, { type: 'manual', data }, hint, {
    authMaterial: AUTH,
  })
}

describe('route-module runner invocation contract', () => {
  test('handler destructuring { params } in the second arg receives it (the prod crash)', async () => {
    const code = `
      import { NextRequest, NextResponse } from 'next/server'
      export async function GET(request: NextRequest, { params }: { params: { projectId: string } }) {
        return NextResponse.json({ projectId: params.projectId })
      }
    `
    const { returnValue } = await run(code)
    expect(returnValue.status).toBe(200)
    expect(returnValue.body.projectId).toBe(PROJECT_ID)
  })

  test('query params reach the handler via params AND request.nextUrl.searchParams', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function GET(request: any, { params }: any) {
        const viaParams = params.name
        const viaNextUrl = request.nextUrl.searchParams.get('name')
        return NextResponse.json({ viaParams, viaNextUrl })
      }
    `
    const { returnValue } = await run(code, { name: 'world' })
    expect(returnValue.status).toBe(200)
    expect(returnValue.body.viaParams).toBe('world')
    expect(returnValue.body.viaNextUrl).toBe('world')
  })

  test('new URL(request.url) keeps working alongside nextUrl', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function GET(request: any) {
        const url = new URL(request.url)
        return NextResponse.json({ name: url.searchParams.get('name') })
      }
    `
    const { returnValue } = await run(code, { name: 'via-url' })
    expect(returnValue.body.name).toBe('via-url')
  })

  test('Next 15 style `await params` resolves (plain object is await-safe)', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function GET(request: any, ctx: any) {
        const { projectId } = await ctx.params
        return NextResponse.json({ projectId })
      }
    `
    const { returnValue } = await run(code)
    expect(returnValue.body.projectId).toBe(PROJECT_ID)
  })

  test('request.method and request.cookies.get(...) are available', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function POST(request: any) {
        const session = request.cookies.get('session')
        return NextResponse.json({ method: request.method, session: session ? session.value : null })
      }
    `
    const result = await executeRouteModuleFunction(
      code, PROJECT_ID, { type: 'manual', data: {} }, 'POST /fn/test',
      { authMaterial: AUTH, headers: { cookie: 'session=abc123; theme=dark' } as any }
    )
    expect(result.returnValue.body.method).toBe('POST')
    expect(result.returnValue.body.session).toBe('abc123')
  })

  test('await request.json() returns the event data for POST bodies', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function POST(request: any) {
        const body = await request.json()
        return NextResponse.json({ got: body.title })
      }
    `
    const { returnValue } = await run(code, { title: 'hello' }, 'POST /fn/test')
    expect(returnValue.body.got).toBe('hello')
  })
})

describe('validateRouteModule creation gate', () => {
  test('accepts a well-formed module and reports its methods', () => {
    const check = validateRouteModule(`
      import { NextResponse } from 'next/server'
      export async function GET() { return NextResponse.json({ ok: true }) }
    `, 'GET')
    expect(check.valid).toBe(true)
    expect(check.methods).toEqual(['GET'])
  })

  test('rejects a module with a syntax error', () => {
    const check = validateRouteModule(`export async function GET( { return }`)
    expect(check.valid).toBe(false)
    expect(check.error).toMatch(/Compile error/i)
  })

  test('rejects a module that exports no HTTP handler', () => {
    const check = validateRouteModule(`export const helper = () => 42`)
    expect(check.valid).toBe(false)
    expect(check.error).toMatch(/exports no/i)
  })

  test('rejects a module whose export does not match the declared method', () => {
    const check = validateRouteModule(`
      import { NextResponse } from 'next/server'
      export async function POST() { return NextResponse.json({}) }
    `, 'GET')
    expect(check.valid).toBe(false)
    expect(check.error).toMatch(/declared as GET/i)
  })

  test('rejects forbidden patterns (defence in depth)', () => {
    const check = validateRouteModule(`
      import { exec } from 'child_process'
      export async function GET() { return null }
    `)
    expect(check.valid).toBe(false)
    expect(check.error).toMatch(/child_process/i)
  })

  test('rejects disallowed imports at evaluation time', () => {
    // The import must be USED — esbuild's TS loader elides unused imports,
    // which is correct (the runner elides them identically at execution).
    const check = validateRouteModule(`
      import axios from 'axios'
      import { NextResponse } from 'next/server'
      export async function GET() {
        const r = await axios.get('https://example.com')
        return NextResponse.json(r.data)
      }
    `)
    expect(check.valid).toBe(false)
    expect(check.error).toMatch(/not available/i)
  })

  test('unused disallowed imports are elided by the compiler and validate clean', () => {
    const check = validateRouteModule(`
      import axios from 'axios'
      import { NextResponse } from 'next/server'
      export async function GET() { return NextResponse.json({ ok: true }) }
    `)
    expect(check.valid).toBe(true)
  })
})

describe('format detection', () => {
  test('route modules are detected; sandbox bodies are not', () => {
    expect(isRouteModuleFunction(`export async function GET(req) {}`)).toBe(true)
    expect(isRouteModuleFunction(`import { NextResponse } from 'next/server'`)).toBe(true)
    expect(isRouteModuleFunction(`const rows = await ctx.db.query('posts'); ctx.log(rows.length)`)).toBe(false)
  })
})
