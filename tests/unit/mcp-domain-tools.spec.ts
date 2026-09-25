/**
 * Domain tools: one advertised MCP door per dashboard section.
 *
 * Three things must hold for this to be a door rather than a bypass:
 *   1. Every action lands on an EXISTING brain tool, and never on a
 *      control-loop tool or one the MCP surface deliberately keeps out.
 *   2. Every action that is destructive, or that the executor rates high risk,
 *      waits for a human, and waits with the EXACT call, which then runs
 *      verbatim (runApprovedCall).
 *   3. The checks the route makes (read-only keys, the credit gate) judge the
 *      action's target, not the domain tool's name.
 *
 * The route tests replace the guard, the brain's dispatcher, approval storage
 * and the credit check with recorders; nothing here reaches a database.
 */

import '../helpers/next-request-polyfill'
import { NextRequest, NextResponse } from 'next/server'

let mockReadOnly = false
let mockCreditsExhausted = false
const mockDispatched: { name: string; args: Record<string, unknown>; ctx: any }[] = []
const mockParked: any[] = []

jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { keyId: 'k1', projectId: 'p1', userId: 'u1', scope: 'mcp', readOnly: mockReadOnly },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => NextResponse.json({ ok: false, code: 'READ_ONLY_KEY' }, { status: 403 })),
}))

jest.mock('@/lib/ai/brain/tools', () => {
  const actual = jest.requireActual('@/lib/ai/brain/tools')
  return {
    ...actual,
    dispatchTool: jest.fn(async (name: string, args: Record<string, unknown>, ctx: any) => {
      mockDispatched.push({ name, args: { ...args }, ctx })
      return { ok: true, summary: 'done' }
    }),
  }
})

jest.mock('@/lib/mcp/approvals', () => {
  const actual = jest.requireActual('@/lib/mcp/approvals')
  return {
    ...actual,
    createApprovalRequest: jest.fn(async (input: any) => {
      mockParked.push(input)
      return { id: 'appr-1' }
    }),
  }
})

jest.mock('@/lib/entitlements/policy', () => ({
  enforceAiCredits: jest.fn(async () =>
    mockCreditsExhausted
      ? { message: 'Credits spent.', currentPlan: 'SANDBOX', requiredPlan: 'BUILDER' }
      : true,
  ),
  chargeAiCredits: jest.fn(async () => {}),
}))

import { BRAIN_TOOLS, TOOL_TO_ACTION, isDestructiveTool } from '@/lib/ai/brain/tools'
import { riskLevelForExecutorAction } from '@/lib/operational-memory/ledger'
import { buildCatalog, isReadOnlyTool } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS, domainDescription, domainInputSchema, needsApproval, resolveDomainAction } from '@/lib/mcp/domains'
import { runApprovedCall } from '@/lib/mcp/approvals'
import { POST } from '@/app/api/mcp/tool/route'

const brainNames = new Set(BRAIN_TOOLS.map((t) => t.function?.name).filter(Boolean) as string[])
const everyAction = DOMAIN_TOOLS.flatMap((d) =>
  Object.entries(d.actions).map(([action, { tool }]) => ({ domain: d.name, action, tool })),
)

function call(tool: string, args: Record<string, unknown>) {
  return POST(
    new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
      body: JSON.stringify({ tool, args }),
    }),
  )
}

beforeEach(() => {
  mockReadOnly = false
  mockCreditsExhausted = false
  mockDispatched.length = 0
  mockParked.length = 0
})

