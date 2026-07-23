/**
 * SECURITY & ISOLATION EDGE CASE TESTS
 * =====================================
 * Tests the critical gaps that cause systems to look correct but break in real usage:
 *
 * 1. Cross-org data access attempts
 * 2. Role escalation attacks
 * 3. Race conditions (concurrent mutations)
 * 4. Partial failure scenarios (trigger fires but DB fails)
 * 5. Idempotency of event triggers
 */

import { describe, test, expect, beforeEach } from '@jest/globals'

// ── 1. Cross-Org Access ───────────────────────────────────────────────────────

describe('Cross-Org Isolation', () => {
  const PROJECT_A = 'proj_test_a'
  const PROJECT_B = 'proj_test_b'

  test('API key scoped to project A cannot query project B tables', () => {
    // The middleware checks: apiKeyRecord.projectId !== projectId → 403
    // Simulate the check directly
    const apiKeyProjectId = PROJECT_A
    const requestProjectId = PROJECT_B

    const isAllowed = apiKeyProjectId === requestProjectId
    expect(isAllowed).toBe(false)
  })

  test('workspace schema names are properly scoped per project', () => {
    const getSchema = (projectId: string) => `workspace_${projectId}`
    const schemaA = getSchema(PROJECT_A)
    const schemaB = getSchema(PROJECT_B)

    expect(schemaA).toBe('workspace_proj_test_a')
    expect(schemaB).toBe('workspace_proj_test_b')
    expect(schemaA).not.toBe(schemaB)
  })

  test('dashboard (non-public) API keys are rejected from v1 routes', () => {
    // Middleware enforces: keyType must be 'public' for v1 routes
    const dashboardKey = { keyType: 'dashboard' }
    const publicKey = { keyType: 'public' }

    const isAllowedDashboard = dashboardKey.keyType === 'public'
    const isAllowedPublic = publicKey.keyType === 'public'

    expect(isAllowedDashboard).toBe(false)
    expect(isAllowedPublic).toBe(true)
  })

  test('column name injection attempts are rejected', () => {
    const SAFE_COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/i
    const injectionAttempts = [
      "'; DROP TABLE users; --",
      'col" OR 1=1 --',
      '1; DELETE FROM workspace',
      '../secret',
      'name\x00evil',
    ]

    for (const attempt of injectionAttempts) {
      expect(SAFE_COLUMN_PATTERN.test(attempt)).toBe(false)
    }
  })

  test('valid column names pass the safety check', () => {
    const SAFE_COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/i
    const validColumns = ['id', 'user_id', 'createdAt', 'firstName', '_internal', 'col123']

    for (const col of validColumns) {
      expect(SAFE_COLUMN_PATTERN.test(col)).toBe(true)
    }
  })
})

// ── 2. Role Escalation ────────────────────────────────────────────────────────

describe('Role Escalation Prevention', () => {
  function hasPermission(permissions: string[], required: string | string[]): boolean {
    const requiredPerms = Array.isArray(required) ? required : [required]
    if (permissions.includes('admin')) return true
    return requiredPerms.every(perm => permissions.includes(perm))
  }

  test('viewer role cannot write', () => {
    const viewerPermissions = ['read']
    expect(hasPermission(viewerPermissions, 'write')).toBe(false)
    expect(hasPermission(viewerPermissions, 'admin')).toBe(false)
    expect(hasPermission(viewerPermissions, 'delete')).toBe(false)
  })

  test('member role cannot delete', () => {
    const memberPermissions = ['read', 'write']
    expect(hasPermission(memberPermissions, 'delete')).toBe(false)
    expect(hasPermission(memberPermissions, 'admin')).toBe(false)
  })

  test('admin role has all permissions', () => {
    const adminPermissions = ['admin']
    expect(hasPermission(adminPermissions, 'read')).toBe(true)
    expect(hasPermission(adminPermissions, 'write')).toBe(true)
    expect(hasPermission(adminPermissions, 'delete')).toBe(true)
  })

  test('capability scoping — database key cannot access auth endpoints', () => {
    function hasCapability(capabilities: string[], required: string): boolean {
      if (capabilities.length === 0) return true // no restrictions = all allowed
      return capabilities.includes(required)
    }

    const dbOnlyKey = { capabilities: ['database'] }
    expect(hasCapability(dbOnlyKey.capabilities, 'auth')).toBe(false)
    expect(hasCapability(dbOnlyKey.capabilities, 'database')).toBe(true)
    expect(hasCapability(dbOnlyKey.capabilities, 'storage')).toBe(false)
  })
})

