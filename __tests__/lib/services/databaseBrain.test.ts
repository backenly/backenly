// Import OpenAI shim first
import 'openai/shims/node'

import { DatabaseBrain } from '@/lib/services/databaseBrain'
import { PrismaClient } from '@prisma/client'

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    databaseIssue: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(),
  }
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  }
})

// Mock HybridDatabase
jest.mock('@/lib/db/hybrid', () => ({
  HybridDatabase: {
    listSchemas: jest.fn().mockResolvedValue(['public']),
    // The project's schema is asked about directly now; absent, as listSchemas
    // above (which never held it) used to imply.
    schemaExists: jest.fn().mockResolvedValue(false),
    listTables: jest.fn().mockResolvedValue([{ name: 'users', rows: 100 }]),
    getStructure: jest.fn().mockResolvedValue([
      { name: 'id', type: 'uuid', primary: true, foreign: false },
      { name: 'email', type: 'varchar', primary: false, foreign: false },
    ]),
    getTableIndexes: jest.fn().mockResolvedValue([]),
  },
}))

// Mock MongoDB
jest.mock('@/lib/db/mongodb', () => ({
  getMongoDB: jest.fn().mockResolvedValue({
    listCollections: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    }),
    collection: jest.fn().mockReturnValue({
      indexes: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
      countDocuments: jest.fn().mockResolvedValue(0),
    }),
  }),
}))

describe('Database Brain Service', () => {
  const mockPrisma = new PrismaClient() as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('runAnalysis', () => {
    it('should run analysis and return issues', async () => {
      const result = await DatabaseBrain.runAnalysis('project-1')

      expect(Array.isArray(result)).toBe(true)
    })

    it('should handle errors gracefully', async () => {
      const { HybridDatabase } = require('@/lib/db/hybrid')
      HybridDatabase.schemaExists.mockRejectedValueOnce(new Error('Database error'))

      const result = await DatabaseBrain.runAnalysis('project-1')
      // Should return empty array on error, not throw
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('saveIssues', () => {
    it('should save issues to database', async () => {
      mockPrisma.databaseIssue.findFirst.mockResolvedValue(null)
      mockPrisma.databaseIssue.create.mockResolvedValue({
        id: 'issue-1',
        title: 'Missing Index',
        severity: 'high',
      })

      const issues = [{
        title: 'Missing Index',
        description: 'Table users missing index',
        severity: 'high' as const,
        database: 'postgresql' as const,
        category: 'missing_index' as const,
        suggestedFix: 'CREATE INDEX...',
        affectedTables: ['users'],
      }]

      await DatabaseBrain.saveIssues(issues, 'project-1')

      expect(mockPrisma.databaseIssue.create).toHaveBeenCalled()
    })
  })
})

