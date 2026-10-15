/**
 * The deploy tool tells an agent the truth about versions, targets and who
 * acted (medium findings DEP-07, DEP-08, DEP-09, DEP-10 and DEP-11).
 *
 * DEP-07: status answered with the newest deployment row by createdAt and no
 * version, so after a rollback it named the rolled-back-from version as live.
 * It now answers from listPublishedVersions, like the Deploy page's history.
 *
 * DEP-08: trigger_deploy advertised environment: production | staging; an
 * approved "staging" deploy published production. The argument is gone (and
 * force, which the approval flow overrides anyway), and the executor refuses
 * a non-production environment from any direct caller.
 *
 * DEP-09: a published update was reported as "already live", so the agent
 * said nothing was published; a real no-op said the same. The three outcomes
 * now read differently, and the console section is named Deploy. The first
 * publish also records its catalog hash now, so an identical publish right
 * after going live is a no-op rather than a second version.
 *
 * DEP-10: the docs promised a plan-time schema check and a custom-domain
 * setting that do not exist.
 *
 * DEP-11: an approved deploy or rollback was audited as the project owner
 * acting from chat. The actor and how the call was authorised are recorded.
 */
// The readiness gate's behavioural RLS check can never pass on a test
// database: the connection is a superuser (local and CI), and superusers
// bypass row-level security, which production's app role cannot. That check
// is covered by its own suites. Here the gate reports ready; everything
// after it (the publish, version rows, catalog hash and audit rows) is real.
jest.mock('@/lib/deployment/readiness-scorer', () => ({
  ...jest.requireActual('@/lib/deployment/readiness-scorer'),
  scoreReadiness: async () => ({ ready: true, score: 100, blockers: [], warnings: [], autoFixed: [], checks: [] }),
}))

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { BRAIN_TOOLS, TOOL_TO_ACTION, dispatchTool } from '@/lib/ai/brain/tools'


const ROOT = process.cwd()

let ownerId: string
let approverId: string
const projectIds: string[] = []

const act = (projectId: string, action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

async function user(tag: string): Promise<string> {
  return (
    await prisma.user.create({
      data: { email: `deploy-truth-${tag}-${crypto.randomBytes(5).toString('hex')}@example.test`, password: 'not-a-real-hash', name: tag },
      select: { id: true },
    })
  ).id
}

async function freshProject(name: string): Promise<string> {
  const id = (
    await prisma.project.create({
      data: { name, userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })
  ).id
  projectIds.push(id)
  return id
}

/** Published versions the way go-live writes them, with a graph per version. */
async function seedVersions(projectId: string, versions: number[], activeVersion: number): Promise<void> {
  const graphIds: Record<number, string> = {}
  for (const v of versions) {
    graphIds[v] = (
      await prisma.backendGraph.create({
        data: { projectId, graphData: { version: v }, sequenceNumber: 1000 + v },
        select: { id: true },
      })
    ).id
    await prisma.deployment.create({
      data: {
        projectId, provider: 'backenly-managed', environment: 'live', status: 'live', version: v,
        graphSnapshotId: graphIds[v], url: `https://api.example.test/${projectId}/v${v}`, changeSummary: `v${v}`,
      },
    })
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { activeGraphId: graphIds[activeVersion], projectStatus: 'LIVE', isDeployed: true } as any,
  })
}

beforeAll(async () => {
  ownerId = await user('owner')
  approverId = await user('approver')
}, 60_000)

afterAll(async () => {
  for (const id of projectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.auditLog.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.deployment.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.updateMany({ where: { id: { in: projectIds } }, data: { activeGraphId: null } as any }).catch(() => {})
  await prisma.backendGraph.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, approverId] } } }).catch(() => {})
}, 120_000)

describe('DEP-07: status names the version that is current', () => {
  it('after a rollback to v1, status reports v1 current and v2 as the latest published', async () => {
    const projectId = await freshProject('deploy-status-rollback')
    await seedVersions(projectId, [1, 2], 1)
    const out = await act(projectId, 'GET_DEPLOY_STATUS', {})
    expect(out.success).toBe(true)
    expect(out.data).toMatchObject({ version: 1, latestVersion: 2, isLatest: false, status: 'live' })
    expect((out.data as any).publicUrl).toContain('/v1')
    expect(out.message).toContain('v1 is the current version')
    expect(out.message).toContain('the latest published is v2')
  }, 60_000)

  it('with nothing published, status says so instead of naming a version', async () => {
    const projectId = await freshProject('deploy-status-none')
    const out = await act(projectId, 'GET_DEPLOY_STATUS', {})
    expect(out.data).toMatchObject({ status: 'not_deployed', version: null })
  }, 60_000)
})