describe('the domain table', () => {
  it('routes every action to a brain tool that exists', () => {
    const missing = everyAction.filter((a) => !brainNames.has(a.tool))
    expect(missing).toEqual([])
  })

  it('never routes to a control-loop tool, or to resolve_finding (its fixes would be auto-confirmed here)', () => {
    const forbidden = new Set(['propose_plan', 'ask_user', 'answer_question', 'finish', 'run_test', 'rollback', 'fix_backend', 'apply_proposal', 'resolve_finding'])
    expect(everyAction.filter((a) => forbidden.has(a.tool))).toEqual([])
  })

  it('advertises every domain tool', () => {
    const advertised = new Set(buildCatalog().map((t) => t.name))
    expect(DOMAIN_TOOLS.filter((d) => !advertised.has(d.name)).map((d) => d.name)).toEqual([])
  })

  it('sends every destructive target to approval', () => {
    const unguarded = everyAction.filter((a) => isDestructiveTool(a.tool) && !needsApproval(a.tool))
    expect(unguarded).toEqual([])
  })

  it('sends every target the executor rates high risk to approval, not only the brain\'s destructive set', () => {
    const unguarded = everyAction.filter((a) => {
      const build = TOOL_TO_ACTION[a.tool]
      return build && riskLevelForExecutorAction(build({}).action) === 'high' && !needsApproval(a.tool)
    })
    expect(unguarded).toEqual([])
    // The case that makes the second authority necessary.
    expect(isDestructiveTool('disconnect_frontend')).toBe(false)
    expect(needsApproval('disconnect_frontend')).toBe(true)
  })

  it('marks every approval-gated action in the description an agent reads', () => {
    for (const d of DOMAIN_TOOLS) {
      const text = domainDescription(d)
      for (const [action, { tool }] of Object.entries(d.actions)) {
        const line = text.split('\n').find((l) => l.startsWith(`• ${action}:`))!
        expect({ action, gated: /waits for human approval/.test(line) }).toEqual({ action, gated: needsApproval(tool) })
      }
    }
  })

  it('advertises every argument an action requires, and nothing it does not take', () => {
    for (const d of DOMAIN_TOOLS) {
      const schema = domainInputSchema(d)
      expect(schema.additionalProperties).toBe(false)
      expect((schema.properties.action as any).enum).toEqual(Object.keys(d.actions))
      for (const { tool } of Object.values(d.actions)) {
        const def: any = BRAIN_TOOLS.find((t) => t.function?.name === tool)!.function
        for (const req of def.parameters?.required ?? []) {
          expect({ domain: d.name, tool, req, present: req in schema.properties }).toMatchObject({ present: true })
        }
      }
    }
  })

  it('refuses an unknown action with the real list', () => {
    const r = resolveDomainAction('storage', 'nuke')
    expect(r).toMatchObject({ kind: 'unknown_action', supported: Object.keys(DOMAIN_TOOLS.find((d) => d.name === 'storage')!.actions) })
    expect(resolveDomainAction('not_a_domain', 'x')).toBeNull()
  })
})

