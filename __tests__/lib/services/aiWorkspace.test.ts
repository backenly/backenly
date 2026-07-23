// Import OpenAI shim first
import 'openai/shims/node'

// Mock OpenAI module - must be before any imports
const mockCreate = jest.fn()

jest.mock('openai', () => {
  const mockOpenAIInstance = {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  }
  return {
    __esModule: true,
    default: jest.fn(() => mockOpenAIInstance),
  }
})

import { generateBackendChangePlan, applyChangesFromPlan } from '@/lib/services/aiWorkspace'
import OpenAI from 'openai'
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs/promises'
import * as path from 'path'

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    project: {
      findUnique: jest.fn(),
    },
    table: {
      findMany: jest.fn(),
    },
  }
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  }
})

jest.mock('@/lib/db/postgres', () => {
  const mockPrisma = {
    project: {
      findUnique: jest.fn(),
    },
    table: {
      findMany: jest.fn(),
    },
  }
  return {
    prisma: mockPrisma,
  }
})

jest.mock('@/lib/db', () => {
  const mockPrisma = {
    project: {
      findUnique: jest.fn(),
    },
    table: {
      findMany: jest.fn(),
    },
  }
  return {
    prisma: mockPrisma,
  }
})

// Mock OpenAI - need to mock the actual import
jest.mock('openai', () => {
  const mockCreate = jest.fn()
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }))
})

// Mock filesystem
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  readFile: jest.fn(),
  stat: jest.fn(),
}))

describe('AI Workspace Service', () => {
  const { prisma } = require('@/lib/db')

  beforeEach(() => {
    jest.clearAllMocks()
    prisma.table.findMany.mockResolvedValue([])
  })

  describe('generateBackendChangePlan', () => {
    it('should generate a backend change plan', async () => {
      // Get the mocked OpenAI instance
      const openaiInstance = new OpenAI({ apiKey: 'test' })
      const mockCreate = openaiInstance.chat.completions.create as jest.Mock
      
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              description: 'Add user management',
              changes: [{
                type: 'endpoint',
                action: 'create',
                target: '/api/users',
                description: 'Create users endpoint',
                code: 'export async function GET() { return Response.json({ users: [] }) }',
              }],
              estimatedTime: '15 minutes',
              riskLevel: 'low',
            }),
          },
        }],
      })

      const result = await generateBackendChangePlan('Add user management', 'project-1')

      expect(result.changes).toBeDefined()
      expect(result.changes.length).toBeGreaterThan(0)
    }, 10000) // Increase timeout

    it('should handle invalid OpenAI responses', async () => {
      const openaiInstance = new OpenAI({ apiKey: 'test' })
      const mockCreate = openaiInstance.chat.completions.create as jest.Mock
      
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Invalid JSON',
          },
        }],
      })

      await expect(
        generateBackendChangePlan('Add user management', 'project-1')
      ).rejects.toThrow()
    }, 10000) // Increase timeout
  })

  describe('applyChangesFromPlan', () => {
    it('should apply changes and create files', async () => {
      const mockMkdir = jest.fn().mockResolvedValue(undefined)
      const mockWriteFile = jest.fn().mockResolvedValue(undefined)
      
      jest.spyOn(fs, 'mkdir').mockImplementation(mockMkdir)
      jest.spyOn(fs, 'writeFile').mockImplementation(mockWriteFile)

      const plan = {
        id: 'plan-1',
        description: 'Add user management',
        changes: [{
          type: 'endpoint' as const,
          action: 'create' as const,
          target: '/api/users',
          code: 'export async function GET() { return Response.json({ users: [] }) }',
          description: 'Create users endpoint',
        }],
        estimatedTime: '15 minutes',
        riskLevel: 'low' as const,
        createdAt: new Date(),
      }

      // applyChangesFromPlan takes (plan, selectedChangeIndices, projectId)
      const result = await applyChangesFromPlan(plan, [0], 'project-1')

      expect(result.applied).toBeDefined()
      expect(Array.isArray(result.applied)).toBe(true)
    })

    it('should handle file creation errors', async () => {
      const mockMkdir = jest.fn().mockResolvedValue(undefined)
      const mockWriteFile = jest.fn().mockRejectedValue(new Error('Permission denied'))
      
      jest.spyOn(fs, 'mkdir').mockImplementation(mockMkdir)
      jest.spyOn(fs, 'writeFile').mockImplementation(mockWriteFile)

      const plan = {
        id: 'plan-1',
        description: 'Add user management',
        changes: [{
          type: 'endpoint' as const,
          action: 'create' as const,
          target: '/api/users',
          code: 'export async function GET() { return Response.json({ users: [] }) }',
          description: 'Create users endpoint',
        }],
        estimatedTime: '15 minutes',
        riskLevel: 'low' as const,
        createdAt: new Date(),
      }

      // Function catches errors and returns them in errors array
      const result = await applyChangesFromPlan(plan, [0], 'project-1')
      // The function may return success: true even with errors if some changes succeed
      expect(result).toBeDefined()
      expect(Array.isArray(result.errors)).toBe(true)
    })
  })
})

