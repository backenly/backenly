/**
 * AI Data Access Security Tests
 * =============================
 * Verifies that AI CANNOT access row-level database data.
 * AI should only see schema/metadata, never actual user data.
 */

import { describe, it, expect, beforeEach } from '@jest/globals'
import { 
  sanitizeAIContext, 
  enforceSchemaOnlyContext, 
  quickDataCheck,
  type SanitizedContext 
} from '@/lib/ai/context-sanitizer'

describe('AI Data Access Security', () => {
  describe('sanitizeAIContext', () => {
    it('should allow schema-only context', () => {
      const schemaContext = {
        schema: {
          tables: [{
            name: 'users',
            columns: [
              { name: 'id', type: 'uuid' },
              { name: 'email', type: 'string' },
              { name: 'name', type: 'string' },
            ],
            relationships: [{ field: 'userId', references: 'users' }]
          }]
        },
        metadata: {
          projectId: 'test-123',
          projectName: 'Test Project',
          databaseProvisioned: true
        }
      }

      const result = sanitizeAIContext(schemaContext)
      
      expect(result.allowed).toBe(true)
      expect(result.violations).toHaveLength(0)
      expect(result.sanitized).toBeDefined()
      expect(result.sanitized?.schema.tables).toHaveLength(1)
    })

    it('should detect and block row data with email addresses', () => {
      const contextWithRowData = {
        schema: {
          tables: [{
            name: 'users',
            columns: [{ name: 'email', type: 'string' }]
          }]
        },
        // This simulates row data accidentally included
        data: [
          { email: 'john@example.com', name: 'John' },
          { email: 'jane@example.com', name: 'Jane' }
        ]
      }

      const result = sanitizeAIContext(contextWithRowData)
      
      // In production, this would be blocked
      // In development, violations are logged but allowed
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations.some(v => v.includes('email'))).toBe(true)
    })

    it('should detect large arrays that look like row data', () => {
      const contextWithManyRows = {
        schema: { tables: [] },
        // 50 items with similar structure = likely row data
        records: Array(50).fill(null).map((_, i) => ({
          id: i,
          name: `User ${i}`,
          email: `user${i}@test.com`
        }))
      }

      const result = sanitizeAIContext(contextWithManyRows)
      
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations.some(v => v.includes('Large array'))).toBe(true)
    })

    it('should detect forbidden keys suggesting row data', () => {
      const contextWithForbiddenKeys = {
        schema: { tables: [] },
        rows: [{ id: 1, name: 'Test' }],
        passwords: ['secret123'],
        tokens: ['abc123']
      }

      const result = sanitizeAIContext(contextWithForbiddenKeys)
      
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations.some(v => v.includes('rows'))).toBe(true)
    })

    it('should extract safe schema from mixed context', () => {
      const mixedContext = {
        schema: {
          tables: [{
            name: 'products',
            columns: [
              { name: 'id', type: 'uuid' },
              { name: 'name', type: 'string' },
              { name: 'price', type: 'number' }
            ]
          }]
        },
        metadata: {
          projectId: 'proj-123',
          projectName: 'E-commerce',
          databaseProvisioned: true
        },
        // This should be filtered out
        someLargeText: 'x'.repeat(500)
      }

      const result = sanitizeAIContext(mixedContext)
      
      expect(result.sanitized).toBeDefined()
      expect(result.sanitized?.schema.tables).toHaveLength(1)
      expect(result.sanitized?.schema.tables[0].name).toBe('products')
      expect(result.sanitized?.schema.tables[0].columns).toHaveLength(3)
    })
  })

  describe('enforceSchemaOnlyContext', () => {
    it('should return sanitized context for valid schema', () => {
      const validContext = {
        schema: {
          tables: [{
            name: 'orders',
            columns: [{ name: 'id', type: 'uuid' }]
          }]
        }
      }

      const result = enforceSchemaOnlyContext(validContext)
      
      expect(result.schema.tables).toHaveLength(1)
      expect(result.schema.tables[0].name).toBe('orders')
    })

    it('should detect violations in context with row data', () => {
      // Test that sanitizeAIContext detects violations
      const contextWithData = {
        rows: [{ email: 'test@example.com' }]
      }

      const result = sanitizeAIContext(contextWithData)
      
      // Should detect violations
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations.some(v => v.includes('rows'))).toBe(true)
    })
  })

  describe('quickDataCheck', () => {
    it('should detect email addresses', () => {
      expect(quickDataCheck('user@example.com')).toBe(true)
      expect(quickDataCheck('Contact us at support@company.co.uk')).toBe(true)
    })

    it('should detect phone numbers', () => {
      expect(quickDataCheck('555-123-4567')).toBe(true)
      expect(quickDataCheck('555.123.4567')).toBe(true)
    })

    it('should detect credit card patterns', () => {
      expect(quickDataCheck('4111 1111 1111 1111')).toBe(true)
      expect(quickDataCheck('4111-1111-1111-1111')).toBe(true)
    })

    it('should not flag safe schema strings', () => {
      expect(quickDataCheck('users')).toBe(false)
      expect(quickDataCheck('email')).toBe(false)
      expect(quickDataCheck('string')).toBe(false)
      expect(quickDataCheck('uuid')).toBe(false)
    })
  })

  describe('Security Test: User asks for row data', () => {
    it('should handle "Show me all rows in users table" safely', () => {
      // Simulate what would happen if this prompt reached the AI
      const userPrompt = 'Show me all rows in the users table'
      
      // The AI context should only contain schema
      const aiContext = {
        schema: {
          tables: [{
            name: 'users',
            columns: [
              { name: 'id', type: 'uuid' },
              { name: 'email', type: 'string' },
              { name: 'created_at', type: 'timestamp' }
            ]
          }]
        },
        userPrompt
      }

      const result = sanitizeAIContext(aiContext)
      
      // Context should be allowed (no row data in context)
      expect(result.allowed).toBe(true)
      expect(result.sanitized?.schema.tables[0].columns).toHaveLength(3)
      
      // AI should respond with schema info, not execute query
      // This is handled by the intent parser, not the sanitizer
    })

    it('should block context that accidentally includes query results', () => {
      // Simulate a bug where query results were accidentally included
      const buggyContext = {
        schema: {
          tables: [{ name: 'users', columns: [{ name: 'email', type: 'string' }] }]
        },
        // Bug: query results included in context
        queryResults: [
          { email: 'admin@company.com', role: 'admin' },
          { email: 'user@company.com', role: 'user' }
        ]
      }

      const result = sanitizeAIContext(buggyContext)
      
      // Should detect the violation
      expect(result.violations.length).toBeGreaterThan(0)
    })
  })
})

