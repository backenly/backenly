import { trackApiKeyUsage, getApiKeyUsageStats } from '@/lib/services/apiKeyUsage'
import { PrismaClient } from '@prisma/client'

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    apiKeyUsage: {
      create: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  }
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  }
})

describe('API Key Usage Service', () => {
  const mockPrisma = new PrismaClient() as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('trackApiKeyUsage', () => {
    it('should track API key usage', async () => {
      mockPrisma.apiKeyUsage.create.mockResolvedValue({
        id: 'usage-1',
        apiKeyId: 'key-1',
        endpoint: '/api/users',
        method: 'GET',
        statusCode: 200,
      })

      await trackApiKeyUsage('key-1', '/api/users', 'GET', 200, 50)

      expect(mockPrisma.apiKeyUsage.create).toHaveBeenCalled()
    })
  })

  describe('getApiKeyUsageStats', () => {
    it('should return usage statistics', async () => {
      const now = new Date()
      mockPrisma.apiKeyUsage.findMany.mockResolvedValue([
        { 
          endpoint: '/api/users', 
          method: 'GET',
          statusCode: 200,
          responseTime: 50,
          timestamp: now 
        },
        { 
          endpoint: '/api/projects', 
          method: 'GET',
          statusCode: 200,
          responseTime: 100,
          timestamp: now 
        },
      ])

      const stats = await getApiKeyUsageStats('key-1')

      expect(stats.totalRequests).toBe(2)
      expect(stats.averageResponseTime).toBe(75)
      expect(stats.requestsByEndpoint).toBeDefined()
      expect(stats.requestsByEndpoint['/api/users']).toBe(1)
      expect(stats.requestsByEndpoint['/api/projects']).toBe(1)
    })
  })
})