describe('DEP-08: deploy has one target', () => {
  it('the tools no longer offer environment or force, and the mapper drops them', () => {
    const props = (tool: string) =>
      Object.keys((BRAIN_TOOLS.find((t) => t.function.name === tool)?.function.parameters as any)?.properties ?? {})
    expect(props('trigger_deploy')).toEqual([])
    expect(props('rollback_deploy').sort()).toEqual(['deploymentId', 'version'])
    expect(TOOL_TO_ACTION.trigger_deploy({ environment: 'staging', force: true }).params).toEqual({})
  })

  it('a direct caller asking for staging is refused and nothing is published', async () => {
    const projectId = await freshProject('deploy-staging')
    const out = await act(projectId, 'TRIGGER_DEPLOY', { environment: 'staging', confirmed: true })
    expect(out.success).toBe(false)
    expect(out.error).toBe('ENVIRONMENT_NOT_SUPPORTED')
    expect(await prisma.deployment.count({ where: { projectId } })).toBe(0)
  }, 60_000)
})

describe('DEP-09 / DEP-11: an approved deploy says what happened and who did it', () => {
  let projectId: string

  beforeAll(async () => {
    projectId = await freshProject('deploy-publish')
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
    const created = await act(projectId, 'CREATE_TABLE', {
      tableName: 'notes',
      columns: [{ name: 'body', type: 'text' }],
    })
    expect(created.success).toBe(true)
    // jest.setup.js runs ENGINE_MODE=integration, where the executor keeps the
    // graph in memory; go-live needs the project's real active graph row.
    const graph = await prisma.backendGraph.create({
      data: { projectId, graphData: { tables: { notes: {} } }, sequenceNumber: 1 },
      select: { id: true },
    })
    await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: graph.id } })
  }, 120_000)

  // What lib/mcp/approvals.ts runs once a person approves: the exact call,
  // dispatched with that person as ctx.userId and destructiveConfirmed.
  const approvedDeploy = () =>
    dispatchTool('trigger_deploy', {}, {
      projectId, userId: approverId, sessionToken: undefined,
      destructiveConfirmed: true, createdThisTurn: new Set<string>(),
    } as any)

  it('the first publish says v1 is live, recorded as the approver acting by approval', async () => {
    const out = await approvedDeploy()
    // A refusal fails with its own reason.
    if (!out.ok) throw new Error(`deploy refused: ${out.summary}`)
    expect(out.summary).toContain('Published v1')
    expect(out.summary).toContain('**Deploy** section')
    expect(out.summary).not.toContain('**Publish** section')
    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'GO_LIVE' } })
    expect(audit?.userId).toBe(approverId)
    expect(JSON.parse(String(audit?.details)).triggerSource).toBe('APPROVAL')
  }, 120_000)

  it('an unchanged catalog is a truthful no-op, not "already live"', async () => {
    const out = await approvedDeploy()
    // A refusal fails with its own reason.
    if (!out.ok) throw new Error(`deploy refused: ${out.summary}`)
    expect(out.summary).toContain('Nothing new to publish')
    expect(out.summary).not.toContain('already live')
    expect(await prisma.deployment.count({ where: { projectId, version: { not: null } } })).toBe(1)
  }, 120_000)

  it('a changed catalog publishes v2 and says "Published v2"', async () => {
    await act(projectId, 'ADD_COLUMN', { tableName: 'notes', columnName: 'title', columnType: 'text' })
    const out = await approvedDeploy()
    // A refusal fails with its own reason.
    if (!out.ok) throw new Error(`deploy refused: ${out.summary}`)
    expect(out.summary).toContain('Published v2')
    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'PUBLISH_UPDATE' } })
    expect(audit?.userId).toBe(approverId)
    expect(JSON.parse(String(audit?.details)).triggerSource).toBe('APPROVAL')
  }, 120_000)
})

describe('DEP-10: the deploy docs describe the real gate', () => {
  it('no plan-time schema check, no dashboard custom-domain setting', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'deploy.md'), 'utf8')
    expect(doc).not.toContain('refused at plan time')
    expect(doc).not.toContain('Custom domains are set in the dashboard')
    expect(doc).toContain('readiness gate')
  })
})
