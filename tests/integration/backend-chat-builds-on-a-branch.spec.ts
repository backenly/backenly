/**
 * backend_chat builds on a preview branch when production is protected
 * (production QA 2026-11-09, report 97, Decision 4b).
 *
 * On Cloud, protection is the default, and backend_chat stopped at the gate:
 * QA asked for wishlists and product Q&A, and after two minutes got back a plan
 * telling its coding agent to create a branch and run apply_migration. The
 * builder was a planner. Now the turn builds the schema on a preview branch,
 * saves what needs the tables on production (their APIs, row security,
 * realtime, seed rows) for after the merge, and asks a person once: one merge
 * of the branch, with its statements pinned. A build turn there is charged when
 * it ends with that request, not when it only planned.
 *
 * Real: the brain, the dispatcher, the executor, the branch engine, the branch
 * migration log, the approval request (its pinned statements, preflight and
 * impact), the merge replay onto production, backend_chat's run and its charge.
 * Stubbed: PostgREST's schema registry (configuration of an external service),
 * the Cloud plan and the credit ledger's write (commercial, absent in OSS), the
 * architect (a model call with its own validation) and the post-build fix loop
 * (it signs users up against a live runtime).
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
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
jest.mock('@/lib/entitlements/policy', () => {
  const actual = jest.requireActual('@/lib/entitlements/policy')
  const { prisma: db } = jest.requireActual('@/lib/db/prisma')
  return {
    ...actual,
    aiCreditCap: jest.fn(async () => 1_000),
    chargeAiCredits: jest.fn(async (billingAccountId: string, tokens: number) => {
      const date = actual.thisMonth()
      await db.accountAiUsage.upsert({
        where: { billingAccountId_date: { billingAccountId, date } },
        update: { tokenCount: { increment: tokens } },
        create: { billingAccountId, date, tokenCount: tokens },
      })
    }),
  }
})
jest.mock('@/lib/ai/blueprints', () => ({ ...jest.requireActual('@/lib/ai/blueprints'), getBlueprintForPrompt: jest.fn() }))
jest.mock('@/lib/ai/agentic-fix-loop', () => ({ runAgenticFixLoop: jest.fn() }))
jest.mock('@/lib/mcp/guard', () => ({ ...jest.requireActual('@/lib/mcp/guard'), recordMcpCall: jest.fn() }))

import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedProvider, type ScriptStep } from '@/lib/ai/llm/providers/scripted'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'
import { runAgenticFixLoop } from '@/lib/ai/agentic-fix-loop'
import type { Blueprint, BlueprintStep } from '@/lib/ai/blueprints/types'
import { savePendingPlan } from '@/lib/ai/blueprints/store'
import { loadLoopResume, saveLoopResume } from '@/lib/ai/brain/loop-resume'
import { loadAfterMerge } from '@/lib/branches/build-branch'
import { forgetProtection } from '@/lib/branches/protection'
import { runApprovedCall } from '@/lib/mcp/approvals'
import { thisMonth } from '@/lib/entitlements/policy'
import { executeRun } from '@/lib/mcp/chat-turn'
import { classified, finished, setUpBrainProject, systemOf, toolCall } from '../helpers/brain-harness'

const architect = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>
const fixLoop = runAgenticFixLoop as jest.MockedFunction<typeof runAgenticFixLoop>

const built = setUpBrainProject({ name: 'chat-builds-on-a-branch', tables: ['keep_me'] })
const fresh = setUpBrainProject({ name: 'chat-builds-fresh-on-a-branch' })
const MCP = { door: 'mcp' as const }
const month = thisMonth()

const wishlists = toolCall('create_table', { tableName: 'wishlists', columns: [{ name: 'title', type: 'text', nullable: false }] }, 'toolu_wishlists')
const wishlistsApi = toolCall('generate_api', { tableName: 'wishlists' }, 'toolu_wishlists_api')

async function tablesIn(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
    schema,
  )
  return rows.map((r) => r.table_name)
}

const activeBranches = (projectId: string) =>
  prisma.workspaceBranch.findMany({ where: { projectId, status: 'active' }, orderBy: { createdAt: 'asc' } })

/** One backend_chat run, as the route starts it: its approvals parked, its credits charged. */
async function run(project: typeof built, script: ScriptStep[], message: string) {
  setProviderForTests(scriptedProvider(script))
  return executeRun(null, {
    caller: { keyId: 'test-key', projectId: project.projectId, userId: project.ownerId },
    message,
    creditAccount: project.ownerId,
    startedAt: Date.now(),
  })
}