describe('what a read-only key discovers', () => {
  const ro = () => buildCatalog({ readOnly: true })
  const writeActions = everyAction.filter((a) => !isReadOnlyTool(a.tool))

  it('keeps one door per section: every domain with a read action is served', () => {
    const names = new Set(ro().map((t) => t.name))
    for (const d of DOMAIN_TOOLS) {
      const hasRead = Object.values(d.actions).some((a) => isReadOnlyTool(a.tool))
      expect({ domain: d.name, served: names.has(d.name) }).toEqual({ domain: d.name, served: hasRead })
    }
  })

  it('offers exactly the read actions in the action enum', () => {
    for (const t of ro().filter((t) => DOMAIN_TOOLS.some((d) => d.name === t.name))) {
      const d = DOMAIN_TOOLS.find((x) => x.name === t.name)!
      const reads = Object.entries(d.actions).filter(([, a]) => isReadOnlyTool(a.tool)).map(([n]) => n)
      expect({ tool: t.name, enum: (t.inputSchema.properties.action as any).enum }).toEqual({ tool: t.name, enum: reads })
    }
  })

  it('never shows a write action, in the enum or the description', () => {
    const served = new Map(ro().map((t) => [t.name, t]))
    const leaked = writeActions.filter((a) => {
      const t = served.get(a.domain)
      if (!t) return false
      const inEnum = (t.inputSchema.properties.action as any).enum.includes(a.action)
      const inText = t.description.split('\n').some((line) => line.startsWith(`• ${a.action}:`))
      return inEnum || inText
    })
    expect(leaked).toEqual([])
  })

  it('offers no argument that asks a read to write', () => {
    const deploy = ro().find((t) => t.name === 'deploy')!
    expect(Object.keys(deploy.inputSchema.properties)).not.toContain('autoFix')
    expect(deploy.description).not.toMatch(/autoFix/)
  })

  it('marks every narrowed domain read-only, so a host can treat it as one', () => {
    for (const t of ro().filter((t) => DOMAIN_TOOLS.some((d) => d.name === t.name))) {
      expect({ tool: t.name, ...t.annotations }).toMatchObject({ tool: t.name, readOnlyHint: true, destructiveHint: false })
    }
  })

  it('is described in the Connect guide with the counts the catalog really serves', () => {
    const { article } = require('@/app/resources/content/connect-your-coding-agent')
    expect(JSON.stringify(article)).toContain(`served ${ro().length} tools instead of ${buildCatalog().length}`)
  })

  it('still withholds every write-only door', () => {
    const names = ro().map((t) => t.name)
    for (const w of ['backend_chat', 'apply_migration', 'db_insert', 'db_update', 'db_delete', 'set_rls', 'branch']) {
      expect(names).not.toContain(w)
    }
  })
})

describe('the tool route', () => {
  it('runs a domain action as its target, without the action key', async () => {
    const res = await call('storage', { action: 'create_bucket', bucketName: 'avatars', isPublic: false })
    expect(res.status).toBe(200)
    expect(mockDispatched.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: 'create_bucket', args: { bucketName: 'avatars', isPublic: false } },
    ])
  })

  it('reaches a target the old surface kept out, when the domain table admits it', async () => {
    await call('auth', { action: 'add_oauth_provider', provider: 'google', clientId: 'id', clientSecret: 'secret' })
    expect(mockDispatched.map((d) => d.name)).toEqual(['add_oauth_provider'])
  })

  it('parks a destructive action with the exact call and runs nothing', async () => {
    const res = await call('deploy', { action: 'rollback', version: 3 })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockDispatched).toEqual([])
    expect(body).toMatchObject({ ok: true, status: 'awaiting_approval', approval: { id: 'appr-1', status: 'pending' } })
    expect(mockParked).toHaveLength(1)
    expect(mockParked[0]).toMatchObject({
      projectId: 'p1',
      userId: 'u1',
      apiKeyId: 'k1',
      danger: { tool: 'rollback_deploy' },
      toolArgs: { version: 3 },
    })
  })

  it('parks a high-risk action the brain does not call destructive', async () => {
    await call('connect', { action: 'disconnect_frontend', url: 'https://app.example.com' })
    expect(mockDispatched).toEqual([])
    expect(mockParked[0]).toMatchObject({ danger: { tool: 'disconnect_frontend' }, toolArgs: { url: 'https://app.example.com' } })
  })

  it('answers an unknown action with 400 and the supported list', async () => {
    const res = await call('deploy', { action: 'yolo' })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.code).toBe('UNKNOWN_ACTION')
    expect(body.supported).toEqual(['status', 'readiness', 'deploy', 'rollback'])
  })

  it('lets a read-only key run a read action and refuses it a write', async () => {
    mockReadOnly = true
    const read = await call('monitoring', { action: 'metrics' })
    const write = await call('monitoring', { action: 'set_alert', type: 'error_rate', threshold: 5 })

    expect(isReadOnlyTool('get_metrics')).toBe(true)
    expect(read.status).toBe(200)
    expect(write.status).toBe(403)
    expect(mockDispatched.map((d) => d.name)).toEqual(['get_metrics'])
  })

  it('refuses a read-only key every write action of every domain, and dispatches nothing', async () => {
    mockReadOnly = true
    const writes = everyAction.filter((a) => !isReadOnlyTool(a.tool))
    for (const w of writes) {
      const res = await call(w.domain, { action: w.action })
      expect({ call: `${w.domain}.${w.action}`, status: res.status }).toEqual({ call: `${w.domain}.${w.action}`, status: 403 })
    }
    expect(mockDispatched).toEqual([])
    expect(mockParked).toEqual([])
  })

  it('serves a read-only key every read action it is shown', async () => {
    mockReadOnly = true
    const reads = everyAction.filter((a) => isReadOnlyTool(a.tool))
    for (const r of reads) {
      const res = await call(r.domain, { action: r.action })
      expect({ call: `${r.domain}.${r.action}`, status: res.status }).toEqual({ call: `${r.domain}.${r.action}`, status: 200 })
    }
    expect(mockDispatched.map((d) => d.name)).toEqual(reads.map((r) => r.tool))
  })

  it('tells a read-only key only the read actions when it asks for one that does not exist', async () => {
    mockReadOnly = true
    const res = await call('deploy', { action: 'yolo' })
    const body = await res.json()
    expect(body.supported).toEqual(['status', 'readiness'])
  })

  it('never parks a request from a read-only key either', async () => {
    mockReadOnly = true
    const res = await call('deploy', { action: 'deploy' })
    expect(res.status).toBe(403)
    expect(mockParked).toEqual([])
  })

  it('applies the credit gate to functions.create, which writes code with Backenly\'s model', async () => {
    mockCreditsExhausted = true
    const res = await call('functions', { action: 'create', name: 'x', description: 'send a welcome email on signup', trigger: 'on_signup' })
    const body = await res.json()
    expect(res.status).toBe(402)
    expect(body.code).toBe('AI_CREDITS_EXHAUSTED')
    expect(mockDispatched).toEqual([])
  })

  it('keeps a readiness read side-effect free through the deploy tool too', async () => {
    await call('deploy', { action: 'readiness' })
    expect(mockDispatched).toMatchObject([{ name: 'get_readiness', args: { autoFix: false } }])
  })
})

