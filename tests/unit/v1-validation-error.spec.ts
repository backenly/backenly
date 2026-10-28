/**
 * AN INVALID REQUEST TO THE V1 DATA ROUTES IS A 400
 * =================================================
 * The v1 data routes (database query, insert, update and delete, functions
 * invoke, ai generate) pass handleValidationError the message
 * validateRequestBody built, a string. It used to read `error.errors` from that
 * string and throw, so a request asking for more than the 100-row page, say,
 * answered 500 "Failed to execute database query".
 */

import '../helpers/real-web-standard'

import { z } from 'zod'
import { handleValidationError } from '@/lib/api/v1/errors'
import { querySchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'

describe('a validation error', () => {
  it('answers 400 with the message the routes pass', async () => {
    const request = new Request('http://localhost/api/v1/p/database/query', {
      method: 'POST',
      body: JSON.stringify({ table: 'notes', limit: 1000 }),
      headers: { 'content-type': 'application/json' },
    })
    const validation = await validateRequestBody(querySchema, request)
    expect(validation.success).toBe(false)
    const res = handleValidationError((validation as { success: false; error: string }).error)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/limit/)
  })

  it('keeps per-field detail for a ZodError', async () => {
    const parsed = z.object({ limit: z.number().max(100) }).safeParse({ limit: 1000 })
    expect(parsed.success).toBe(false)
    const res = handleValidationError((parsed as { success: false; error: z.ZodError }).error)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.fields.limit).toHaveLength(1)
  })
})
