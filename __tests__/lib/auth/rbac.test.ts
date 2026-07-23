import { hasPermission, hasAnyPermission, canAccessProject, Permissions } from '@/lib/auth/rbac'
import { PrismaClient } from '@prisma/client'

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
    },
  }
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  }
})

describe('RBAC', () => {
  const mockPrisma = new PrismaClient() as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('hasPermission', () => {
    it('should return true for admin users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.ADMIN],
        },
      })

      const result = await hasPermission('user-1', Permissions.PROJECT_READ)
      expect(result).toBe(true)
    })

    it('should return true if user has the specific permission', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.PROJECT_READ],
        },
      })

      const result = await hasPermission('user-1', Permissions.PROJECT_READ)
      expect(result).toBe(true)
    })

    it('should return false if user does not have the permission', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.PROJECT_READ],
        },
      })

      const result = await hasPermission('user-1', Permissions.PROJECT_DELETE)
      expect(result).toBe(false)
    })

    it('should return false if user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      const result = await hasPermission('user-1', Permissions.PROJECT_READ)
      expect(result).toBe(false)
    })
  })

  describe('hasAnyPermission', () => {
    it('should return true if user has any of the permissions', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.PROJECT_READ],
        },
      })

      const result = await hasAnyPermission('user-1', [
        Permissions.PROJECT_READ,
        Permissions.PROJECT_WRITE,
      ])
      expect(result).toBe(true)
    })

    it('should return false if user has none of the permissions', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.PROJECT_READ],
        },
      })

      const result = await hasAnyPermission('user-1', [
        Permissions.PROJECT_DELETE,
        Permissions.USER_DELETE,
      ])
      expect(result).toBe(false)
    })
  })

  describe('canAccessProject', () => {
    it('should return true if user has PROJECT_READ permission', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [Permissions.PROJECT_READ],
        },
      })

      const result = await canAccessProject('user-1', 'project-1')
      expect(result).toBe(true)
    })

    it('should return true if user owns the project', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [],
        },
      })

      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'project-1',
        userId: 'user-1',
      })

      const result = await canAccessProject('user-1', 'project-1')
      expect(result).toBe(true)
    })

    it('should return false if user cannot access the project', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: {
          permissions: [],
        },
      })

      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'project-1',
        userId: 'user-2',
      })

      const result = await canAccessProject('user-1', 'project-1')
      expect(result).toBe(false)
    })
  })
})

