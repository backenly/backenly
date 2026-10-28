/**
 * A PARKED ACTION'S SECRETS ARE REPLAYED, NEVER SERVED
 * ====================================================
 * When the executor's risk gate parks an action, the finding row that carries
 * it is SERVED: the health endpoint, the trust report, the Review Queue card
 * and `get_autonomy_status` (read-only MCP keys included) all render
 * `details`. The row used to store the action's raw params there, so a
 * SET_ENV_VAR parked with a provider key published that key to every surface
 * that could list findings, for as long as the row lived.
 *
 * The contract pinned here:
 *
 *   - the stored display copy redacts secret-named values
 *   - a sealed copy exists, and approval replay (`buildFixAction`) recovers the
 *     EXACT original params from it — parking must never lose the action
 *   - legacy rows (raw params, no sealed copy) still replay via the fallback
 *   - the health endpoint serves legacy rows redacted too, so pre-fix rows
 *     stop leaking the moment this ships
 *
 * Real database, real route handler, real crypto. The sealing key derives from
 * JWT_SECRET and refuses anything under 32 characters, so the suite sets its
 * own sealing-grade secret up front (CI's env secret is short) and restores
 * the original afterwards.
 */

import { randomBytes, randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'
import { buildFixAction } from '@/lib/core/fix-actions'
import { sealParams, unsealParams } from '@/lib/operational-memory/sealed-params'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

const savedJwtSecret = process.env.JWT_SECRET
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  // Random per run: sealing and unsealing happen inside this one process.
  process.env.JWT_SECRET = randomBytes(32).toString('hex')
}
afterAll(() => {
  if (savedJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = savedJwtSecret
})

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// Shaped like nothing real: redaction keys on the FIELD NAME, and the
// public repo's pre-commit secret scanner must not match the fixture.
const SECRET = 'fixture-supersecret-value-1234567890abcdef'

const createdUserIds: string[] = []
const createdProjectIds: string[] = []

async function fixtureProject() {
  const email = `psw-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Pending Secrets Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  const p = await prisma.project.create({
    data: { name: `psw-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return { userId: u.id, token, projectId: p.id }
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(() => {
  // The scratch database holds many projects; the owner-resolves-own-project
  // path under test is the Cloud resolver's.
  process.env.BACKENLY_EDITION = 'cloud'
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.backendEvent.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('parking an action that carries a secret', () => {
  it('stores a redacted display copy and never the raw value', async () => {
    const f = await fixtureProject()

    const finding = await queuePendingActionFinding({
      projectId: f.projectId,
      action: 'SET_ENV_VAR',
      params: { key: 'STRIPE_SECRET_KEY', value: SECRET },
      target: 'STRIPE_SECRET_KEY',
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'test parking',
    })

    const row = await prisma.healthFinding.findUnique({ where: { id: finding.id }, select: { details: true } })
    const det = row?.details as Record<string, any>

    expect(det.executorParams).toEqual({ key: 'STRIPE_SECRET_KEY', value: '[withheld]' })
    expect(typeof det.executorParamsSealed).toBe('string')
    // The raw secret appears nowhere in what a reader of this row receives.
    const served = JSON.stringify({ ...det, executorParamsSealed: undefined })
    expect(served).not.toContain(SECRET)
  })

  it('approval replay recovers the exact original params from the sealed copy', async () => {
    const f = await fixtureProject()
    const finding = await queuePendingActionFinding({
      projectId: f.projectId,
      action: 'SET_ENV_VAR',
      params: { key: 'OPENAI_API_KEY', value: SECRET },
      target: 'OPENAI_API_KEY',
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'test replay',
    })

    const row = await prisma.healthFinding.findUnique({ where: { id: finding.id }, select: { details: true } })
    const fix = buildFixAction('ai_action_pending', row?.details as Record<string, unknown>)

    expect(fix).not.toBeNull()
    expect(fix!.action).toBe('SET_ENV_VAR')
    expect(fix!.params).toEqual({ key: 'OPENAI_API_KEY', value: SECRET, confirmed: true })
  })

  it('a legacy row with raw params and no sealed copy still replays', async () => {
    const f = await fixtureProject()
    const legacy = await prisma.healthFinding.create({
      data: {
        projectId: f.projectId,
        type: 'ai_action_pending',
        severity: 'warning',
        status: 'pending_approval',
        autoFixed: false,
        details: {
          title: 'Legacy parked action',
          executorAction: 'SET_ENV_VAR',
          executorParams: { key: 'LEGACY_KEY', value: SECRET },
        } as any,
      },
      select: { id: true, details: true },
    })

    const fix = buildFixAction('ai_action_pending', legacy.details as Record<string, unknown>)

    expect(fix!.params).toEqual({ key: 'LEGACY_KEY', value: SECRET, confirmed: true })
  })

  it('the health endpoint serves even legacy rows redacted', async () => {
    const f = await fixtureProject()
    await prisma.healthFinding.create({
      data: {
        projectId: f.projectId,
        type: 'ai_action_pending',
        severity: 'warning',
        status: 'pending_approval',
        autoFixed: false,
        details: {
          title: 'Legacy parked action',
          executorAction: 'SET_ENV_VAR',
          executorParams: { key: 'LEGACY_KEY', value: SECRET },
        } as any,
      },
    })

    const { GET } = await import('@/app/api/projects/[id]/health/route')
    const headers: Record<string, string> = { authorization: `Bearer ${f.token}` }
    const res: any = await GET(
      {
        method: 'GET',
        url: `http://localhost:3000/api/projects/${f.projectId}/health`,
        nextUrl: { pathname: `/api/projects/${f.projectId}/health` },
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        cookies: { get: () => undefined },
      } as any,
      { params: Promise.resolve({ id: f.projectId }) },
    )
    const text = JSON.stringify(await res.json())

    expect(res.status).toBe(200)
    expect(text).toContain('LEGACY_KEY')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('executorParamsSealed')
  })
})

describe('sealed params', () => {
  it('round-trips, and refuses anything it cannot open', () => {
    const params = { key: 'X', value: SECRET, nested: { password: 'p@ss-123456' } }
    expect(unsealParams(sealParams(params))).toEqual(params)
    expect(unsealParams(undefined)).toBeNull()
    expect(unsealParams('v1.garbage.garbage.garbage')).toBeNull()
    expect(unsealParams('not-sealed-at-all')).toBeNull()
  })
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
})
