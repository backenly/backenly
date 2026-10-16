/**
 * delete_trigger deletes the one trigger it names in this project, or nothing,
 * and says which (medium finding WH-F15).
 *
 * executeDeleteTrigger passed the id straight to deleteTrigger, a project-scoped
 * deleteMany whose count nobody read, and answered "✅ Trigger removed" whatever
 * it matched. A mistyped id, or another project's, deleted nothing, so an
 * approval was recorded as executed while the trigger kept firing. A call
 * naming no trigger was worse: Prisma drops an undefined filter, so
 * deleteMany({ where: { id: undefined, projectId } }) deleted EVERY trigger in
 * the project and reported one removal. The approval card for a call by id
 * alone read "the trigger `unknown`".
 *
 * Real rows on a real database: the Review Queue's approval replay, the
 * brain's dispatcher an approved call runs through, both REST routes (the
 * Next.js handler, and the Express app over HTTP) and the brain's approval
 * gate. Only the model is scripted.
 */

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { generateToken } from '@/lib/auth/jwt'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { createApprovalRequest, decideApproval } from '@/lib/mcp/approvals'
import { deleteTrigger } from '@/lib/services/trigger-service'
import { DELETE as deleteRoute } from '@/app/api/v1/[projectId]/triggers/route'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain } from '@/lib/ai/brain/agent'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
let otherProjectId = ''
let token = ''

/** The tool as an approved call runs it: the brain's dispatcher, confirmation satisfied. */
const del = (args: Record<string, unknown>) =>
  dispatchTool('delete_trigger', args, { projectId, userId: ownerId, destructiveConfirmed: true })

/** A person approves the exact call in the Review Queue, and it runs. */
async function approve(toolArgs: Record<string, unknown>) {
  const request = await createApprovalRequest({
    projectId,
    userId: ownerId,
    message: 'delete that trigger',
    danger: { tool: 'delete_trigger', target: 'a trigger', rowCount: null, reversible: false },
    toolArgs,
  })
  const decided = await decideApproval({ projectId, approvalId: request.id, approverUserId: ownerId, decision: 'approve' })
  const stored = await prisma.agentApprovalRequest.findUnique({ where: { id: request.id } })
  return { decided, stored }
}

async function seed(project: string, name: string): Promise<string> {
  const row = await prisma.appTrigger.create({
    data: { projectId: project, name, sourceTable: 'orders', event: 'insert', actionType: 'webhook', webhookUrl: 'https://example.com/hook' },
    select: { id: true },
  })
  return row.id
}

const names = async (project: string) =>
  (await prisma.appTrigger.findMany({ where: { projectId: project }, select: { name: true } })).map((t) => t.name).sort()

function nextDelete(id: string | null): Promise<Response> {
  const query = new URLSearchParams(id === null ? {} : { id })
  const req: any = {
    method: 'DELETE',
    url: `http://localhost:3000/api/v1/${projectId}/triggers?${query}`,
    nextUrl: { pathname: `/api/v1/${projectId}/triggers`, searchParams: query },
    headers: new Headers(),
    cookies: { get: (k: string) => (k === 'auth-token' ? { value: token } : undefined) },
  }
  return deleteRoute(req, { params: Promise.resolve({ projectId }) }) as Promise<Response>
}

const expressDelete = (query: string) =>
  fetch(`${base}/api/v1/${projectId}/triggers${query}`, { method: 'DELETE', headers: { cookie: `auth-token=${token}` } })

beforeAll(async () => {
  // A multi-tenant database, as Cloud runs: the routes resolve the project by
  // id rather than as the deployment's only one.
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `trigger-scope-${randomUUID()}@test.invalid`
  ownerId = (await prisma.user.create({ data: { email, name: 'Trigger Scope Test' }, select: { id: true } })).id
  token = generateToken({ userId: ownerId, email } as any)
  projectId = (await prisma.project.create({ data: { name: 'trigger-scope', userId: ownerId }, select: { id: true } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'trigger-scope-other', userId: ownerId }, select: { id: true } })).id
  // The brain reads the workspace while it builds a turn's context.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

beforeEach(async () => {
  await prisma.appTrigger.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } })
})

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.conversationMessage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiUsage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 120_000)

