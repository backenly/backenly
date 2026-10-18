
import crypto from 'crypto'
import { prisma } from '../../lib/db'
import {
  saveResumeQueue,
  loadResumeQueue,
  clearResumeQueue,
} from '../../lib/ai/blueprints/store'

describe('resume queue progress', () => {
  let projectId: string
  let ownerId: string

  beforeAll(async () => {
    ownerId = (
      await prisma.user.create({
        data: {
          email: `resume-test-${crypto.randomBytes(6).toString('hex')}@example.test`,
          password: 'not-a-real-hash',
          name: 'resume-test',
        },
      })
    ).id

    projectId = (
      await prisma.project.create({
        data: {
          name: 'resume-store-test',
          userId: ownerId,
        },
      })
    ).id
  })

  afterAll(async () => {
    if (projectId) {
      await clearResumeQueue(projectId)
      await prisma.project.delete({ where: { id: projectId } })
    }

    if (ownerId) {
      await prisma.user.delete({ where: { id: ownerId } })
    }

    await prisma.$disconnect()
  })

  it('saves the original request and progress with the resume queue', async () => {
    const originalRequest = 'Create four tables and their APIs'
    const completedProgress =
      'Created users and products tables successfully'

    const remainingSteps = [
      {
        tool: 'create_table',
        args: { tableName: 'orders' },
      },
    ]

    await saveResumeQueue(
      projectId,
      'custom',
      remainingSteps as any,
      completedProgress,
      originalRequest,
    )

    const saved = await loadResumeQueue(projectId)

    expect(saved).not.toBeNull()
    expect(saved?.originalRequest).toBe(originalRequest)
    expect(saved?.reason).toBe(completedProgress)
    expect(saved?.steps).toHaveLength(1)
    expect(saved?.steps[0]).toMatchObject({
      tool: 'create_table',
      args: { tableName: 'orders' },
    })
  })
})
