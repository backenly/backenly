/**
 * The defect these tests exist for: /api/mcp/db/* used a non-strict z.object(),
 * so Zod silently dropped undeclared keys. `db_query {table, groupBy, select}`
 * returned HTTP 200 / ok:true with raw rows — a wrong answer wearing a success
 * code, which an agent cannot detect and will build on.
 *
 * Every case below has a paired assertion that the parser is provably able to
 * fire, so a green suite can never mean "the check never ran".
 */

import { z } from 'zod'
import { parseMcpBody } from '@/lib/mcp/request-body'

const QuerySchema = z.object({
  table: z.string().trim().min(1).max(63),
  filter: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  orderBy: z.record(z.unknown()).optional(),
})

describe('parseMcpBody', () => {
  it('accepts a well-formed body', () => {
    const r = parseMcpBody(QuerySchema, { table: 'posts', limit: 10 }, 'db_query')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.table).toBe('posts')
  })

  it('REGRESSION: set-based keys are rejected, not silently stripped', () => {
    const r = parseMcpBody(
      QuerySchema,
      { table: 'g_categories', select: 'count(*)', groupBy: 'name' },
      'db_query',
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.code).toBe('UNSUPPORTED_PARAMS')
    expect(r.error.unsupported).toEqual(expect.arrayContaining(['select', 'groupBy']))
  })

  it('routes set-based intent to the surface that can serve it', () => {
    const r = parseMcpBody(QuerySchema, { table: 't', join: 'authors' }, 'db_query')
    if (r.ok) throw new Error('expected rejection')
    // The hint is the difference between a dead end and a one-turn recovery.
    expect(r.error.hint).toMatch(/run_query/)
  })

  it('does not send the agent off to provision a Postgres role for a read', () => {
    // The hint used to route to get_database_credentials + "run SQL over the
    // returned connection string". That was right before run_query existed and
    // was never updated when it shipped — a confidently wrong hint that cost a
    // whole turn. Pinned so it cannot regress.
    const r = parseMcpBody(QuerySchema, { table: 't', groupBy: 'name' }, 'db_query')
    if (r.ok) throw new Error('expected rejection')
    expect(r.error.hint).not.toMatch(/get_database_credentials/)
  })

  it('names unknown non-set-based keys and lists what IS accepted', () => {
    const r = parseMcpBody(QuerySchema, { table: 't', limitt: 5 }, 'db_query')
    if (r.ok) throw new Error('expected rejection')
    expect(r.error.code).toBe('UNKNOWN_PARAMS')
    expect(r.error.unsupported).toEqual(['limitt'])
    expect(r.error.supported).toEqual(expect.arrayContaining(['table', 'filter', 'limit']))
  })

  it('keeps nested records free-form — column names are user data', () => {
    const r = parseMcpBody(
      QuerySchema,
      { table: 't', filter: { anything_at_all: 1, groupBy: 'not a param here' } },
      'db_query',
    )
    expect(r.ok).toBe(true)
  })

  it('still reports ordinary validation failures', () => {
    const r = parseMcpBody(QuerySchema, { table: '' }, 'db_query')
    if (r.ok) throw new Error('expected rejection')
    expect(r.error.code).toBe('BAD_BODY')
  })

  it('handles a null body (unparseable JSON) without throwing', () => {
    const r = parseMcpBody(QuerySchema, null, 'db_query')
    expect(r.ok).toBe(false)
  })

  it('is case-insensitive about set-based keys', () => {
    const r = parseMcpBody(QuerySchema, { table: 't', GROUP_BY: 'x' }, 'db_query')
    if (r.ok) throw new Error('expected rejection')
    expect(r.error.code).toBe('UNSUPPORTED_PARAMS')
  })
})