describe('an approved delete_trigger deletes the trigger it names, or nothing', () => {
  it('an approved call naming no trigger deletes nothing, where it used to delete every trigger in the project', async () => {
    await seed(projectId, 'on_order_paid')
    await seed(projectId, 'on_order_refunded')

    const { decided, stored } = await approve({})

    expect(await names(projectId)).toEqual(['on_order_paid', 'on_order_refunded'])
    expect(decided).toMatchObject({ ok: false, status: 'failed' })
    expect(decided.resultSummary).toMatch(/triggerId or name is required/)
    expect(stored).toMatchObject({ status: 'failed' })
  }, 60_000)

  it("an approved call with another project's trigger id is recorded as failed, not executed", async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')
    await seed(projectId, 'on_order_paid')

    const { decided, stored } = await approve({ triggerId: theirs })

    expect(await names(otherProjectId)).toEqual(['their_trigger'])
    expect(await names(projectId)).toEqual(['on_order_paid'])
    expect(decided).toMatchObject({ ok: false, status: 'failed' })
    expect(decided.resultSummary).toContain(`No trigger in this project has the id "${theirs}", so nothing was deleted.`)
    expect(stored).toMatchObject({ status: 'failed' })
  }, 60_000)

  it('every way of naming no trigger is refused with INVALID_ARGUMENT', async () => {
    await seed(projectId, 'on_order_paid')
    await seed(projectId, 'on_order_refunded')

    for (const args of [{}, { name: '' }, { name: '   ' }, { triggerId: '' }, { triggerId: '', name: '' }]) {
      const result = await del(args)
      expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
      expect(result.summary).toMatch(/triggerId or name is required/)
    }
    expect(await names(projectId)).toEqual(['on_order_paid', 'on_order_refunded'])
  })

  it("another project's id, a mistyped id or an unknown name answers NOT_FOUND and deletes nothing", async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')
    await seed(projectId, 'on_order_paid')

    const foreign = await del({ triggerId: theirs })
    expect(foreign).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(foreign.summary).toContain('Its triggers are: on_order_paid.')

    const mistyped = await del({ triggerId: randomUUID() })
    expect(mistyped).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(mistyped.summary).toMatch(/so nothing was deleted/)

    const unknown = await del({ name: 'on_order_shipped' })
    expect(unknown).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(unknown.summary).toContain('No trigger in this project has the name "on_order_shipped", so nothing was deleted.')

    expect(await names(otherProjectId)).toEqual(['their_trigger'])
    expect(await names(projectId)).toEqual(['on_order_paid'])
  })

  it('a name two triggers share is refused, naming both ids, and neither is deleted', async () => {
    const first = await seed(projectId, 'notify')
    const second = await seed(projectId, 'notify')

    const result = await del({ name: 'notify' })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(result.summary).toContain(first)
    expect(result.summary).toContain(second)
    expect(result.summary).toMatch(/Name the one to delete by triggerId/)
    expect(await names(projectId)).toEqual(['notify', 'notify'])
  })

  it('by id, it deletes exactly that trigger and reports its stored name', async () => {
    const paid = await seed(projectId, 'on_order_paid')
    await seed(projectId, 'on_order_refunded')

    const result = await del({ triggerId: paid })

    expect(result).toMatchObject({
      ok: true,
      summary: '✅ Trigger "on_order_paid" removed.',
      data: { deleted: true, triggerId: paid, name: 'on_order_paid' },
    })
    expect(await names(projectId)).toEqual(['on_order_refunded'])
  })

  it('by a unique name, it deletes exactly that trigger', async () => {
    await seed(projectId, 'on_order_paid')
    const refunded = await seed(projectId, 'on_order_refunded')

    const result = await del({ name: 'on_order_refunded' })

    expect(result).toMatchObject({ ok: true, data: { deleted: true, triggerId: refunded, name: 'on_order_refunded' } })
    expect(await names(projectId)).toEqual(['on_order_paid'])
  })
})