const charged = async (account: string) =>
  (await prisma.accountAiUsage.findUnique({ where: { billingAccountId_date: { billingAccountId: account, date: month } } }))?.tokenCount ?? 0

const edition = process.env.BACKENLY_EDITION
const engineMode = process.env.ENGINE_MODE

async function clearBranches(projectId: string) {
  for (const b of await prisma.workspaceBranch.findMany({ where: { projectId } })) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`)
  }
  await prisma.workspaceBranchMigration.deleteMany({ where: { branch: { projectId } } })
  await prisma.workspaceBranch.deleteMany({ where: { projectId } })
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } })
  await prisma.projectPreference.deleteMany({ where: { projectId, type: 'pending_plan' } })
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js runs the executor without DDL; a branch build issues it as the product does.
  process.env.ENGINE_MODE = 'runtime'
  await prisma.project.updateMany({ where: { id: { in: [built.projectId, fresh.projectId] } }, data: { protectedProduction: true } })
  forgetProtection()
})

beforeEach(async () => {
  architect.mockReset()
  fixLoop.mockReset()
  fixLoop.mockRejectedValue(new Error('no live runtime in tests'))
  for (const p of [built, fresh]) {
    await clearBranches(p.projectId)
    await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: p.ownerId } })
    await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: p.ownerId } })
  }
})

afterAll(async () => {
  for (const p of [built, fresh]) {
    await clearBranches(p.projectId)
    await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: p.ownerId } })
    await prisma.aiCreditHold.deleteMany({ where: { billingAccountId: p.ownerId } })
  }
  await prisma.project.updateMany({ where: { id: { in: [built.projectId, fresh.projectId] } }, data: { protectedProduction: false } })
  forgetProtection()
  if (edition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = edition
  if (engineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = engineMode
})

describe('a request to change the schema of a protected production', () => {
  it('is built on a preview branch, with what needs the table on production saved for after one merge', async () => {
    const { result, provider } = await built.turn(
      [classified('MODIFY'), wishlists, wishlistsApi, finished('Wishlists are ready.')],
      'add a wishlists table',
      MCP,
    )

    expect(systemOf(provider, 1)).toContain('this turn builds its schema on a preview branch')
    const [branch] = await activeBranches(built.projectId)
    expect(branch).toMatchObject({ name: 'wishlists' })
    expect(await tablesIn(branch.schemaName)).toContain('wishlists')
    expect(await tablesIn(built.schema)).not.toContain('wishlists')

    // Nothing is on production, so nothing is reported as applied there.
    expect(result.applied).toEqual([])
    expect(result.branchBuild).toMatchObject({
      branchId: branch.id,
      branch: 'wishlists',
      statements: ['CREATE TABLE "wishlists" ("title" text NOT NULL)'],
      afterMerge: [expect.stringMatching(/wishlists/)],
    })
    expect(result.blockedCalls).toEqual([
      { tool: 'merge_branch', args: { branchId: branch.id }, target: 'Merge preview branch "wishlists" into production', rowCount: null, reversible: true },
    ])
    expect(result.summary).toContain('**Built on preview branch "wishlists"**')
    expect(result.summary).toContain('**After the merge** · 1')
    expect(await loadAfterMerge(built.projectId)).toMatchObject({ branchId: branch.id, steps: [{ tool: 'generate_api', args: { tableName: 'wishlists' } }] })
  }, 120_000)

  it('asks a person once, with the statements pinned, and is charged for that request', async () => {
    const { body } = await run(built, [classified('MODIFY'), wishlists, finished('Wishlists are ready.')], 'add a wishlists table')

    const request = await prisma.agentApprovalRequest.findFirstOrThrow({ where: { projectId: built.projectId } })
    expect(request).toMatchObject({ tool: 'merge_branch', status: 'pending', target: 'Merge preview branch "wishlists" into production' })
    expect(request.toolArgs).toMatchObject({ approvedMigrations: ['CREATE TABLE "wishlists" ("title" text NOT NULL)'] })
    expect(body).toMatchObject({ ok: true, status: 'awaiting_approval', approval: { id: request.id }, branch: { branch: 'wishlists' } })
    expect(body.summary).toContain(`Poll \`check_approval\` with id "${request.id}"`)
    expect(body.summary).toContain('Production has not changed yet.')
    expect(await charged(built.ownerId)).toBeGreaterThan(0)
  }, 120_000)

  it('is not charged when it only planned', async () => {
    const { body } = await run(built, [classified('MODIFY'), finished('A wishlists table would need a title column.')], 'add a wishlists table')

    expect(body).toMatchObject({ ok: true })
    expect(await prisma.agentApprovalRequest.count({ where: { projectId: built.projectId } })).toBe(0)
    expect(await activeBranches(built.projectId)).toEqual([])
    expect(await charged(built.ownerId)).toBe(0)
  }, 120_000)

  it('runs what it saved once the merge has reached production, and says it is waiting until then', async () => {
    await run(built, [classified('MODIFY'), wishlists, wishlistsApi, finished('Wishlists are ready.')], 'add a wishlists table')
    const request = await prisma.agentApprovalRequest.findFirstOrThrow({ where: { projectId: built.projectId, tool: 'merge_branch' } })

    const early = await built.turn([classified('CONFIRM')], 'continue', MCP)
    expect(early.result.summary).toContain(`still waiting for a person's approval (approval "${request.id}")`)
    expect(early.result.toolsRun).toEqual([])

    // The person approves: the merge replays exactly the pinned statements onto production.
    const approved = await runApprovedCall('merge_branch', request.toolArgs as Record<string, unknown>, {
      projectId: built.projectId,
      userId: built.ownerId,
      destructiveConfirmed: true,
    })
    expect(approved.status).toBe('executed')
    expect(await tablesIn(built.schema)).toContain('wishlists')

    const after = await built.turn([classified('CONFIRM')], 'continue', MCP)
    expect(after.result.toolsRun).toEqual(['generate_api'])
    expect(after.result.branchBuild).toBeUndefined()
    expect(await loadAfterMerge(built.projectId)).toBeNull()
  }, 180_000)

  it('builds on the open branch until its merge is asked for, then starts a branch of its own', async () => {
    const comments = toolCall('create_table', { tableName: 'comments', columns: [{ name: 'body', type: 'text' }] }, 'toolu_comments')
    const reviews = toolCall('create_table', { tableName: 'reviews', columns: [{ name: 'stars', type: 'int' }] }, 'toolu_reviews')
    const tags = toolCall('create_table', { tableName: 'tags', columns: [{ name: 'label', type: 'text' }] }, 'toolu_tags')
    const names = async () => (await activeBranches(built.projectId)).map((b) => b.name)

    // The harness parks nothing, so no merge is waiting: the next turn keeps building on the open branch.
    await built.turn([classified('MODIFY'), wishlists, finished('Done.')], 'add a wishlists table', MCP)
    await built.turn([classified('MODIFY'), comments, finished('Done.')], 'add comments', MCP)
    expect(await names()).toEqual(['wishlists'])

    // backend_chat's run asks a person to merge it: every statement on the branch, pinned.
    await run(built, [classified('MODIFY'), reviews, finished('Done.')], 'add reviews')
    const request = await prisma.agentApprovalRequest.findFirstOrThrow({ where: { projectId: built.projectId, tool: 'merge_branch' } })
    expect(request.toolArgs).toMatchObject({
      approvedMigrations: [
        'CREATE TABLE "wishlists" ("title" text NOT NULL)',
        'CREATE TABLE "comments" ("body" text)',
        'CREATE TABLE "reviews" ("stars" int)',
      ],
    })

    // Put to a person, it is never changed under them: the next change starts a branch of its own.
    await built.turn([classified('MODIFY'), tags, finished('Done.')], 'add tags', MCP)
    expect(await names()).toEqual(['wishlists', 'tags'])
  }, 180_000)
})

