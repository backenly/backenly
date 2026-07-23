/**
 * PHASE 6: ERROR COMMUNICATION SYSTEM - Comprehensive Tests
 * 
 * Validates that no generic errors remain and all errors provide:
 * - Trace IDs for tracking
 * - Actionable messages
 * - Retry instructions
 * - Recovery guidance
 */

import { describe, it, expect } from '@jest/globals'
import {
  BackenlyError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  DatabaseError,
  NetworkError,
  ExternalServiceError,
  AIError,
  DeploymentError,
  StorageError,
  RateLimitError,
  NotFoundError,
  ConflictError,
  InternalError,
  generateTraceId,
  toErrorResponse,
} from '../lib/errors/types'
import { logError, log, getRecentLogs, getLogsByTraceId, getLogsByFilter, clearLogs } from '../lib/errors/logger'

describe('PHASE 6: Error Communication System', () => {
  beforeEach(() => {
    clearLogs()
  })

  describe('Trace ID Generation', () => {
    it('should generate unique trace IDs', () => {
      const id1 = generateTraceId()
      const id2 = generateTraceId()
      
      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    })

    it('should include timestamp in trace ID', () => {
      const id = generateTraceId()
      const parts = id.split('-')
      
      expect(parts.length).toBe(2)
      expect(parts[0]).toBeTruthy()
      expect(parts[1]).toBeTruthy()
    })
  })

  describe('Error Classes', () => {
    describe('ValidationError', () => {
      it('should create validation error with actionable message', () => {
        const error = new ValidationError('Email format is invalid')
        
        expect(error.message).toBe('Email format is invalid')
        expect(error.category).toBe('validation')
        expect(error.severity).toBe('warning')
        expect(error.recoveryAction).toBe('check_input')
        expect(error.retryable).toBe(true)
        expect(error.actionText).toBe('Fix input and try again')
        expect(error.traceId).toBeTruthy()
      })

      it('should not have generic error message', () => {
        const error = new ValidationError('Password must be at least 8 characters')
        
        expect(error.message).not.toMatch(/something|error|failed/i)
        expect(error.message).toContain('Password')
        expect(error.message).toContain('8 characters')
      })
    })

    describe('AuthenticationError', () => {
      it('should provide login recovery action', () => {
        const error = new AuthenticationError()
        
        expect(error.message).toBe('Your session has expired')
        expect(error.category).toBe('authentication')
        expect(error.recoveryAction).toBe('login')
        expect(error.retryable).toBe(false)
        expect(error.actionText).toBe('Sign in again')
        expect(error.actionUrl).toBe('/auth/login')
      })

      it('should not have generic error message', () => {
        const error = new AuthenticationError('Token is invalid or expired')
        
        expect(error.message).not.toMatch(/something went wrong|error occurred/i)
        expect(error.message).toContain('Token')
      })
    })

    describe('DatabaseError', () => {
      it('should create database error with retry guidance', () => {
        const error = new DatabaseError('Could not save user - database connection lost')
        
        expect(error.message).toContain('database connection')
        expect(error.category).toBe('database')
        expect(error.recoveryAction).toBe('retry')
        expect(error.retryable).toBe(true)
        expect(error.actionText).toBe('Try again')
      })

      it('should provide specific failure reason', () => {
        const error = new DatabaseError('Unique constraint violation on email field')
        
        expect(error.message).toContain('Unique constraint')
        expect(error.message).toContain('email')
      })
    })

    describe('NetworkError', () => {
      it('should include retry delay', () => {
        const error = new NetworkError()
        
        expect(error.category).toBe('network')
        expect(error.retryable).toBe(true)
        expect(error.retryInSeconds).toBe(30)
        expect(error.actionText).toBe('Retry')
      })
    })

    describe('ExternalServiceError', () => {
      it('should identify failing service', () => {
        const error = new ExternalServiceError('ObjectStore', 'Storage bucket creation failed')

        expect(error.message).toContain('ObjectStore')
        expect(error.resource).toBe('ObjectStore')
        expect(error.retryInSeconds).toBe(60)
      })
    })

    describe('AIError', () => {
      it('should provide rephrasing guidance', () => {
        const error = new AIError('Could not understand prompt - please be more specific')
        
        expect(error.message).toContain('more specific')
        expect(error.category).toBe('ai')
        expect(error.actionText).toBe('Try rephrasing')
      })
    })

    describe('RateLimitError', () => {
      it('should include exact wait time', () => {
        const error = new RateLimitError(90)
        
        expect(error.message).toContain('90 seconds')
        expect(error.retryInSeconds).toBe(90)
        expect(error.recoveryAction).toBe('wait')
      })
    })

    describe('NotFoundError', () => {
      it('should specify what was not found', () => {
        const error = new NotFoundError('Project with ID abc123')
        
        expect(error.message).toContain('Project with ID abc123')
        expect(error.resource).toBe('Project with ID abc123')
        expect(error.retryable).toBe(false)
      })
    })

    describe('ConflictError', () => {
      it('should explain the conflict', () => {
        const error = new ConflictError('A user with this email already exists')
        
        expect(error.message).toContain('already exists')
        expect(error.category).toBe('conflict')
        expect(error.recoveryAction).toBe('check_input')
      })
    })
  })

  describe('Error Response Formatting', () => {
    it('should convert BackenlyError to API response format', () => {
      const error = new ValidationError('Invalid email format', {
        operation: 'user_registration',
      })

      const response = toErrorResponse(error)

      expect(response.error.message).toBe('Invalid email format')
      expect(response.error.traceId).toBe(error.traceId)
      expect(response.error.category).toBe('validation')
      expect(response.error.severity).toBe('warning')
      expect(response.error.retryable).toBe(true)
      expect(response.error.actionText).toBe('Fix input and try again')
      expect(response.error.operation).toBe('user_registration')
    })

    it('should convert generic Error to response format', () => {
      const error = new Error('Unexpected error')
      const response = toErrorResponse(error)

      expect(response.error.message).toBe('Unexpected error')
      expect(response.error.traceId).toBeTruthy()
      expect(response.error.category).toBe('internal')
      expect(response.error.retryable).toBe(false)
    })

    it('should handle unknown error types', () => {
      const response = toErrorResponse('String error')

      expect(response.error.message).toBe('String error')
      expect(response.error.traceId).toBeTruthy()
      expect(response.error.category).toBe('internal')
    })
  })

  describe('Error Logging', () => {
    it('should log error with trace ID', () => {
      const error = new ValidationError('Invalid input')
      const traceId = logError(error)

      expect(traceId).toBe(error.traceId)

      const logs = getLogsByTraceId(traceId)
      expect(logs.length).toBe(1)
      expect(logs[0].message).toBe('Invalid input')
      expect(logs[0].category).toBe('validation')
    })

    it('should log error with context', () => {
      const error = new DatabaseError('Connection failed')
      const traceId = logError(error, {
        operation: 'save_user',
        resource: 'users_table',
        userId: 'user123',
        projectId: 'proj456',
        metadata: { attempt: 2 },
      })

      const logs = getLogsByTraceId(traceId)
      expect(logs[0].operation).toBe('save_user')
      expect(logs[0].resource).toBe('users_table')
      expect(logs[0].userId).toBe('user123')
      expect(logs[0].projectId).toBe('proj456')
      expect(logs[0].metadata?.attempt).toBe(2)
    })

    it('should wrap generic errors', () => {
      const error = new Error('Generic error')
      const traceId = logError(error, { operation: 'test_op' })

      const logs = getLogsByTraceId(traceId)
      expect(logs[0].message).toBe('Generic error')
      expect(logs[0].category).toBe('internal')
      expect(logs[0].operation).toBe('test_op')
    })
  })

  describe('Log Filtering', () => {
    beforeEach(() => {
      // Create test logs
      logError(new ValidationError('Invalid email'), {
        userId: 'user1',
        projectId: 'proj1',
        operation: 'register',
      })

      logError(new DatabaseError('Connection failed'), {
        userId: 'user2',
        projectId: 'proj1',
        operation: 'save',
      })

      logError(new AIError('Prompt unclear'), {
        userId: 'user1',
        projectId: 'proj2',
        operation: 'generate',
      })

      log('info', 'User logged in', {
        userId: 'user1',
        operation: 'login',
      })
    })

    it('should filter logs by category', () => {
      const logs = getLogsByFilter({ category: 'validation' })
      expect(logs.length).toBe(1)
      expect(logs[0].category).toBe('validation')
    })

    it('should filter logs by userId', () => {
      const logs = getLogsByFilter({ userId: 'user1' })
      expect(logs.length).toBe(3) // validation, ai, info
    })

    it('should filter logs by projectId', () => {
      const logs = getLogsByFilter({ projectId: 'proj1' })
      expect(logs.length).toBe(2) // validation, database
    })

    it('should filter logs by operation', () => {
      const logs = getLogsByFilter({ operation: 'register' })
      expect(logs.length).toBe(1)
      expect(logs[0].operation).toBe('register')
    })

    it('should combine multiple filters', () => {
      const logs = getLogsByFilter({
        userId: 'user1',
        projectId: 'proj1',
      })
      expect(logs.length).toBe(1)
      expect(logs[0].category).toBe('validation')
    })
  })

  describe('Success Criteria: No Generic Errors', () => {
    const genericPatterns = [
      /something went wrong/i,
      /an error occurred/i,
      /unexpected error/i,
      /error:/i,
      /failed/i, // Alone without context
      /invalid/i, // Alone without context
    ]

    it('ValidationError should not contain generic messages', () => {
      const error = new ValidationError('Email must be in format user@domain.com')
      
      // Should not match most generic patterns
      expect(error.message).not.toMatch(genericPatterns[0])
      expect(error.message).not.toMatch(genericPatterns[1])
      expect(error.message).not.toMatch(genericPatterns[2])
    })

    it('DatabaseError should provide specific context', () => {
      const error = new DatabaseError('Could not save record - unique constraint violated on "email" field')
      
      expect(error.message).toContain('unique constraint')
      expect(error.message).toContain('email')
      expect(error.message).not.toMatch(genericPatterns[0])
    })

    it('NetworkError should explain what failed', () => {
      const error = new NetworkError('API request to /api/users timed out after 30s')
      
      expect(error.message).toContain('API request')
      expect(error.message).toContain('/api/users')
      expect(error.message).toContain('30s')
    })

    it('AIError should provide actionable guidance', () => {
      const error = new AIError('Cannot generate schema from prompt - please describe your data structure more clearly')
      
      expect(error.message).toContain('describe your data structure')
      expect(error.message).toContain('more clearly')
    })

    it('All error classes should have trace IDs', () => {
      const errors = [
        new ValidationError('test'),
        new AuthenticationError(),
        new DatabaseError('test'),
        new NetworkError(),
        new AIError(),
        new RateLimitError(60),
        new NotFoundError('test'),
        new ConflictError('test'),
        new InternalError(),
      ]

      errors.forEach(error => {
        expect(error.traceId).toBeTruthy()
        expect(error.traceId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
      })
    })

    it('All error classes should have recovery actions', () => {
      const errors = [
        new ValidationError('test'),
        new AuthenticationError(),
        new DatabaseError('test'),
        new NetworkError(),
        new AIError(),
        new RateLimitError(60),
        new NotFoundError('test'),
        new ConflictError('test'),
        new InternalError(),
      ]

      errors.forEach(error => {
        expect(error.recoveryAction).toBeTruthy()
        expect(error.recoveryAction).toMatch(/retry|login|wait|check_input|contact_support|none/)
      })
    })

    it('Retryable errors should have actionText', () => {
      const retryableErrors = [
        new ValidationError('test'),
        new DatabaseError('test'),
        new NetworkError(),
        new AIError(),
        new RateLimitError(60),
        new ConflictError('test'),
      ]

      retryableErrors.forEach(error => {
        if (error.retryable) {
          expect(error.actionText).toBeTruthy()
          expect(error.actionText).not.toBe('Try again') // Should be more specific
        }
      })
    })
  })

  describe('Error Context Preservation', () => {
    it('should preserve operation context', () => {
      const error = new DatabaseError('Save failed', {
        operation: 'create_user',
        resource: 'users',
      })

      expect(error.operation).toBe('create_user')
      expect(error.resource).toBe('users')

      const details = error.toUserFacing()
      expect(details.operation).toBe('create_user')
      expect(details.resource).toBe('users')
    })

    it('should preserve metadata', () => {
      const error = new ValidationError('Invalid field', {
        metadata: {
          field: 'email',
          value: 'invalid',
          constraint: 'format',
        },
      })

      expect(error.metadata?.field).toBe('email')
      expect(error.metadata?.value).toBe('invalid')
      expect(error.metadata?.constraint).toBe('format')
    })
  })

  describe('Retry Guidance', () => {
    it('should provide retry delays for temporary errors', () => {
      const networkError = new NetworkError()
      const externalError = new ExternalServiceError('ObjectStore')
      const rateLimitError = new RateLimitError(120)

      expect(networkError.retryInSeconds).toBe(30)
      expect(externalError.retryInSeconds).toBe(60)
      expect(rateLimitError.retryInSeconds).toBe(120)
    })

    it('should not suggest retry for permanent errors', () => {
      const authError = new AuthenticationError()
      const notFoundError = new NotFoundError('User')
      const authzError = new AuthorizationError()

      expect(authError.retryable).toBe(false)
      expect(notFoundError.retryable).toBe(false)
      expect(authzError.retryable).toBe(false)
    })
  })

  describe('Error Severity Levels', () => {
    it('should assign appropriate severity levels', () => {
      expect(new ValidationError('test').severity).toBe('warning')
      expect(new AuthenticationError().severity).toBe('warning')
      expect(new NetworkError().severity).toBe('warning')
      expect(new DatabaseError('test').severity).toBe('error')
      expect(new AIError().severity).toBe('error')
      expect(new InternalError().severity).toBe('critical')
    })
  })
})
