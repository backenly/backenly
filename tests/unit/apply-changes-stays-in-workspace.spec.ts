/**
 * A change plan's file targets stay inside the project's workspace.
 *
 * POST /api/ai-workspace/apply-changes takes the whole plan from the request,
 * and lib/services/aiWorkspace.ts applyChangesFromPlan built each file target
 * with path.join: a `..` segment wrote into another project's workspace on the
 * shared volume, and a `config` change wrote under the server's own working
 * directory at whatever path the plan named. A target is now written only when
 * it resolves inside the caller's project workspace, and a config change is
 * refused. Real files in a temporary WORKSPACE_DIR, no mocked file system.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'

// The database is not mocked (the file branches under test never reach it); only the model client is, so the
// suite does not depend on an AI provider's SDK.
jest.mock('@/lib/ai/llm/chat', () => ({ chat: jest.fn() }))

import { applyChangesFromPlan, type BackendChangePlan } from '@/lib/services/aiWorkspace'

const plan = (changes: BackendChangePlan['changes']): BackendChangePlan => ({
  id: 'plan', description: 'test', changes, estimatedTime: '1 minute', riskLevel: 'low', createdAt: new Date(),
})

let root: string
const previous = process.env.WORKSPACE_DIR
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-apply-'))
  process.env.WORKSPACE_DIR = root
  fs.mkdirSync(path.join(root, 'victim'), { recursive: true })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = previous
})

describe('applyChangesFromPlan file targets', () => {
  // [target, where the old code wrote it, relative to the workspace root]
  it.each([
    ['../victim/prisma/schema.prisma', 'victim/prisma/schema.prisma'],
    ['a/../../victim/x.ts', 'victim/x.ts'],
    ['/lib/../../victim/lib/x', 'victim/lib/x.ts'],
    ['utils/../../victim/escape.ts', 'victim/escape.ts'],
    ['config/../../victim/settings.json', 'victim/settings.json'],
  ])('refuses %s, which is in another project workspace', async (target, landed) => {
    const result = await applyChangesFromPlan(
      plan([{ type: 'file', action: 'create', target, code: 'PLANTED', description: 'x' }]), [0], 'attacker')

    expect(result.applied).toEqual([])
    expect(result.errors.map((e) => e.error)).toEqual(["That target is not inside this project's workspace."])
    expect(fs.existsSync(path.join(root, landed))).toBe(false)
    expect(fs.readdirSync(path.join(root, 'victim'))).toEqual([])
  })

  it.each([
    ['lib/util.ts', 'attacker/lib/util.ts'],
    ['/api/products', 'attacker/routes/products.ts'],
    ['src/app.ts', 'attacker/src/app.ts'],
  ])('writes %s inside the project workspace', async (target, landed) => {
    const result = await applyChangesFromPlan(
      plan([{ type: 'file', action: 'create', target, code: 'export {}\n', description: 'x' }]), [0], 'attacker')

    expect(result.errors).toEqual([])
    expect(result.applied).toEqual([target])
    expect(fs.readFileSync(path.join(root, landed), 'utf8')).toBe('export {}\n')
  })

  it('refuses a config change, which wrote under the server working directory', async () => {
    const target = `planted-config-${randomUUID()}.json`
    const result = await applyChangesFromPlan(
      plan([{ type: 'config', action: 'create', target, code: '{"planted":true}', description: 'x' }]), [0], 'attacker')

    expect(result.applied).toEqual([])
    expect(result.errors.map((e) => e.error)).toEqual(['Config changes are not applied from a plan.'])
    expect(fs.existsSync(path.join(process.cwd(), target))).toBe(false)
  })
})