describe('a plan for a new protected project', () => {
  const notes: BlueprintStep = { label: 'Create notes', tool: 'create_table', args: { tableName: 'notes', columns: [{ name: 'title', type: 'text' }] } }
  const plan: Blueprint = {
    domain: 'notes',
    title: 'Notes app',
    summary: 'Notes.',
    steps: [
      notes,
      { label: 'Generate REST API for notes', tool: 'generate_api', args: { tableName: 'notes' } },
      { label: 'Seed notes', tool: 'seed_rows', args: { tableName: 'notes', rows: [{ title: 'first' }] } },
    ],
  }

  it('is designed and proposed, not refused', async () => {
    architect.mockResolvedValueOnce({ blueprint: plan, match: { domain: 'notes', confidence: 0.9, matchedOn: 'llm-architect' }, architectTokens: 0 })
    const { result } = await fresh.turn([classified('BUILD')], 'A notes app where people keep notes.', MCP)
    expect(result.failureCode).toBeUndefined()
    expect(result.summary).toContain('**Notes app**')
    expect(result.summary).toContain('Reply "go ahead" to run this')
  }, 120_000)

  it('runs on "go ahead": the tables on a branch, the rest saved for after the merge, which is requested', async () => {
    await savePendingPlan(fresh.projectId, plan, { domain: 'notes', confidence: 0.9, matchedOn: 'llm-architect' }, 0)

    const { result } = await fresh.turn([classified('CONFIRM')], 'go ahead', MCP)

    const [branch] = await activeBranches(fresh.projectId)
    expect(branch.name).toBe('notes')
    expect(await tablesIn(branch.schemaName)).toEqual(['notes'])
    expect(await tablesIn(fresh.schema)).toEqual([])
    expect(result.blockedCalls).toEqual([expect.objectContaining({ tool: 'merge_branch', args: { branchId: branch.id } })])
    expect(result.branchBuild).toMatchObject({ branch: 'notes', afterMerge: ['Generate REST API for notes', 'Seed notes'] })
    expect(result.summary).toContain('**Built on preview branch "notes".** 1 step applied there')
    expect(result.summary).toContain('Its merge into production is requested for a person to approve.')
    // Nothing on production to check yet.
    expect(fixLoop).not.toHaveBeenCalled()
  }, 120_000)

  it('is designed again on "continue" after the architect failed on the request, and runs the same way', async () => {
    // The turn the architect failed on fell to the loop, which stopped unfinished and saved the request.
    await saveLoopResume(fresh.projectId, 'a notes app', [], 'step_budget', true)
    architect.mockResolvedValueOnce({ blueprint: plan, match: { domain: 'notes', confidence: 0.9, matchedOn: 'llm-architect' }, architectTokens: 0 })

    const { result } = await fresh.turn([classified('CONFIRM')], 'continue', MCP)

    expect(architect).toHaveBeenCalledWith('a notes app', fresh.projectId, expect.any(Function))
    const [branch] = await activeBranches(fresh.projectId)
    // Named after the saved request, not after "continue".
    expect(branch.name).toBe('notes')
    expect(await tablesIn(branch.schemaName)).toEqual(['notes'])
    expect(await tablesIn(fresh.schema)).toEqual([])
    expect(result.blockedCalls).toEqual([expect.objectContaining({ tool: 'merge_branch', args: { branchId: branch.id } })])
    expect(result.branchBuild).toMatchObject({ branch: 'notes', afterMerge: ['Generate REST API for notes', 'Seed notes'] })
    // The plan took over from the saved request, so a later "yes" does not design it again.
    expect(await loadLoopResume(fresh.projectId)).toBeNull()
  }, 120_000)
})