describe('deleteTrigger reports what it deleted', () => {
  it('refuses a missing id instead of running a project-wide delete', async () => {
    await seed(projectId, 'on_order_paid')
    await seed(projectId, 'on_order_refunded')

    await expect(deleteTrigger(projectId, undefined as unknown as string)).rejects.toThrow(/needs the id/)
    await expect(deleteTrigger(projectId, '')).rejects.toThrow(/needs the id/)
    expect(await names(projectId)).toEqual(['on_order_paid', 'on_order_refunded'])
  })

  it("answers false for another project's trigger and true for its own", async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')
    const mine = await seed(projectId, 'on_order_paid')

    await expect(deleteTrigger(projectId, theirs)).resolves.toBe(false)
    await expect(deleteTrigger(projectId, mine)).resolves.toBe(true)
    expect(await names(otherProjectId)).toEqual(['their_trigger'])
    expect(await names(projectId)).toEqual([])
  })
})

describe('the REST routes answer 404 for a trigger that is not in the project', () => {
  it('Next.js: 404 for another project\'s id and the trigger survives; 200 for its own', async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')
    const mine = await seed(projectId, 'on_order_paid')

    const foreign = await nextDelete(theirs)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Trigger not found in this project' })
    expect(await names(otherProjectId)).toEqual(['their_trigger'])

    const own = await nextDelete(mine)
    expect(own.status).toBe(200)
    expect(await names(projectId)).toEqual([])

    expect((await nextDelete(null)).status).toBe(400)
  })

  it("Express: 404 for another project's id, 400 for a repeated id, 200 for its own", async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')
    const mine = await seed(projectId, 'on_order_paid')

    const foreign = await expressDelete(`?id=${theirs}`)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Trigger not found in this project' })
    expect(await names(otherProjectId)).toEqual(['their_trigger'])

    expect((await expressDelete(`?id=${mine}&id=${theirs}`)).status).toBe(400)
    expect(await names(projectId)).toEqual(['on_order_paid'])

    const own = await expressDelete(`?id=${mine}`)
    expect(own.status).toBe(200)
    expect(await names(projectId)).toEqual([])
  })
})

describe('the approval card names the trigger a person is approving', () => {
  const classified = scriptedMessage({ text: JSON.stringify({ intent: 'DESTRUCTIVE', confidence: 0.9, reasoning: 'scripted' }) })

  async function blockedTarget(input: Record<string, unknown>): Promise<string> {
    await prisma.conversationMessage.deleteMany({ where: { projectId } })
    setSpendLedgerForTests(memorySpendLedger())
    setProviderForTests(
      scriptedProvider([
        classified,
        scriptedMessage({ toolUse: [{ id: 'toolu_del', name: 'delete_trigger', input }] }),
        scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Queued for approval.' } }] }),
      ]),
    )
    try {
      const result = await runBrain({ projectId, userId: ownerId, message: 'delete that trigger' }, () => {})
      expect(result.blockedCalls).toHaveLength(1)
      expect(result.blockedCalls![0]).toMatchObject({ tool: 'delete_trigger', args: input })
      return result.blockedCalls![0].target
    } finally {
      setProviderForTests(null)
      setSpendLedgerForTests(null)
    }
  }

  it('a call by id shows the stored name, and the gate deletes nothing', async () => {
    const paid = await seed(projectId, 'on_order_paid')

    expect(await blockedTarget({ triggerId: paid })).toBe('the trigger `on_order_paid`')
    expect(await names(projectId)).toEqual(['on_order_paid'])
  }, 60_000)

  it('an id that is not in the project, or no trigger at all, is shown as such', async () => {
    const theirs = await seed(otherProjectId, 'their_trigger')

    expect(await blockedTarget({ triggerId: theirs })).toBe(`the trigger \`${theirs}\` (no such trigger in this project)`)
    expect(await blockedTarget({})).toBe('no trigger (the call names none)')
  }, 60_000)
})
