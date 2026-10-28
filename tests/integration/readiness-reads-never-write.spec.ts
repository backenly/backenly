/**
 * Reading readiness changes nothing (medium finding DEP-06).
 *
 * The Deploy page loaded its readiness card with POST /readiness, which runs
 * the auto-fixes, so merely opening the page could enable RLS with an owner
 * policy on a table an agent had left open on purpose, generate a secret, set
 * the auth flag and switch functions off, with no click and no record. Two of
 * the scorer's checks also wrote even when fixing was off (the auth flag and
 * placeholder deactivation), so GET /readiness and the MCP readiness read
 * wrote too; and the brain's get_readiness defaulted to fixing.
 *
 * Now a read changes nothing on every path, the would-be fixes are reported
 * as auto-fixable items, and fixing is an explicit act: the Deploy page's
 * "Apply safe fixes", POST /readiness, autoFix: true, or the deploy itself.
 *
 * The auth flag is not written at all any more, fixing or not: the auth check
 * reads whether auth is on the way every other surface does
 * (isEndUserAuthEnabled), so there is no flag left for it to set.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
let placeholderFnId: string

async function state() {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { authManifest: true } })
  const fn = await prisma.aiFunction.findUnique({ where: { id: placeholderFnId }, select: { status: true } })
  return { authEnabled: (project?.authManifest as any)?.enabled === true, fnStatus: fn?.status }
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `readiness-read-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Readiness Read Suite',
      },
      select: { id: true },
    })
  ).id
  // A JWT secret and a users table, but the auth flag never written: what an
  // OAuth connect whose build skipped the manifest leaves behind.
  projectId = (
    await prisma.project.create({
      data: {
        name: 'readiness-read', userId: ownerId,
        jwtSecret: crypto.randomBytes(32).toString('hex'), authManifest: { providers: {} },
      },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."users" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL)`,
  )
  // A placeholder function that acquired a live trigger.
  placeholderFnId = (
    await prisma.aiFunction.create({
      data: {
        projectId, name: 'my_function', description: 'placeholder', generatedCode: 'return null',
        triggerType: 'on_db_insert', status: 'active',
      },
      select: { id: true },
    })
  ).id
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('DEP-06: a readiness read changes nothing', () => {
  it('scoreReadiness without autoFix leaves the function alone, and reports its fix', async () => {
    const report = await scoreReadiness(projectId)
    expect(await state()).toEqual({ authEnabled: false, fnStatus: 'active' })
    expect(report.autoFixed).toEqual([])
    // No provider is on, so auth is off as every surface reads it: nothing to fix.
    const auth = report.checks.find((c) => c.id === 'end_user_auth_table')!
    expect(auth).toMatchObject({ status: 'skip', fixApplied: false })
    const fns = report.checks.find((c) => c.id === 'function_triggers')!
    expect(fns.fixApplied).toBe(false)
    expect(fns.details.join('\n')).toContain('Applying safe fixes deactivates 1 placeholder function')
  }, 120_000)

  it('the agent readiness read is a read by default, on the executor and through the brain tool', async () => {
    expect(TOOL_TO_ACTION.get_readiness({}).params).toEqual({ autoFix: false })
    const out = await executeAction({ action: 'GET_READINESS', params: {} } as any, projectId, undefined, 0, undefined, false)
    expect(out.success).toBe(true)
    expect(await state()).toEqual({ authEnabled: false, fnStatus: 'active' })
  }, 120_000)

  it('fixing, asked for explicitly, still applies the function fix and writes no auth flag (control)', async () => {
    const report = await scoreReadiness(projectId, { autoFix: true })
    expect(await state()).toEqual({ authEnabled: false, fnStatus: 'inactive' })
    expect(report.autoFixed.map((c) => c.id)).toEqual(expect.arrayContaining(['function_triggers']))
    expect(report.autoFixed.map((c) => c.id)).not.toContain('end_user_auth_table')
  }, 120_000)

  it('the Deploy page reads on load and fixes only on an explicit action', () => {
    const page = fs.readFileSync(path.join(ROOT, 'app', 'app', 'projects', '[id]', 'deploy', 'page.tsx'), 'utf8')
    const load = page.slice(page.indexOf('const fetchAll'), page.indexOf('useEffect(() => { fetchAll() }'))
    expect(load).toContain('/readiness`')
    expect(load).not.toContain("method: 'POST'")
    expect(page).toContain('Apply safe fixes')
    expect(page).toContain("const applySafeFixes")
  })
})