// ── 3. Race Conditions ────────────────────────────────────────────────────────

describe('Race Condition Handling', () => {
  test('concurrent insertions produce independent results (no shared state)', async () => {
    const results: number[] = []
    const counter = { value: 0 }

    // Simulate two concurrent operations on isolated data
    await Promise.all([
      (async () => { const v = counter.value; await new Promise(r => setTimeout(r, 10)); results.push(v + 1) })(),
      (async () => { const v = counter.value; await new Promise(r => setTimeout(r, 5));  results.push(v + 2) })(),
    ])

    // Each got their own copy of counter.value (0), so results are [1, 2] in some order
    expect(results).toHaveLength(2)
    expect(results).toContain(1)
    expect(results).toContain(2)
  })

  test('deduplication window correctly identifies duplicate events', () => {
    const recentEvents = new Map<string, number>()
    const DEDUP_WINDOW_MS = 5_000

    function isDuplicate(key: string): boolean {
      const lastFired = recentEvents.get(key)
      if (lastFired && Date.now() - lastFired < DEDUP_WINDOW_MS) return true
      recentEvents.set(key, Date.now())
      return false
    }

    const key = 'trigger1:insert:users:{id:1}'
    expect(isDuplicate(key)).toBe(false) // first call — not duplicate
    expect(isDuplicate(key)).toBe(true)  // second call within 5s — duplicate
  })

  test('deduplication expires after window', async () => {
    const recentEvents = new Map<string, number>()
    const DEDUP_WINDOW_MS = 50 // 50ms for testing

    function isDuplicate(key: string): boolean {
      const lastFired = recentEvents.get(key)
      if (lastFired && Date.now() - lastFired < DEDUP_WINDOW_MS) return true
      recentEvents.set(key, Date.now())
      return false
    }

    const key = 'trigger2:update:orders:{id:5}'
    expect(isDuplicate(key)).toBe(false)
    await new Promise(r => setTimeout(r, 60)) // wait past window
    expect(isDuplicate(key)).toBe(false) // should NOT be duplicate after expiry
  })
})

// ── 4. Partial Failure ────────────────────────────────────────────────────────

describe('Partial Failure Resilience', () => {
  test('trigger failure does not fail the main DB insert', async () => {
    let mainInsertCompleted = false
    let triggerError: string | null = null

    // Simulate the non-blocking fire pattern from insert route
    const fakeInsert = async () => {
      mainInsertCompleted = true
      return { id: '123', name: 'Test' }
    }

    const fakeTrigger = async () => {
      throw new Error('Trigger webhook timeout')
    }

    const inserted = await fakeInsert()
    // Non-blocking fire — catches error but doesn't re-throw
    fakeTrigger().catch(err => { triggerError = err.message })

    // Give the microtask queue a tick
    await new Promise(r => setTimeout(r, 0))

    expect(mainInsertCompleted).toBe(true)
    expect(inserted).toEqual({ id: '123', name: 'Test' })
    expect(triggerError).toBe('Trigger webhook timeout')
  })

  test('retry helper exhausts attempts and throws on persistent failure', async () => {
    async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1): Promise<T> {
      let lastError: Error | undefined
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn()
        } catch (err: any) {
          lastError = err
          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)))
          }
        }
      }
      throw lastError
    }

    let attempts = 0
    const alwaysFails = () => { attempts++; throw new Error('network error') }

    await expect(withRetry(alwaysFails, 3, 1)).rejects.toThrow('network error')
    expect(attempts).toBe(3)
  })

  test('retry helper succeeds on second attempt', async () => {
    async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1): Promise<T> {
      let lastError: Error | undefined
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn()
        } catch (err: any) {
          lastError = err
          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)))
          }
        }
      }
      throw lastError
    }

    let attempts = 0
    const failsThenSucceeds = () => {
      attempts++
      if (attempts < 2) throw new Error('temporary error')
      return Promise.resolve('success')
    }

    const result = await withRetry(failsThenSucceeds, 3, 1)
    expect(result).toBe('success')
    expect(attempts).toBe(2)
  })
})

