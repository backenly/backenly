/**
 * functions { action: "deploy_code" }: what is refused before anything is
 * stored, and how the action is wired.
 *
 * Every refusal here happens before the database is read, so none needs one:
 * the checks run on the caller's own arguments first. The sandbox cases are
 * answered by the real sandbox worker, the file that will run the code, so a
 * body it accepts here is one it can run. What deploying, running and logging
 * do against a real database is in tests/integration/mcp-domain-operations.spec.ts.
 */

import { deployFunctionCode, MAX_FUNCTION_CODE_BYTES } from '@/lib/services/ai-functions/agent-actions'
import { validateSandboxFunction } from '@/lib/services/ai-functions/executor'
import { AGENT_ONLY_TOOLS, BRAIN_MODEL_TOOLS, BRAIN_TOOLS, READ_ONLY_TOOLS } from '@/lib/ai/brain/tools'
import { domainInputSchema, getDomainTool, needsApproval, readOnlyView } from '@/lib/mcp/domains'

// Not a real project: no case below gets as far as looking it up.
const actor = { userId: 'u1', projectId: '11111111-1111-4111-8111-111111111111' }

const routeModule = `
  import { NextResponse } from 'next/server'
  export async function POST(req: Request) {
    return NextResponse.json({ ok: true })
  }
`
const sandboxBody = `
  const rows = await ctx.db.query('orders')
  ctx.log('rows', rows.length)
  return { count: rows.length }
`

const deploy = (args: Record<string, unknown>) => deployFunctionCode(actor, args)

