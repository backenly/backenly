/**
 * Realtime scope is explicit, and the approval card names the blast radius
 * (medium findings RT-05, RT-07, RT-08).
 *
 * RT-05: `realtime { action: "enable" }` with no tableName fell through to
 * the install-on-every-table branch, so a forgotten argument silently
 * started streaming the whole project. Enabling is per table now, with the
 * every-table branch reachable only by saying `allTables: true`. The agent's
 * tool forwards only tableName, so the agent door cannot reach the
 * every-table branch at all; the executor's TABLE_NAME_REQUIRED refusal is
 * the guard.
 *
 * RT-07: a project-wide disable parked as the bare words "Realtime:
 * disable" — the human approved a blast radius the card never named. Both
 * park paths now resolve the streaming tables at park time.
 *
 * RT-08: the empty-project status claimed NOTIFY triggers are installed
 * automatically as tables are built, which the typed path no longer does.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { listTablesWithRealtimeTriggers } from '@/lib/services/realtimeTriggers'

const ROOT = process.cwd()

let ownerId: string
let projectId: string

const act = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `rt-scope-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Realtime Scope Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'realtime-scope', userId: ownerId },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  for (const t of ['posts', 'comments']) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "workspace_${projectId}"."${t}" (id serial PRIMARY KEY, body text)`,
    )
  }
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('RT-05: enabling is per table, every-table only by name', () => {
  it('ENABLE_REALTIME without a tableName refuses and installs nothing', async () => {
    const out = await act('ENABLE_REALTIME', {})
    expect(out.success).toBe(false)
    expect(out.error).toBe('TABLE_NAME_REQUIRED')
    expect(out.message).toContain('"tableName"')
    // The agent's tool forwards only tableName, so the refusal must not offer allTables.
    expect(out.message).not.toContain('allTables')
    await expect(listTablesWithRealtimeTriggers(projectId)).resolves.toEqual([])
  }, 60_000)

  it('one table enables one table', async () => {
    const out = await act('ENABLE_REALTIME', { tableName: 'posts' })
    expect(out.success).toBe(true)
    await expect(listTablesWithRealtimeTriggers(projectId)).resolves.toEqual(['posts'])
  }, 60_000)

  it('the agent door cannot stream the whole project, even when asked to', async () => {
    const out = await dispatchTool('enable_realtime', { allTables: true }, { projectId, userId: ownerId } as any)
    expect(out.ok).toBe(false)
    expect(out.summary).toContain('tableName')
    await expect(listTablesWithRealtimeTriggers(projectId)).resolves.toEqual(['posts'])
  }, 60_000)

  it('allTables: true is the explicit project-wide switch for internal callers', async () => {
    const out = await act('ENABLE_REALTIME', { allTables: true })
    expect(out.success).toBe(true)
    const streaming = await listTablesWithRealtimeTriggers(projectId)
    expect(streaming.sort()).toEqual(['comments', 'posts'])
  }, 60_000)
})

describe('RT-07 / RT-08: the words match the blast radius', () => {
  it('both park paths resolve a project-wide disable to the streaming tables', () => {
    const agent = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'agent.ts'), 'utf8')
    expect(agent).toContain('EVERY streaming table')
    expect(agent).toContain('listTablesWithRealtimeTriggers')
    const door = fs.readFileSync(path.join(ROOT, 'app', 'api', 'mcp', 'tool', 'route.ts'), 'utf8')
    expect(door).toContain('describeRealtimeDisableScope')
    expect(door).toContain('EVERY streaming table stops')
  })

  it('the empty-project status says realtime is opt-in per table', async () => {
    const fresh = await prisma.project.create({
      data: { name: 'realtime-empty', userId: ownerId },
      select: { id: true },
    })
    try {
      const out = await executeAction(
        { action: 'GET_REALTIME_STATUS', params: {} } as any,
        fresh.id, undefined, 0, undefined, false,
      )
      expect(out.success).toBe(true)
      expect(out.message).toContain('opt-in per table')
      expect(out.message).not.toContain('installed automatically')
    } finally {
      await prisma.project.delete({ where: { id: fresh.id } }).catch(() => {})
    }
  }, 60_000)
})
