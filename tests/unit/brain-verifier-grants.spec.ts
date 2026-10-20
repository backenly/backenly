/**
 * Brain Verifier - RLS vs Missing GRANT distinction
 *
 * Verifies that `runEndpointTest` and `looksLikeRlsDenied` correctly distinguish
 * between a genuine Row-Level Security denial (which indicates a secured, working endpoint)
 * and a missing PostgreSQL GRANT (which indicates a broken backend role/permissions).
 *
 * Issue #244: The verifier counts a missing GRANT as RLS working.
 */

import {
  runEndpointTest,
  looksLikeRlsDenied,
  extractMissingGrant,
} from '@/lib/ai/brain/verifier'

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
}))

describe('Brain Verifier: RLS vs Missing GRANT distinction (Issue #244)', () => {
  const originalFetch = globalThis.fetch
  const originalAppUrl = process.env.APP_URL

  beforeAll(() => {
    process.env.APP_URL = 'http://localhost:3000'
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    if (originalAppUrl !== undefined) {
      process.env.APP_URL = originalAppUrl
    } else {
      delete process.env.APP_URL
    }
  })

  describe('extractMissingGrant', () => {
    it('extracts missing schema grant', () => {
      const body = '{"error":"permission denied for schema workspace_p1"}'
      expect(extractMissingGrant(body)).toBe('permission denied for schema workspace_p1')
    })

    it('extracts missing table grant', () => {
      const body = '{"error":"permission denied for table posts"}'
      expect(extractMissingGrant(body)).toBe('permission denied for table posts')
    })

    it('extracts missing sequence grant', () => {
      const body = '{"error":"permission denied for sequence posts_id_seq"}'
      expect(extractMissingGrant(body)).toBe('permission denied for sequence posts_id_seq')
    })

    it('extracts missing function grant', () => {
      const body = '{"error":"permission denied for function calculate_score"}'
      expect(extractMissingGrant(body)).toBe('permission denied for function calculate_score')
    })

    it('returns null for non-grant errors', () => {
      expect(extractMissingGrant('{"error":"syntax error at or near \\"FROM\\""}')).toBeNull()
      expect(extractMissingGrant('{"error":"new row violates row-level security policy"}')).toBeNull()
      expect(extractMissingGrant('')).toBeNull()
    })
  })

  describe('looksLikeRlsDenied', () => {
    it('returns true for genuine RLS policy violations', () => {
      expect(
        looksLikeRlsDenied('ERROR: new row violates row-level security policy for table "posts"'),
      ).toBe(true)
      expect(
        looksLikeRlsDenied('{"error":"violates row-level security policy"}'),
      ).toBe(true)
      expect(
        looksLikeRlsDenied('{"message":"Row-Level Security check failed"}'),
      ).toBe(true)
    })

    it('returns false for missing schema/table grants', () => {
      expect(
        looksLikeRlsDenied('{"error":"permission denied for schema workspace_p1"}'),
      ).toBe(false)
      expect(
        looksLikeRlsDenied('{"error":"permission denied for table posts"}'),
      ).toBe(false)
      expect(
        looksLikeRlsDenied('{"error":"permission denied for sequence items_id_seq"}'),
      ).toBe(false)
    })

    it('returns false for bare 42501 code without RLS wording', () => {
      expect(
        looksLikeRlsDenied('{"error":"Raw query failed. Code: `42501`. Message: query failed"}'),
      ).toBe(false)
      expect(
        looksLikeRlsDenied('42501'),
      ).toBe(false)
    })

    it('returns false for generic permission denied without RLS wording', () => {
      expect(
        looksLikeRlsDenied('{"error":"permission denied"}'),
      ).toBe(false)
      expect(
        looksLikeRlsDenied('{"error":"insufficient privilege"}'),
      ).toBe(false)
    })
  })

  describe('runEndpointTest with stubbed fetch', () => {
    it('reports PASS when 500 error is a genuine RLS policy rejection', async () => {
      const rlsBody = JSON.stringify({
        error: 'Raw query failed. Code: 42501. Message: ERROR: new row violates row-level security policy for table "posts"',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => rlsBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(true)
      expect(result.summary).toContain('(RLS-denied)')
      expect(result.summary).toContain('Row-Level Security blocked the test row')
      expect(result.statusCode).toBe(500)
    })

    it('reports FAIL as server_error when 500 error is a missing schema GRANT, naming the privilege', async () => {
      const grantBody = JSON.stringify({
        error: 'permission denied for schema workspace_p1',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => grantBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('server_error')
      expect(result.statusCode).toBe(500)
      expect(result.summary).toContain('grant is missing')
      expect(result.summary).toContain('permission denied for schema workspace_p1')
    })

    it('reports FAIL as server_error when 500 error is a missing table GRANT, naming the privilege', async () => {
      const grantBody = JSON.stringify({
        error: 'permission denied for table posts',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => grantBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('server_error')
      expect(result.statusCode).toBe(500)
      expect(result.summary).toContain('grant is missing')
      expect(result.summary).toContain('permission denied for table posts')
    })

    it('reports FAIL as server_error when 500 error is a missing foreign table GRANT', async () => {
      const grantBody = JSON.stringify({
        error: 'permission denied for foreign table remote_feed',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => grantBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('server_error')
      expect(result.statusCode).toBe(500)
      expect(result.summary).toContain('grant is missing')
      expect(result.summary).toContain('permission denied for foreign table remote_feed')
    })

    it('detects missing GRANT even when error is buried past 320 characters in a long response body', async () => {
      const longPadding = 'A'.repeat(400)
      const grantBody = JSON.stringify({
        debugInfo: longPadding,
        error: 'permission denied for schema workspace_deep',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => grantBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('server_error')
      expect(result.summary).toContain('grant is missing')
      expect(result.summary).toContain('permission denied for schema workspace_deep')
    })

    it('reports FAIL as server_error when 500 error has bare 42501 code without RLS phrasing', async () => {
      const bareCodeBody = JSON.stringify({
        code: '42501',
        message: 'insufficient_privilege',
      })

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: async () => bareCodeBody,
      } as unknown as Response)

      const result = await runEndpointTest({
        projectId: 'proj_test',
        tableName: 'posts',
        operation: 'list',
        sessionToken: 'test-session-token',
      })

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('server_error')
      expect(result.statusCode).toBe(500)
      expect(result.summary).toContain('The endpoint exists but threw a server error')
    })
  })
})