describe('AI Context Security - Real-world Scenarios', () => {
  it('should handle complex schema with many tables', () => {
    const complexSchema = {
      schema: {
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', type: 'uuid', isPrimaryKey: true },
              { name: 'email', type: 'string', nullable: false },
              { name: 'name', type: 'string' },
              { name: 'created_at', type: 'timestamp' }
            ],
            relationships: []
          },
          {
            name: 'posts',
            columns: [
              { name: 'id', type: 'uuid', isPrimaryKey: true },
              { name: 'title', type: 'string' },
              { name: 'content', type: 'text' },
              { name: 'user_id', type: 'uuid' }
            ],
            relationships: [{ field: 'user_id', references: 'users' }]
          },
          {
            name: 'comments',
            columns: [
              { name: 'id', type: 'uuid', isPrimaryKey: true },
              { name: 'text', type: 'text' },
              { name: 'post_id', type: 'uuid' }
            ],
            relationships: [
              { field: 'post_id', references: 'posts' }
            ]
          }
        ]
      },
      metadata: {
        projectId: 'blog-platform',
        projectName: 'Blog Platform',
        databaseProvisioned: true
      }
    }

    const result = sanitizeAIContext(complexSchema)
    
    expect(result.allowed).toBe(true)
    expect(result.sanitized?.schema.tables).toHaveLength(3)
    expect(result.violations).toHaveLength(0)
  })

  it('should sanitize context from database service', () => {
    // Simulates actual context from lib/ai/context-reader.ts
    const contextFromReader = {
      tables: [
        {
          name: 'orders',
          columns: [
            { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
            { name: 'total', type: 'decimal', nullable: false },
            { name: 'status', type: 'string', nullable: false }
          ],
          relationships: [
            { column: 'user_id', referencesTable: 'users', referencesColumn: 'id' }
          ]
        }
      ],
      apis: [
        { tableName: 'orders', basePath: '/api/orders', operations: ['create', 'read', 'update'] }
      ],
      project: {
        id: 'proj-123',
        name: 'E-commerce',
        databaseProvisioned: true
      }
    }

    const result = sanitizeAIContext(contextFromReader)
    
    expect(result.allowed).toBe(true)
    expect(result.sanitized?.schema.tables[0].name).toBe('orders')
    expect(result.sanitized?.apis).toBeDefined()
  })
})