describe('refused before anything is stored', () => {
  it('needs a name, a known trigger and some code', async () => {
    expect(await deploy({ code: sandboxBody, trigger: 'manual' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await deploy({ name: 'x', code: sandboxBody, trigger: 'cron' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await deploy({ name: 'x', code: '   ', trigger: 'manual' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
  })

  it('refuses a project other than the one the key is bound to', async () => {
    const r = await deploy({ name: 'x', code: sandboxBody, trigger: 'manual', projectId: '22222222-2222-4222-8222-222222222222' })
    expect(r).toMatchObject({ ok: false, code: 'PROJECT_MISMATCH' })
  })

  it('refuses source over the size limit', async () => {
    const big = `return ${JSON.stringify('x'.repeat(MAX_FUNCTION_CODE_BYTES))}`
    const r = await deploy({ name: 'big', code: big, trigger: 'manual' })
    expect(r).toMatchObject({ ok: false, code: 'CODE_TOO_LARGE' })
  })

  it.each([
    ['a Stripe secret key', ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_')],
    ['a database URL with a password', ['postgres', '//app:', 'hunter2hunter2@db.internal/app'].join(':').replace('://app::', '://app:')],
    ['a private key', ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')],
  ])('refuses code with %s written into it', async (_what, secret) => {
    const r = await deploy({ name: 'leaky', code: `const key = '${secret}'\nreturn key.length`, trigger: 'manual' })
    expect(r).toMatchObject({ ok: false, code: 'SECRET_IN_CODE' })
    expect(r.summary).not.toContain(secret)
  })

  it('does not mistake an ordinary identifier for a key', async () => {
    // Refused later, for the database, not for a key: the credential check passed it.
    const r = await deploy({ name: 'plain', code: 'const re_render = 1\nreturn re_render', trigger: 'on_insert' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(r.summary).toMatch(/needs table/)
  })

  it('needs a table for a row trigger', async () => {
    const r = await deploy({ name: 'x', code: sandboxBody, trigger: 'on_update' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
  })

  it('takes a route module for http, and nothing else', async () => {
    const r = await deploy({ name: 'x', code: sandboxBody, trigger: 'http' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toMatch(/route module/)
  })

  it('takes a sandbox body for every other trigger, not a route module', async () => {
    const r = await deploy({ name: 'x', code: routeModule, trigger: 'manual' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toMatch(/sandbox body/)
  })

  it('refuses a route module that does not compile, or serves another method', async () => {
    const broken = await deploy({ name: 'x', code: `${routeModule}\nexport async function GET( {`, trigger: 'http' })
    expect(broken).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    const wrongMethod = await deploy({ name: 'x', code: routeModule, trigger: 'http', method: 'GET' })
    expect(wrongMethod).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(wrongMethod.summary).toMatch(/exports POST/)
  })

  it('refuses a route module that reaches for the platform process', async () => {
    const code = routeModule.replace('return NextResponse', 'process.exit(1)\n    return NextResponse')
    const r = await deploy({ name: 'x', code, trigger: 'http' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toMatch(/safety scan/)
  })
})

describe('what a route module can read from process.env', () => {
  // Code deployed with deploy_code is the agent's own, so whatever the runner
  // puts in the vm's process.env, a function can return. The platform's values
  // must not be in it: each is set here and none may come back.
  const PLATFORM = {
    STRIPE_WEBHOOK_SECRET: 'platform-stripe-webhook-secret',
    PAYMENT_WEBHOOK_SECRET: 'platform-payment-webhook-secret',
    // Assembled, so the credential scanner does not read a fixture as a leak.
    DATABASE_URL: ['postgresql:', '', 'platform:not-a-real-password@db.internal', 'backenly'].join('/'),
    ENV_VAR_ENCRYPTION_KEY: 'platform-encryption-key',
  }
  const saved: Record<string, string | undefined> = {}
  beforeAll(() => { for (const [k, v] of Object.entries(PLATFORM)) { saved[k] = process.env[k]; process.env[k] = v } })
  afterAll(() => { for (const k of Object.keys(PLATFORM)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('holds the project\'s own values and none of the platform\'s', async () => {
    const { executeRouteModuleFunction } = await import('@/lib/services/ai-functions/route-module-runner')
    const code = `
      import { NextResponse } from 'next/server'
      export async function GET() {
        return NextResponse.json({ env: { ...process.env } })
      }
    `
    const { returnValue } = await executeRouteModuleFunction(code, actor.projectId, { type: 'manual', data: {} }, 'GET /fn/env', {
      authMaterial: { jwtSecret: 'this-project-jwt-secret', adminKey: 'bk_admin_this_project' },
    })
    const env = returnValue.body.env
    expect(env.JWT_SECRET).toBe('this-project-jwt-secret')
    expect(env.ADMIN_API_KEY).toBe('bk_admin_this_project')
    const seen = JSON.stringify(returnValue.body)
    for (const value of Object.values(PLATFORM)) expect(seen).not.toContain(value)
    expect(Object.keys(env).sort()).toEqual(['ADMIN_API_KEY', 'AI_EXECUTION_TOKEN', 'JWT_SECRET', 'NODE_ENV'].filter((k) => k !== 'NODE_ENV' || process.env.NODE_ENV !== undefined))
  })
})

describe('the sandbox worker answers for sandbox bodies', () => {
  it('accepts a body it can run', async () => {
    expect(await validateSandboxFunction(sandboxBody)).toEqual({ valid: true })
  })

  it.each([
    ['reads the process', 'return process.env.DATABASE_URL', /forbidden pattern/],
    ['requires a module directly', "const fs = require('fs')\nreturn 1", /forbidden pattern/],
    ['asks for a package the sandbox does not have', "const pg = ctx.require('pg')\nreturn 1", /not available/],
    ['does not parse', 'return {', /Syntax error/],
  ])('refuses a body that %s', async (_what, code, why) => {
    const r = await validateSandboxFunction(code)
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(why)
  })

  it('refuses it through deploy_code with the worker\'s reason', async () => {
    const r = await deploy({ name: 'x', code: 'return process.env.JWT_SECRET', trigger: 'manual' })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CODE' })
    expect(r.summary).toMatch(/forbidden pattern/)
  })
})

describe('how deploy_code is wired', () => {
  const functions = getDomainTool('functions')!

  it('is a functions action routed to a brain tool that exists', () => {
    expect(functions.actions.deploy_code?.tool).toBe('deploy_function_code')
    expect(BRAIN_TOOLS.some((t) => t.function.name === 'deploy_function_code')).toBe(true)
  })

  it('advertises the source argument, and requires what the operation requires', () => {
    const schema = domainInputSchema(functions)
    expect(schema.properties).toHaveProperty('code')
    const def = BRAIN_TOOLS.find((t) => t.function.name === 'deploy_function_code')!.function as any
    expect(def.parameters.required).toEqual(['name', 'code', 'trigger'])
  })

  it('is a write: never shown to a read-only key, argument included', () => {
    expect(READ_ONLY_TOOLS.has('deploy_function_code' as any)).toBe(false)
    const view = readOnlyView(functions)!
    expect(view.actions).not.toHaveProperty('deploy_code')
    expect(domainInputSchema(view, { readOnly: true }).properties).not.toHaveProperty('code')
  })

  it('does not wait for approval, as creating a function does not', () => {
    expect(needsApproval('deploy_function_code')).toBe(needsApproval('generate_function'))
    expect(needsApproval('deploy_function_code')).toBe(false)
  })

  it('is not offered to the brain\'s own model', () => {
    expect(AGENT_ONLY_TOOLS.has('deploy_function_code')).toBe(true)
    expect(BRAIN_MODEL_TOOLS.some((t) => t.function.name === 'deploy_function_code')).toBe(false)
    expect(BRAIN_MODEL_TOOLS.length).toBe(BRAIN_TOOLS.length - AGENT_ONLY_TOOLS.size)
  })
})
