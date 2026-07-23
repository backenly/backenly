/**
 * PHASE 5: Timeline Granularity Upgrade - Comprehensive Tests
 * 
 * Validates that all system changes are recorded with full granular details
 * for user verification without inspecting infrastructure.
 */

import { describe, it, expect } from '@jest/globals'
import { ExecutionChange, ChangeDetails } from '../lib/orchestration/atomic-executor'
import { generateTimelineEntry, TimelineEntry, GranularChangeGroup } from '../lib/orchestration/trust-timeline'
import { CanonicalIntent } from '../lib/orchestration/types'
import { ExecutionResult } from '../lib/orchestration/atomic-executor'

describe('PHASE 5: Timeline Granularity Upgrade', () => {
  describe('ExecutionChange interface', () => {
    it('should record table creation with entity name and fields', () => {
      const change: ExecutionChange = {
        type: 'table',
        action: 'created',
        target: 'users',
        details: {
          entityName: 'users',
          fields: [
            { name: 'id', type: 'String', required: true },
            { name: 'email', type: 'String', required: true, unique: true },
            { name: 'name', type: 'String', required: false },
          ],
        },
      }

      expect(change.type).toBe('table')
      expect(change.action).toBe('created')
      expect(change.details.entityName).toBe('users')
      expect(change.details.fields).toHaveLength(3)
      expect(change.details.fields![0]).toEqual({
        name: 'id',
        type: 'String',
        required: true,
      })
    })

    it('should record field additions with field name and type', () => {
      const change: ExecutionChange = {
        type: 'column',
        action: 'created',
        target: 'users.avatar',
        details: {
          fieldName: 'avatar',
          fieldType: 'String',
          constraints: ['nullable'],
        },
      }

      expect(change.type).toBe('column')
      expect(change.details.fieldName).toBe('avatar')
      expect(change.details.fieldType).toBe('String')
      expect(change.details.constraints).toContain('nullable')
    })

    it('should record API endpoint generation with methods and path', () => {
      const change: ExecutionChange = {
        type: 'api',
        action: 'created',
        target: '/api/users',
        details: {
          methods: ['GET', 'POST'],
          path: '/api/users',
          purpose: 'User CRUD operations',
        },
      }

      expect(change.type).toBe('api')
      expect(change.details.methods).toEqual(['GET', 'POST'])
      expect(change.details.path).toBe('/api/users')
      expect(change.details.purpose).toBe('User CRUD operations')
    })

    it('should record auth configuration with provider details', () => {
      const change: ExecutionChange = {
        type: 'auth',
        action: 'enabled',
        target: 'google',
        details: {
          authProvider: 'google',
          authType: 'oauth',
          enabled: true,
          config: {
            clientId: 'xxx',
            scopes: ['email', 'profile'],
          },
        },
      }

      expect(change.type).toBe('auth')
      expect(change.action).toBe('enabled')
      expect(change.details.authProvider).toBe('google')
      expect(change.details.enabled).toBe(true)
      expect(change.details.config).toHaveProperty('scopes')
    })

    it('should record storage bucket creation with bucket details', () => {
      const change: ExecutionChange = {
        type: 'storage',
        action: 'created',
        target: 'user-uploads',
        details: {
          bucketName: 'user-uploads',
          bucketId: 'bucket-123',
          allowedTypes: ['image/png', 'image/jpeg'],
          maxSize: 5242880, // 5MB
        },
      }

      expect(change.type).toBe('storage')
      expect(change.details.bucketName).toBe('user-uploads')
      expect(change.details.allowedTypes).toContain('image/png')
      expect(change.details.maxSize).toBe(5242880)
    })

    it('should record integration configuration', () => {
      const change: ExecutionChange = {
        type: 'capability',
        action: 'enabled',
        target: 'openai',
        details: {
          capabilityType: 'ai-completion',
          integrationName: 'OpenAI GPT-4',
          settings: {
            model: 'gpt-4',
            temperature: 0.7,
          },
        },
      }

      expect(change.type).toBe('capability')
      expect(change.details.capabilityType).toBe('ai-completion')
      expect(change.details.integrationName).toBe('OpenAI GPT-4')
    })

    it('should record deployment actions with environment and URL', () => {
      const change: ExecutionChange = {
        type: 'deployment',
        action: 'created',
        target: 'production',
        details: {
          environment: 'production',
          deploymentUrl: 'https://api.example.com',
          deploymentProvider: 'vercel',
          status: 'deployed',
        },
      }

      expect(change.type).toBe('deployment')
      expect(change.details.environment).toBe('production')
      expect(change.details.deploymentUrl).toBe('https://api.example.com')
      expect(change.details.deploymentProvider).toBe('vercel')
    })
  })

  describe('Granular Change Generation', () => {
    it('should generate granular changes for table creation', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'table',
          action: 'created',
          target: 'users',
          details: {
            entityName: 'users',
            fields: [
              { name: 'id', type: 'String' },
              { name: 'email', type: 'String' },
            ],
          },
        },
        {
          type: 'table',
          action: 'created',
          target: 'posts',
          details: {
            entityName: 'posts',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'users and posts tables',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Created tables',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      expect(timelineEntry.granularChanges).toBeDefined()
      expect(timelineEntry.granularChanges!.length).toBeGreaterThan(0)

      const entitiesGroup = timelineEntry.granularChanges!.find(g => g.type === 'entities')
      expect(entitiesGroup).toBeDefined()
      expect(entitiesGroup!.label).toBe('Tables Created (2)')
      expect(entitiesGroup!.items).toHaveLength(2)
      expect(entitiesGroup!.items[0].name).toBe('users')
    })

    it('should generate granular changes for field additions', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'column',
          action: 'created',
          target: 'users.bio',
          details: {
            fieldName: 'bio',
            fieldType: 'String',
          },
        },
        {
          type: 'column',
          action: 'created',
          target: 'users.avatar',
          details: {
            fieldName: 'avatar',
            fieldType: 'String',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'user profile fields',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Added fields',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const fieldsGroup = timelineEntry.granularChanges!.find(g => g.type === 'fields')
      expect(fieldsGroup).toBeDefined()
      expect(fieldsGroup!.label).toBe('Fields Added (2)')
      expect(fieldsGroup!.items[0].details).toContain('bio')
      expect(fieldsGroup!.items[1].details).toContain('avatar')
    })

    it('should generate granular changes for API endpoints', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'api',
          action: 'created',
          target: '/api/users',
          details: {
            methods: ['GET', 'POST'],
            path: '/api/users',
          },
        },
        {
          type: 'api',
          action: 'created',
          target: '/api/posts',
          details: {
            method: 'GET',
            path: '/api/posts',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'CRUD APIs',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Generated APIs',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const apisGroup = timelineEntry.granularChanges!.find(g => g.type === 'apis')
      expect(apisGroup).toBeDefined()
      expect(apisGroup!.label).toBe('Endpoints Generated (2)')
      expect(apisGroup!.items[0].details).toContain('GET, POST')
      expect(apisGroup!.items[1].details).toContain('GET')
    })

    it('should generate granular changes for auth configuration', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'auth',
          action: 'enabled',
          target: 'google',
          details: {
            authProvider: 'google',
            enabled: true,
          },
        },
        {
          type: 'auth',
          action: 'enabled',
          target: 'github',
          details: {
            authProvider: 'github',
            enabled: true,
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'OAuth login',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Configured auth',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const authGroup = timelineEntry.granularChanges!.find(g => g.type === 'auth')
      expect(authGroup).toBeDefined()
      expect(authGroup!.label).toBe('Authentication Configured (2)')
      expect(authGroup!.items[0].details).toContain('google')
      expect(authGroup!.items[1].details).toContain('github')
    })

    it('should generate granular changes for storage resources', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'storage',
          action: 'created',
          target: 'user-avatars',
          details: {
            bucketName: 'user-avatars',
            purpose: 'profile pictures',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'file uploads',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Created storage',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const storageGroup = timelineEntry.granularChanges!.find(g => g.type === 'storage')
      expect(storageGroup).toBeDefined()
      expect(storageGroup!.label).toBe('Storage Buckets Created (1)')
      expect(storageGroup!.items[0].name).toBe('user-avatars')
      expect(storageGroup!.items[0].details).toContain('profile pictures')
    })

    it('should generate granular changes for integrations', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'capability',
          action: 'enabled',
          target: 'stripe-payments',
          details: {
            capabilityType: 'payments',
            integrationName: 'Stripe',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'payment processing',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Enabled integration',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const integrationsGroup = timelineEntry.granularChanges!.find(g => g.type === 'integrations')
      expect(integrationsGroup).toBeDefined()
      expect(integrationsGroup!.label).toBe('Integrations Enabled (1)')
      expect(integrationsGroup!.items[0].details).toContain('integration active')
    })

    it('should generate granular changes for deployments', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'deployment',
          action: 'created',
          target: 'production',
          details: {
            environment: 'production',
            deploymentUrl: 'https://api.myapp.com',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'DEPLOY',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Deployed',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      const deploymentsGroup = timelineEntry.granularChanges!.find(g => g.type === 'deployments')
      expect(deploymentsGroup).toBeDefined()
      expect(deploymentsGroup!.label).toBe('Deployments (1)')
      expect(deploymentsGroup!.items[0].details).toContain('https://api.myapp.com')
    })
  })

  describe('Timeline Entry Generation', () => {
    it('should include both legacy details and granular changes', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'table',
          action: 'created',
          target: 'users',
          details: {
            entityName: 'users',
          },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'user management',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Created users table',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      expect(timelineEntry.title).toBeDefined()
      expect(timelineEntry.description).toBeDefined()
      expect(timelineEntry.expandedDetails).toBeDefined()
      expect(timelineEntry.granularChanges).toBeDefined()
      expect(timelineEntry.category).toBe('feature_added')
    })

    it('should handle mixed change types correctly', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'table',
          action: 'created',
          target: 'products',
          details: { entityName: 'products' },
        },
        {
          type: 'api',
          action: 'created',
          target: '/api/products',
          details: { methods: ['GET', 'POST'] },
        },
        {
          type: 'auth',
          action: 'enabled',
          target: 'google',
          details: { authProvider: 'google' },
        },
      ]

      const mockIntent: CanonicalIntent = {
        type: 'FEATURE_ADD',
        feature: 'product management with auth',
        confidence: 0.9,
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Built product management',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(mockIntent, mockResult)

      expect(timelineEntry.granularChanges).toHaveLength(3)
      expect(timelineEntry.granularChanges!.find(g => g.type === 'entities')).toBeDefined()
      expect(timelineEntry.granularChanges!.find(g => g.type === 'apis')).toBeDefined()
      expect(timelineEntry.granularChanges!.find(g => g.type === 'auth')).toBeDefined()
    })
  })

  describe('Success Criteria: User Verification Without Infrastructure Inspection', () => {
    it('should allow users to verify entity names without looking at database', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'table',
          action: 'created',
          target: 'customers',
          details: { entityName: 'customers' },
        },
      ]

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Created table',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(
        { type: 'FEATURE_ADD', feature: 'customers', confidence: 0.9 },
        mockResult
      )

      const entitiesGroup = timelineEntry.granularChanges!.find(g => g.type === 'entities')
      expect(entitiesGroup!.items[0].name).toBe('customers')
      // User can verify "customers" table was created without checking database
    })

    it('should allow users to verify field details without schema inspection', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'column',
          action: 'created',
          target: 'products.price',
          details: {
            fieldName: 'price',
            fieldType: 'Float',
          },
        },
      ]

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Added field',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(
        { type: 'FEATURE_ADD', feature: 'product pricing', confidence: 0.9 },
        mockResult
      )

      const fieldsGroup = timelineEntry.granularChanges!.find(g => g.type === 'fields')
      expect(fieldsGroup!.items[0].name).toBe('products.price')
      expect(fieldsGroup!.items[0].details).toContain('Float')
      // User can verify field type without checking schema
    })

    it('should allow users to verify API endpoints without testing routes', () => {
      const changes: ExecutionChange[] = [
        {
          type: 'api',
          action: 'created',
          target: '/api/orders',
          details: {
            methods: ['GET', 'POST', 'PUT'],
            path: '/api/orders',
          },
        },
      ]

      const mockResult: ExecutionResult = {
        success: true,
        changes,
        message: 'Generated API',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(
        { type: 'FEATURE_ADD', feature: 'order API', confidence: 0.9 },
        mockResult
      )

      const apisGroup = timelineEntry.granularChanges!.find(g => g.type === 'apis')
      expect(apisGroup!.items[0].name).toBe('/api/orders')
      expect(apisGroup!.items[0].details).toContain('GET')
      expect(apisGroup!.items[0].details).toContain('POST')
      expect(apisGroup!.items[0].details).toContain('PUT')
      // User can verify endpoints and methods without testing
    })

    it('should provide full metadata for advanced verification', () => {
      const change: ExecutionChange = {
        type: 'storage',
        action: 'created',
        target: 'documents',
        details: {
          bucketName: 'documents',
          bucketId: 'bucket-abc-123',
          allowedTypes: ['application/pdf', 'application/msword'],
          maxSize: 10485760,
        },
      }

      const mockResult: ExecutionResult = {
        success: true,
        changes: [change],
        message: 'Created storage',
        afterState: {} as any,
      }

      const timelineEntry = generateTimelineEntry(
        { type: 'FEATURE_ADD', feature: 'document storage', confidence: 0.9 },
        mockResult
      )

      const storageGroup = timelineEntry.granularChanges!.find(g => g.type === 'storage')
      const item = storageGroup!.items[0]

      expect(item.metadata).toBeDefined()
      expect(item.metadata.bucketId).toBe('bucket-abc-123')
      expect(item.metadata.allowedTypes).toContain('application/pdf')
      expect(item.metadata.maxSize).toBe(10485760)
      // Advanced users can access full technical metadata
    })
  })
})
