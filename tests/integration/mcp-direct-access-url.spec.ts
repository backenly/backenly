import { dispatchTool } from '@/lib/ai/brain/tools'
import { prisma } from '@/lib/db/prisma'

describe('direct database access deployment URL', () => {
  let projectId: string

  beforeAll(async () => {
    const project = await prisma.project.create({ data: { name: 'Direct access URL test' } })
    projectId = project.id
  })

  afterAll(async () => {
    if (projectId) await prisma.project.delete({ where: { id: projectId } })
  })

  afterEach(() => jest.restoreAllMocks())

  it.each([
    ['configured origin', 'https://backend.example.test/', '', 'https://backend.example.test'],
    ['alternate URL', '', 'https://alternate.example.test/', 'https://alternate.example.test'],
    ['bind-all address', 'http://0.0.0.0:3100', 'https://alternate.example.test/', 'https://alternate.example.test'],
  ])('links to this deployment for %s without arming write access', async (_label, appUrl, alternateUrl, origin) => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NEXT_PUBLIC_APP_URL: appUrl,
      NEXT_PUBLIC_URL: alternateUrl,
    })
    const res = await dispatchTool('get_database_credentials', { mode: 'READ_WRITE' }, { projectId })
    const armUrl = `${origin}/app/projects/${projectId}/connect?tab=direct`

    expect(res.ok).toBe(false)
    expect(res.code).toBe('WRITE_ACCESS_NOT_ARMED')
    expect(res.data).toMatchObject({
      readOnlyProvisioned: false,
      readWriteArmed: false,
      armReadWriteUrl: armUrl,
    })
    expect(res.summary).toContain(armUrl)
  })
})
