/**
 * Every curated blueprint runs to the end, and its row-level security applies.
 *
 * Four of the six plans asked for policies their tables could not take:
 * `owner_read_write` on order_items, refunds, attachments and subscribers, which
 * have no user column, and `org_members` on seven project-management tables
 * with no organization_id. Each such step failed after the tables were built,
 * every "go ahead" ended with follow-ups, and "continue" ran them into the same
 * refusal again. A child table now names the parent that owns it (`via`), and
 * every org-scoped table carries organization_id.
 *
 * Real brain, dispatcher, executor and database; only the classifier's answer
 * is scripted. The post-build fix loop is stubbed: it signs users up against a
 * live runtime, which a test run does not start.
 */
jest.mock('@/lib/ai/agentic-fix-loop', () => ({ runAgenticFixLoop: jest.fn() }))

import { prisma } from '@/lib/db/prisma'
import { getBlueprint } from '@/lib/ai/blueprints'
import { savePendingPlan } from '@/lib/ai/blueprints/store'
import type { BlueprintDomain } from '@/lib/ai/blueprints/types'
import { runAgenticFixLoop, type FixLoopResult } from '@/lib/ai/agentic-fix-loop'
import { createEmptyGraph } from '@/lib/orchestration/backend-state-graph'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { isAuthManagedTable } from '@/lib/mcp/schema-introspection'
import { classified, setUpBrainProject, type BrainProject } from '../helpers/brain-harness'

const fixLoop = runAgenticFixLoop as jest.MockedFunction<typeof runAgenticFixLoop>

const DOMAINS: BlueprintDomain[] = ['social-media', 'marketplace', 'saas', 'chat-app', 'blog', 'project-mgmt']
const projects = Object.fromEntries(
  DOMAINS.map((d) => [d, setUpBrainProject({ name: `curated-${d}` })]),
) as Record<BlueprintDomain, BrainProject>

const engineMode = process.env.ENGINE_MODE
beforeAll(async () => {
  // jest.setup.js runs the executor against an in-memory graph that skips DDL.
  process.env.ENGINE_MODE = 'runtime'
  // A project as provisioning leaves it: with a backend graph, which enabling
  // end-user auth records itself in.
  for (const p of Object.values(projects)) {
    const graph = await prisma.backendGraph.create({
      data: { projectId: p.projectId, graphData: createEmptyGraph(p.projectId) as any },
      select: { id: true },
    })
    await prisma.project.update({ where: { id: p.projectId }, data: { activeGraphId: graph.id } })
  }
}, 120_000)
afterAll(() => {
  if (engineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = engineMode
})

beforeEach(() => {
  fixLoop.mockReset()
  fixLoop.mockResolvedValue({
    passed: true, rounds: 1, reason: 'passed', appliedFixes: 0, summary: 'done',
    finalCheckSnapshot: { projectId: 'p', passed: true, checksRun: 0, checksSkipped: 0, verdict: 'passed', checks: [], executedAt: '2026-01-01T00:00:00.000Z' },
  } as unknown as FixLoopResult)
})

/**
 * Tables a client can reach that have no row-level security. The end-user auth
 * table is left out: it is served through /auth/* only, never over the data
 * API, and enabling auth creates it before the first sign-up.
 */
async function withoutRls(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT LIKE '\\_%' ORDER BY 1`,
    schema,
  )
  return rows.map((r) => r.relname).filter((name) => !isAuthManagedTable(name))
}

async function build(domain: BlueprintDomain) {
  const p = projects[domain]
  await savePendingPlan(p.projectId, getBlueprint(domain), { domain, confidence: 0.9, matchedOn: 'test' }, 0)
  return { project: p, ...(await p.turn([classified('CONFIRM')], 'go ahead')) }
}

describe('every curated blueprint runs to the end', () => {
  it.each(DOMAINS)('%s: every step lands, so nothing is left for "continue"', async (domain) => {
    const { result } = await build(domain)

    expect(result.summary).not.toContain('Follow-ups pending')
    expect(result.success).toBe(true)
  }, 180_000)
})

describe('the row-level security the plans ask for applies', () => {
  it.each(['marketplace', 'chat-app', 'blog', 'social-media'] as BlueprintDomain[])('%s: no table is left without it', async (domain) => {
    const { project } = await build(domain)
    expect(await withoutRls(project.schema)).toEqual([])
  }, 180_000)

  it('project-mgmt: every org-scoped child table has it', async () => {
    const { project } = await build('project-mgmt')
    const open = await withoutRls(project.schema)
    for (const t of ['subtasks', 'assignments', 'comments', 'task_labels', 'milestones', 'time_entries', 'attachments']) {
      expect(open).not.toContain(t)
    }
  }, 180_000)

  it('order_items follows its order, the parent named by `via`, not one guessed between two', async () => {
    const { project } = await build('marketplace')
    const policies = await prisma.$queryRawUnsafe<Array<{ qual: string | null }>>(
      `SELECT qual FROM pg_policies WHERE schemaname = $1 AND tablename = 'order_items' AND cmd = 'SELECT'`,
      project.schema,
    )
    expect(policies.length).toBeGreaterThan(0)
    expect(policies.map((p) => p.qual).join(' ')).toContain('orders')
  }, 180_000)

  it('refuses a `via` that is not a foreign key, and says why', async () => {
    const { project } = await build('marketplace')
    const r = await dispatchTool(
      'add_rls',
      { tableName: 'order_items', policy: 'owned_via_parent', via: 'quantity' },
      { projectId: project.projectId, userId: project.ownerId, createdThisTurn: new Set<string>() },
    )
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('"order_items"."quantity" is not a foreign key')
  }, 180_000)
})
