/**
 * No surface claims an alert that can never fire (medium finding MON-14).
 *
 * set_alert stored config under project.activeIntegrations that NOTHING
 * evaluates — no cron, no reconciler pass, no console reader — and answered
 * "✅ Alert set … Active on Monitoring tab". Its brain mapper also sent
 * `type` where the executor read `metric`, so even the broken storage path
 * was unreachable from the tool. The MCP door had already removed the
 * action (lib/mcp/domains.ts says why); the brain and executor now agree.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'

const ROOT = process.cwd()

let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `alerts-honesty-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Alerts Honesty Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'alerts-honesty', userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('MON-14: set_alert cannot claim a watchdog that never barks', () => {
  it('SET_ALERT refuses honestly and stores nothing', async () => {
    const out = await executeAction(
      { action: 'SET_ALERT', params: { metric: 'error_rate', threshold: 5 } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(false)
    expect(out.error).toBe('ALERTS_NOT_EVALUATED')
    expect(out.message).toContain('monitoring { "action": "metrics" }')
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } })
    expect(((proj?.activeIntegrations as any) ?? {})._monitoring_alerts).toBeUndefined()
  }, 60_000)

  it('the brain no longer offers the tool', () => {
    expect(BRAIN_TOOLS.some((t) => t.function.name === 'set_alert')).toBe(false)
  })

  it('prompts and capabilities stopped advertising it', () => {
    const prompts = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'prompts.ts'), 'utf8')
    expect(prompts).not.toContain('set_alert')
    const capabilities = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'capabilities.ts'), 'utf8')
    expect(capabilities).not.toContain("id: 'set_alert'")
  })

  it("the executor's old 'Active on Monitoring tab' claim is gone", () => {
    const executor = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'minimal-executor.ts'), 'utf8')
    expect(executor).not.toContain('Active on Monitoring tab')
  })
})
