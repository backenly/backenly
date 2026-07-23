/**
 * Contract tests for the PostgREST translation layer.
 *
 * These assert the things that break QUIETLY. A wrong status code is reported by
 * the first caller who sees it; a missing soft-delete predicate serves deleted
 * rows to everyone and is reported by nobody.
 */

import {
  encodeFilterValue,
  parseContentRange,
  toApiError,
  toListEnvelope,
  toRecordEnvelope,
  translateReadQuery,
  stripUpstreamError,
} from '@/lib/postgrest/translate'
import { isOperationEnabled, operationFor } from '@/lib/postgrest/exposure'

describe('translateReadQuery — soft delete', () => {
  it('hides soft-deleted rows on every read of a soft-delete table', () => {
    const { search } = translateReadQuery({ query: {}, hasSoftDelete: true })
    expect(search).toContain('deleted_at=is.null')
  })

  it('lifts the predicate only for an explicit include_deleted=true', () => {
    const on = translateReadQuery({ query: { include_deleted: 'true' }, hasSoftDelete: true })
    expect(on.search).not.toContain('deleted_at')

    // Anything other than the exact opt-in keeps rows hidden — "1", "yes" and a
    // bare flag must not be enough to expose deleted data.
    for (const v of ['1', 'yes', 'TRUE', '']) {
      const off = translateReadQuery({ query: { include_deleted: v }, hasSoftDelete: true })
      expect(off.search).toContain('deleted_at=is.null')
    }
  })

  it('does not add the predicate to tables without deleted_at', () => {
    const { search } = translateReadQuery({ query: {}, hasSoftDelete: false })
    expect(search).not.toContain('deleted_at')
  })

  it('applies the predicate to single-record fetches too', () => {
    // A get-by-id that skipped the filter would resurrect one deleted row —
    // exactly the row someone might probe for.
    const { search } = translateReadQuery({
      query: {},
      hasSoftDelete: true,
      recordId: '11111111-1111-1111-1111-111111111111',
    })
    expect(search).toContain('deleted_at=is.null')
  })
})

describe('translateReadQuery — grammar', () => {
  it('converts bare equality to PostgREST operator form', () => {
    const { search } = translateReadQuery({ query: { status: 'paid' }, hasSoftDelete: false })
    expect(search).toContain('status=eq.paid')
  })

  it('collapses sort+order into PostgREST order syntax', () => {
    const desc = translateReadQuery({
      query: { sort: 'created_at', order: 'desc' },
      hasSoftDelete: false,
    })
    expect(desc.search).toContain(`order=${encodeURIComponent('created_at.desc')}`)

    const asc = translateReadQuery({ query: { sort: 'created_at' }, hasSoftDelete: false })
    expect(asc.search).toContain(`order=${encodeURIComponent('created_at.asc')}`)
  })

  it('drops keys that are not valid identifiers', () => {
    // The legacy executor ignored these. Forwarding them would turn a
    // previously-inert param into a live predicate.
    const { search } = translateReadQuery({
      query: { 'x;DROP': 'v', 'a b': 'v', "or'1'='1": 'v' },
      hasSoftDelete: false,
    })
    expect(search).not.toContain('DROP')
    expect(search).not.toContain('a b')
    expect(search).not.toContain("or'")
  })

  it('does not treat reserved control params as column filters', () => {
    const { search } = translateReadQuery({
      query: { limit: '10', offset: '5', sort: 'id', page: '2', cursor: 'abc' },
      hasSoftDelete: false,
    })
    expect(search).not.toContain('page=eq.')
    expect(search).not.toContain('cursor=eq.')
    expect(search).not.toContain('limit=eq.')
  })

  it('clamps limit and rejects nonsense values', () => {
    expect(translateReadQuery({ query: { limit: '999999' }, hasSoftDelete: false }).limit).toBe(1000)
    expect(translateReadQuery({ query: { limit: '-5' }, hasSoftDelete: false }).limit).toBe(50)
    expect(translateReadQuery({ query: { limit: 'abc' }, hasSoftDelete: false }).limit).toBe(50)
    expect(translateReadQuery({ query: { offset: '-1' }, hasSoftDelete: false }).offset).toBe(0)
  })

  it('takes the first value when a param is repeated', () => {
    // ?status=a&status=b arrives as an array; picking the array itself would
    // stringify to "a,b" and become a different predicate than either.
    const { search } = translateReadQuery({
      query: { status: ['paid', 'unpaid'] },
      hasSoftDelete: false,
    })
    expect(search).toContain('status=eq.paid')
    expect(search).not.toContain('unpaid')
  })
})

