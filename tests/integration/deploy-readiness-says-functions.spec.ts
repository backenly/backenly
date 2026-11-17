/**
 * DEPLOY READINESS AND A BUILD'S CHECKS CALL FUNCTIONS FUNCTIONS
 * ==============================================================
 *
 * Production QA re-test, 2026-11-16, #47 (partly fixed by #696): Deploy
 * readiness still said "AI function trigger configuration … All 7 AI
 * functions" about code agents wrote and deployed as written. The check keeps
 * its id (function_triggers), which clients read; only its words change. A
 * build's own check of its functions is pinned beside it.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
import { verifyNode } from '@/lib/ai/build-runtime/verifier'
import { BuildGraph } from '@/lib/ai/build-runtime/build-graph'
import { ecommercePhases } from '@/lib/ai/build-runtime/domain-phases'

let ownerId = ''
const projects: string[] = []

async function project(functions: number): Promise<string> {
  const id = (
    await prisma.project.create({
      data: { name: 'readiness-words', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })
  ).id
  projects.push(id)
  for (let i = 0; i < functions; i++) {
    await prisma.aiFunction.create({
      data: {
        projectId: id,
        name: `send-receipt-${i}`,
        description: 'Emails a receipt when an order is paid',
        generatedCode: 'return null',
        triggerType: 'manual',
        status: 'active',
      },
    })
  }
  return id
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `readiness-words-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'Readiness words' },
      select: { id: true },
    })
  ).id
}, 60_000)

afterAll(async () => {
  await prisma.aiFunction.deleteMany({ where: { projectId: { in: projects } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projects } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

it('names the trigger check and counts functions as functions', async () => {
  const report = await scoreReadiness(await project(2))
  const check = report.checks.find((c) => c.id === 'function_triggers')!
  expect(check).toMatchObject({
    name: 'Function trigger configuration',
    status: 'pass',
    message: 'All 2 functions have correct trigger configuration',
  })
}, 120_000)

it('says so when there are none', async () => {
  const report = await scoreReadiness(await project(0))
  expect(report.checks.find((c) => c.id === 'function_triggers')).toMatchObject({ status: 'skip', message: 'No functions defined' })
}, 120_000)

it("a build's check of its functions says functions", async () => {
  const id = await project(1)
  const phases = ecommercePhases()
  const graph = new BuildGraph(phases)
  const node = graph.getAllNodes().find((n) => n.id === 'verification.functions')!
  const report = await verifyNode(node, { id: 'job', projectId: id, userId: ownerId, originalPrompt: 'a store', domain: 'ecommerce', status: 'pending', phases, createdAt: '', updatedAt: '' }, graph, id)
  expect(report.checks).toContainEqual({ label: 'Functions created', status: 'pass', detail: '1 function deployed' })
}, 60_000)
