/**
 * Readiness counts the problems Backenly found, and says where magic links go.
 *
 * Production QA (2026-11-09, report 86): the Deploy page said "11 of 11
 * passing" with anonymous uploads open, reset links pointing at JSON, an
 * unrequested UNIQUE(email) blocking orders and an email function with no
 * provider. Readiness never read the self-healing loop's findings. Now an open
 * critical finding blocks and a warning warns, each named as the Autonomy page
 * names it; and with end-user auth on, magic links on and no App URL, a warning
 * says magic links can't sign anyone in.
 *
 * Real database: the project, its findings and its auth settings.
 */
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
import { summariseFinding } from '@/lib/core/finding-summaries'

let ownerId: string
let projectId: string

const check = async (id: string) => {
  const report = await scoreReadiness(projectId, { autoFix: false })
  return { report, check: report.checks.find((c) => c.id === id)! }
}
const finding = (data: { type: string; severity: string; status?: string; details?: Record<string, unknown> }) =>
  prisma.healthFinding.create({
    data: { projectId, type: data.type, severity: data.severity, status: data.status ?? 'open', details: (data.details ?? {}) as object },
  })

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `readiness-open-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Readiness' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'readiness-open', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex'), authManifest: { enabled: true } },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
}, 60_000)

beforeEach(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.projectAuthConfig.deleteMany({ where: { projectId } })
})

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('open problems', () => {
  it('blocks publishing on an open critical problem, and names it', async () => {
    const details = { tableName: 'product_photos', reason: 'Anyone with the public key can upload files to product_photos' }
    await finding({ type: 'storage_open_uploads', severity: 'critical', details })

    const { report, check: c } = await check('open_findings')

    expect(c).toMatchObject({ status: 'fail', severity: 'blocking' })
    expect(c.message).toContain(summariseFinding('storage_open_uploads', details))
    expect(c.message).toContain('Fix or dismiss them on the Autonomy page.')
    expect(report.ready).toBe(false)
    expect(report.blockers.map((b) => b.id)).toContain('open_findings')
  })

  it('warns, without blocking, on an open warning: a function that needs a missing integration', async () => {
    const details = { functionId: 'f1', functionName: 'shipping_email', trigger: 'on_db_update', tableName: 'orders', missing: ['email'] }
    await finding({ type: 'function_integration_missing', severity: 'warning', details })

    const { report, check: c } = await check('open_findings')

    expect(c).toMatchObject({ status: 'fail', severity: 'warning' })
    expect(c.message).toContain(summariseFinding('function_integration_missing', details))
    expect(report.blockers.map((b) => b.id)).not.toContain('open_findings')
    expect(report.warnings.map((w) => w.id)).toContain('open_findings')
  })

  it('counts neither an architecture change waiting on a person, a closed finding, nor a note', async () => {
    await finding({ type: 'architecture_evolution', severity: 'critical', status: 'pending_approval' })
    await finding({ type: 'missing_rls', severity: 'critical', status: 'dismissed' })
    await finding({ type: 'missing_rls', severity: 'critical', status: 'fixed' })
    await finding({ type: 'hot_table', severity: 'info' })

    const { check: c } = await check('open_findings')

    expect(c).toMatchObject({ status: 'pass', message: 'No problems are open' })
  })
})

describe('links in auth emails', () => {
  it('warns while magic links are on and no App URL is set', async () => {
    const { check: c } = await check('email_links')
    expect(c).toMatchObject({ status: 'fail', severity: 'warning' })
    expect(c.message).toBe('No App URL is set, so magic links can’t sign anyone in. Set the App URL under Auth → Email, or turn magic links off.')
  })

  it('passes once the App URL is set, or magic links are off', async () => {
    await prisma.projectAuthConfig.create({ data: { projectId, appUrl: 'https://shop.example.com' } })
    expect((await check('email_links')).check).toMatchObject({ status: 'pass', message: 'Reset and magic links open https://shop.example.com' })

    await prisma.projectAuthConfig.update({ where: { projectId }, data: { appUrl: null, magicLinksEnabled: false } })
    expect((await check('email_links')).check).toMatchObject({ status: 'pass' })
  })
})