describe('encodeFilterValue', () => {
  it('leaves ordinary values untouched', () => {
    expect(encodeFilterValue('paid')).toBe('paid')
    expect(encodeFilterValue('a-b_c')).toBe('a-b_c')
  })

  it('quotes values containing PostgREST syntax characters', () => {
    // Unquoted, a comma would be read as a value separator and a dot as the
    // operator delimiter — both change the meaning of the filter.
    expect(encodeFilterValue('a,b')).toBe('"a,b"')
    expect(encodeFilterValue('1.5')).toBe('"1.5"')
    expect(encodeFilterValue('(x)')).toBe('"(x)"')
  })

  it('escapes quotes and backslashes so a value cannot break out', () => {
    expect(encodeFilterValue('a"b')).toBe('"a\\"b"')
    expect(encodeFilterValue('a\\b')).toBe('"a\\\\b"')
    // The payload that would otherwise close the quoted region and append an
    // operator of the attacker's choosing.
    expect(encodeFilterValue('x",role.eq.admin')).toBe('"x\\",role.eq.admin"')
  })
})

describe('pagination envelope', () => {
  it('parses Content-Range totals', () => {
    expect(parseContentRange('0-24/573')).toBe(573)
    expect(parseContentRange('*/0')).toBe(0)
  })

  it('returns null when the count is unavailable', () => {
    expect(parseContentRange('0-24/*')).toBeNull()
    expect(parseContentRange(null)).toBeNull()
    expect(parseContentRange('')).toBeNull()
  })

  it('reproduces the legacy {data,pagination} shape', () => {
    // Asserted with toEqual, not toMatchObject: a MISSING field is the failure
    // mode here. The parity verifier caught nextCursor being absent while every
    // unit test passed, because the tests asserted the fields I remembered
    // rather than the fields the old engine actually returns.
    const env = toListEnvelope([{ id: 1 }, { id: 2 }], '0-1/57', 2, 0)
    expect(env.data).toHaveLength(2)
    expect(env.pagination).toEqual({
      total: 57, limit: 2, offset: 0, hasMore: true, nextCursor: 2,
    })
  })

  it('emits nextCursor: null rather than omitting it on the last page', () => {
    // undefined and null are different to a client that checks the field.
    const env = toListEnvelope([{ id: 3 }], '2-2/3', 2, 2)
    expect(env.pagination.nextCursor).toBeNull()
    expect('nextCursor' in env.pagination).toBe(true)
  })

  it('carries the last row id as the cursor when more pages remain', () => {
    const env = toListEnvelope([{ id: 'a' }, { id: 'b' }], '0-1/9', 2, 0)
    expect(env.pagination.nextCursor).toBe('b')
  })

  it('reports hasMore=false on the final page', () => {
    const env = toListEnvelope([{ id: 3 }], '2-2/3', 2, 2)
    expect(env.pagination.hasMore).toBe(false)
  })

  it('infers hasMore from a full page when the total is unknown', () => {
    // Claiming "no more rows" without knowing would stop a paginating client
    // early and silently truncate its results.
    const full = toListEnvelope([{ id: 1 }, { id: 2 }], null, 2, 0)
    expect(full.pagination.hasMore).toBe(true)

    const partial = toListEnvelope([{ id: 1 }], null, 2, 0)
    expect(partial.pagination.hasMore).toBe(false)
  })
})