describe('runApprovedCall', () => {
  const ctx = { projectId: 'p1', userId: 'approver', destructiveConfirmed: true } as any

  it('runs the exact call with destructive confirmation', async () => {
    const seen: any[] = []
    const out = await runApprovedCall('rollback_deploy', { version: 3 }, ctx, async (name, args, c) => {
      seen.push({ name, args, confirmed: c.destructiveConfirmed })
      return { ok: true, summary: 'Rolled back to v3' }
    })
    expect(seen).toEqual([{ name: 'rollback_deploy', args: { version: 3 }, confirmed: true }])
    expect(out).toEqual({ status: 'executed', summary: 'Rolled back to v3' })
  })

  it('does not call it executed when the executor only asked for another confirmation', async () => {
    const out = await runApprovedCall('trigger_deploy', {}, ctx, async () => ({ ok: true, needsUser: true, summary: 'Type DEPLOY' }))
    expect(out.status).toBe('failed')
    expect(out.summary).toMatch(/further confirmation/)
  })

  it('reports a failed call as failed', async () => {
    const out = await runApprovedCall('delete_bucket', { bucketName: 'x' }, ctx, async () => ({ ok: false, summary: 'no such bucket' }))
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.summary).toMatch(/no such bucket/)
  })

  it('reports a thrown or overrunning call as failed rather than hanging', async () => {
    const thrown = await runApprovedCall('delete_bucket', {}, ctx, async () => { throw new Error('boom') })
    const slow = await runApprovedCall('delete_bucket', {}, ctx, () => new Promise(() => {}), 50)
    expect(thrown).toMatchObject({ status: 'failed' })
    expect(slow.status).toBe('failed')
    expect(slow.summary).toMatch(/exceeded/)
  })
})