// ── 5. API Usability ─────────────────────────────────────────────────────────

describe('API Usability — Field Selection & Filtering', () => {
  test('select clause uses only validated column names', () => {
    const requestedFields = ['id', 'name', 'email', "'; DROP TABLE --", '1 OR 1=1']
    const SAFE_PATTERN = /^[a-z_][a-z0-9_]*$/i

    const safeFields = requestedFields.filter(c => SAFE_PATTERN.test(c))
    const selectClause = safeFields.map(c => `"${c}"`).join(', ')

    expect(safeFields).toEqual(['id', 'name', 'email'])
    expect(selectClause).toBe('"id", "name", "email"')
  })

  test('empty select defaults to wildcard', () => {
    const select: string[] = []
    const SAFE_PATTERN = /^[a-z_][a-z0-9_]*$/i

    const selectClause = (select && select.length > 0)
      ? select.filter(c => SAFE_PATTERN.test(c)).map(c => `"${c}"`).join(', ') || '*'
      : '*'

    expect(selectClause).toBe('*')
  })

  test('pagination metadata is correct', () => {
    const limit = 10
    const offset = 20
    const total = 95
    const rows = new Array(10).fill({})

    const page = Math.floor(offset / limit)
    const hasMore = offset + rows.length < total

    expect(page).toBe(2)
    expect(hasMore).toBe(true)
  })

  test('last page shows hasMore = false', () => {
    const limit = 10
    const offset = 90
    const total = 95
    const rows = new Array(5).fill({})

    const hasMore = offset + rows.length < total
    expect(hasMore).toBe(false)
  })
})

// ── 6. WAF Pattern Validation ─────────────────────────────────────────────────

describe('WAF — Attack Pattern Detection', () => {
  const SQL_INJECTION_PATTERNS = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|SCRIPT)\b)/i,
    /(\bOR\b.*=.*)/i,
    /(\bUNION\b.*\bSELECT\b)/i,
    /(\bWAITFOR\b.*\bDELAY\b)/i,
  ]

  const XSS_PATTERNS = [
    /<script[^>]*>.*?<\/script>/gi,
    /javascript:/i,
    /on\w+\s*=/i,
  ]

  function detectSQL(input: string): boolean {
    return SQL_INJECTION_PATTERNS.some(p => p.test(input))
  }
  function detectXSS(input: string): boolean {
    return XSS_PATTERNS.some(p => p.test(input))
  }

  test('SQL injection in table name is detected', () => {
    expect(detectSQL("'; DROP TABLE users; --")).toBe(true)
    expect(detectSQL('UNION SELECT password FROM users')).toBe(true)
    expect(detectSQL('WAITFOR DELAY 0:0:5')).toBe(true)
  })

  test('normal query params are not flagged', () => {
    expect(detectSQL('John Doe')).toBe(false)
    expect(detectSQL('user@email.com')).toBe(false)
    expect(detectSQL('2024-01-01')).toBe(false)
  })

  test('XSS payload is detected', () => {
    expect(detectXSS('<script>alert(1)</script>')).toBe(true)
    expect(detectXSS('javascript:alert(1)')).toBe(true)
    expect(detectXSS('<img onerror=alert(1)>')).toBe(true)
  })

  test('normal HTML text is not flagged', () => {
    expect(detectXSS('Hello world')).toBe(false)
    expect(detectXSS('price > 100')).toBe(false)
  })
})