describe('toApiError', () => {
  it('maps constraint SQLSTATEs to the statuses the old executor used', () => {
    expect(toApiError(400, { code: '23505', message: 'dup' }).status).toBe(409)
    expect(toApiError(400, { code: '23503', message: 'fk' }).status).toBe(409)
    expect(toApiError(400, { code: '23502', message: 'null' }).status).toBe(400)
    expect(toApiError(400, { code: '42P01', message: 'no table' }).status).toBe(404)
  })

  it('does not echo PostgREST wording for authorization failures', () => {
    // PostgREST names the role and the policy; a caller learning that
    // `service_role` exists, or which policy denied them, is a free hint.
    const res = toApiError(403, { code: '42501', message: 'permission denied for table users' })
    expect(res.body.error).not.toMatch(/users|role|policy/i)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('never surfaces internal detail on a 5xx', () => {
    const res = toApiError(500, { message: 'connection to server at "10.0.0.5" failed' })
    expect(res.body.error).toBe('Internal server error')
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5')
  })
})

describe('operation mapping', () => {
  it('names operations the way the legacy executor did', () => {
    expect(operationFor('GET', false)).toBe('list')
    expect(operationFor('GET', true)).toBe('get')
    expect(operationFor('POST', false)).toBe('create')
    expect(operationFor('PATCH', true)).toBe('update')
    expect(operationFor('DELETE', true)).toBe('delete')
  })

  it('refuses unbounded update and delete', () => {
    // A PATCH or DELETE with no record id would apply to every row the caller
    // can see. The legacy executor required an id; so does this.
    expect(operationFor('PATCH', false)).toBeNull()
    expect(operationFor('DELETE', false)).toBeNull()
  })
})

describe('isOperationEnabled', () => {
  it('reads every stored shape of the operations field', () => {
    expect(isOperationEnabled(['GET', 'POST'], 'list')).toBe(true)
    expect(isOperationEnabled([{ method: 'DELETE' }], 'delete')).toBe(true)
    expect(isOperationEnabled({ get: true, delete: false }, 'list')).toBe(true)
  })

  it('denies when the operation is absent or switched off', () => {
    expect(isOperationEnabled(['GET'], 'delete')).toBe(false)
    expect(isOperationEnabled({ delete: false }, 'delete')).toBe(false)
  })

  it('denies on an unreadable value rather than allowing', () => {
    // A stored value this code cannot parse is not evidence of permission.
    expect(isOperationEnabled(null, 'list')).toBe(false)
    expect(isOperationEnabled(undefined, 'list')).toBe(false)
    expect(isOperationEnabled('everything', 'list')).toBe(false)
    expect(isOperationEnabled([], 'list')).toBe(false)
  })
})

describe('record envelopes', () => {
  it('keeps the legacy messages so clients asserting on them still pass', () => {
    expect(toRecordEnvelope({ id: 1 }, 'created').message).toBe('Record created successfully')
    expect(toRecordEnvelope({ id: 1 }, 'updated').message).toBe('Record updated successfully')
    expect(toRecordEnvelope({ id: 1 }, 'fetched').message).toBeUndefined()
  })
})

/**
 * ── PGRST106 must not be a 4xx, and must not echo PostgREST's message ────────
 *
 * PostgREST answers a request for an unregistered schema with
 *
 *   406  {"code":"PGRST106","message":"Invalid schema: workspace_<id>. Only the
 *         following schemas are exposed: workspace_<a>, workspace_<b>, ..."}
 *
 * Two independent failures came out of passing that through:
 *
 *  1. A server-side provisioning gap was reported as the caller's fault — 406
 *     with code BAD_REQUEST, which is also self-contradictory (406 says the
 *     representation was unacceptable, BAD_REQUEST says the request was
 *     malformed). Every reader, human and agent, went to debug the client. One
 *     did, for a whole build, before rewriting their data layer around it.
 *
 *  2. That message enumerates every OTHER tenant's schema. A real user's
 *     unrelated key was handed four other customers' project ids.
 */
describe('toApiError — data-plane provisioning errors', () => {
  it('maps PGRST106 to 503, never a 4xx', () => {
    const out = toApiError(406, {
      code: 'PGRST106',
      message:
        'Invalid schema: workspace_7e65d1a8-38d1-4130-9cef-48bdf5a5d370. Only the following ' +
        'schemas are exposed: workspace_ce18214a-51bc-42cf-8b69-ffaf495234b0, ' +
        'workspace_07339e54-7b07-4b09-bbf6-5954204d5792',
    })
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('DATA_PLANE_PROVISIONING')
  })

  it('leaks no schema name from the PGRST106 message', () => {
    const out = toApiError(406, {
      code: 'PGRST106',
      message:
        'Invalid schema: workspace_mine. Only the following schemas are exposed: ' +
        'workspace_ce18214a-51bc-42cf-8b69-ffaf495234b0, workspace_07339e54',
    })
    const serialised = JSON.stringify(out.body)
    expect(serialised).not.toMatch(/workspace_/)
    expect(serialised).not.toMatch(/ce18214a/)
    expect(serialised).not.toMatch(/Only the following schemas/)
  })

  it('tells the caller it is not their fault', () => {
    const out = toApiError(406, { code: 'PGRST106', message: 'Invalid schema: x' })
    expect(JSON.stringify(out.body)).toMatch(/not a problem with your request or your key/i)
  })

  it('maps PGRST002 (wedged schema cache) to 503', () => {
    const out = toApiError(503, {
      code: 'PGRST002',
      message: 'Could not query the database for the schema cache. Retrying.',
    })
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('DATA_PLANE_UNAVAILABLE')
  })

  it('never reports a bare 406 as a client error', () => {
    const out = toApiError(406, {})
    expect(out.status).toBe(503)
    expect(out.body.code).not.toBe('BAD_REQUEST')
  })

  it('still reports real constraint violations as the caller\'s 4xx', () => {
    // The fix must not swallow errors that ARE about the request.
    const out = toApiError(400, {
      code: '23514',
      message: 'new row for relation "orders" violates check constraint "chk_orders_payment_status"',
    })
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('DB_CONSTRAINT_ERROR')
    expect(out.body.error).toMatch(/check constraint/)
  })
})

/**
 * v2 forwards PostgREST's response verbatim — that is its entire purpose, and
 * it stays true for SUCCESS bodies. ERROR bodies are written for an operator
 * who owns the instance, and one of them lists every tenant.
 */
describe('stripUpstreamError — v2 passthrough', () => {
  it('refuses to forward the PGRST106 schema list', () => {
    const out = stripUpstreamError(406, {
      code: 'PGRST106',
      message: 'Invalid schema: workspace_a. Only the following schemas are exposed: workspace_b, workspace_c',
    })
    expect(out.status).toBe(503)
    expect(JSON.stringify(out.body)).not.toMatch(/workspace_/)
  })

  it('keeps PostgREST\'s shape so its clients still parse the error', () => {
    const out = stripUpstreamError(400, {
      code: '23505',
      message: 'duplicate key value violates unique constraint "users_email_key"',
      details: 'Key (email)=(a@b.c) already exists.',
    })
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('23505')
    expect(out.body.message).toMatch(/duplicate key/)
    expect(out.body.details).toMatch(/already exists/)
  })

  it('reduces a privilege error to FORBIDDEN without naming the table', () => {
    const out = stripUpstreamError(403, {
      code: '42501',
      message: 'permission denied for table users',
    })
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('FORBIDDEN')
    expect(JSON.stringify(out.body)).not.toMatch(/users/)
  })

  it('reduces anything unrecognised rather than forwarding it', () => {
    const out = stripUpstreamError(500, {
      code: 'XX000',
      message: 'internal error: connection to backenly_authenticator@10.0.0.4 failed',
    })
    expect(JSON.stringify(out.body)).not.toMatch(/backenly_authenticator|10\.0\.0\.4/)
  })
})
