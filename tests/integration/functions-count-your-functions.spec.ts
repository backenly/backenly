/**
 * THE FUNCTION COUNT IS THE PROJECT'S OWN FUNCTIONS
 * =================================================
 * Production QA (2026-11-09): the Overview said "Functions 9" for a project
 * with two functions an agent made. The other seven were endpoints Backenly
 * generates with every table (a validation schema each), counted as functions,
 * and the Functions page told them apart only by a guess at their names.
 *
 * Against a real database, through the executor and the real routes:
 *   - the Overview's Functions count is the project's own functions;
 *   - the Functions list marks each endpoint Backenly generated for a table,
 *     and only those: not code an agent deployed, not an endpoint an agent asked
 *     Backenly to write, though both are stored with the same trigger and the
 *     same shape of route;
 *   - the agent's picture of the backend lists the generated ones apart.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
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

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { executeAction } from '@/lib/ai/minimal-executor'
import { GET as stateGET } from '@/app/api/projects/[id]/state/route'
import { GET as functionsGET } from '@/app/api/projects/[id]/ai-functions/route'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
let token: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const request = (path: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: `auth-token=${token}` } })
const params = () => ({ params: Promise.resolve({ id: projectId }) })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  const email = `fn-count-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  // A signed-in session, as login makes one.
  token = (await createSession(ownerId, email)).token
  const project = await createProvisionedProject({ name: 'functions-count-your-functions', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  // A table: Backenly generates its endpoints in the same change.
  const created: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    executeAction({ action: 'CREATE_TABLE', params: { tableName: 'orders', columns: [{ name: 'total', type: 'numeric' }] } } as any, projectId, undefined, 0, undefined, false))
  expect(created.success).toBe(true)

  // Two functions of the project's own, stored as their paths store them.
  const route = (name: string) => `POST /api/v1/${projectId}/fn/${name}`
  await prisma.aiFunction.createMany({
    data: [
      // deploy_code: the agent's code, verbatim.
      { projectId, name: 'send-receipt', description: 'Email a receipt', generatedCode: 'export async function POST() {}', codeOrigin: 'agent', triggerType: 'manual', triggerTable: route('send-receipt') },
      // GENERATE_FUNCTION: an endpoint the agent asked Backenly to write.
      { projectId, name: 'order-totals', description: 'Total an order with tax', generatedCode: 'export async function POST() {}', triggerType: 'manual', triggerTable: route('order-totals') },
    ],
  })
}, 120_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

it('the table generated endpoints of its own', async () => {
  const names = (await prisma.aiFunction.findMany({ where: { projectId }, select: { name: true } })).map((f) => f.name)
  expect(names).toContain('orders-schema')
})

it("the Overview counts the project's own functions", async () => {
  const res = await stateGET(request(`/api/projects/${projectId}/state`), params())
  expect(res.status).toBe(200)
  const body = await res.json()
  const functions = body.capabilities.find((c: { name: string }) => c.name === 'Functions')
  expect(functions?.count).toBe(2)
})

it('the Functions list marks what Backenly generated for a table, and only that', async () => {
  const res = await functionsGET(request(`/api/projects/${projectId}/ai-functions`), params())
  expect(res.status).toBe(200)
  const { functions } = await res.json()
  const generated = Object.fromEntries(functions.map((f: { name: string; generated: boolean }) => [f.name, f.generated]))
  expect(generated['orders-schema']).toBe(true)
  expect(generated['send-receipt']).toBe(false)
  expect(generated['order-totals']).toBe(false)
})

it("the agent's picture of the backend lists the generated endpoints apart", async () => {
  const info: any = await executeAction({ action: 'INFO', params: {} } as any, projectId)
  expect(info.message).toContain('### AI Functions (2 active)')
  expect(info.message).toMatch(/### Generated for your tables \(\d+\)\n[^\n]*`orders-schema`/)
})
