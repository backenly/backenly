/**
 * The Supabase compat shim must not be weaker than the platform underneath it.
 *
 * It used to compose Backenly's translated filter dialect, which made it refuse
 * four things Postgres does perfectly well through PostgREST:
 *
 *   .or()                      → "not supported (Backenly composes AND filters)"
 *   select('*, author(*)')     → "embeds are not supported by the compat shim"
 *   .overlaps()                → not implemented at all
 *   upsert(v, { onConflict })  → accepted and silently ignored
 *
 * The two it refused loudest are the two a Supabase migrant needs most. These
 * tests assert the emitted PostgREST request for each, so a regression to the
 * old dialect fails here rather than in somebody's migration.
 */

import { BackenlySupabaseCompat } from '@backenly/sdk/supabase'

interface Captured {
  path: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * A BackenlyClient stand-in that records the request instead of sending it. The
 * shim only reaches the client through `getProjectId()` and `rawRequest()`, which
 * is what makes this substitution honest rather than a mock of everything.
 */
function harness(response?: { status?: number; body?: unknown; contentRange?: string }) {
  const calls: Captured[] = []
  const client = {
    getProjectId: () => 'proj-1',
    rawRequest: async (path: string, options: any) => {
      calls.push({
        path,
        method: options?.method ?? 'GET',
        headers: (options?.headers ?? {}) as Record<string, string>,
        body: options?.body,
      })
      const status = response?.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: { get: (h: string) => (h.toLowerCase() === 'content-range' ? response?.contentRange ?? null : null) },
        text: async () => JSON.stringify(response?.body ?? []),
      } as unknown as Response
    },
  }
  const sb = new BackenlySupabaseCompat(client as any)
  return { sb, calls }
}

/** Decode the query string into ordered [key, value] pairs. */
function params(path: string): Array<[string, string]> {
  const qs = path.split('?')[1] ?? ''
  return qs
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))] as [string, string]
    })
}

function valueOf(path: string, key: string): string | undefined {
  return params(path).find(([k]) => k === key)?.[1]
}

describe('compat shim targets /api/v2 (PostgREST), not the translated dialect', () => {
  it('issues a GET against /api/v2/{projectId}/{table}', async () => {
    const { sb, calls } = harness()
    await sb.from('posts').select()
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path.split('?')[0]).toBe('/api/v2/proj-1/posts')
  })
})

describe('P1-11: .or() is supported', () => {
  it('emits or=(…) instead of refusing', async () => {
    const { sb, calls } = harness()
    const res = await sb.from('profiles').select().or('is_public.eq.true,user_id.eq.7')
    expect(res.error).toBeNull()
    expect(valueOf(calls[0].path, 'or')).toBe('(is_public.eq.true,user_id.eq.7)')
  })

  it('scopes a disjunction to an embedded resource', async () => {
    const { sb, calls } = harness()
    await sb.from('posts').select('*, author(*)').or('name.eq.a,name.eq.b', { referencedTable: 'author' })
    expect(valueOf(calls[0].path, 'author.or')).toBe('(name.eq.a,name.eq.b)')
  })

  it('composes .or() together with .eq() in chain order', async () => {
    const { sb, calls } = harness()
    await sb.from('posts').select().eq('published', true).or('a.eq.1,b.eq.2')
    expect(params(calls[0].path).filter(([k]) => k !== 'select')).toEqual([
      ['published', 'eq.true'],
      ['or', '(a.eq.1,b.eq.2)'],
    ])
  })
})

describe('P1-11: embedded resources pass through', () => {
  it('sends select=*,author(*) verbatim instead of refusing', async () => {
    const { sb, calls } = harness()
    const res = await sb.from('posts').select('*, author(*)')
    expect(res.error).toBeNull()
    expect(valueOf(calls[0].path, 'select')).toBe('*, author(*)')
  })

  it('passes a plain column projection through', async () => {
    const { sb, calls } = harness()
    await sb.from('posts').select('id,title')
    expect(valueOf(calls[0].path, 'select')).toBe('id,title')
  })
})

describe('P1-11: .overlaps() is implemented', () => {
  it('emits the ov operator with a PostgREST array literal', async () => {
    const { sb, calls } = harness()
    const res = await sb.from('posts').select().overlaps('tags', ['sql', 'rls'])
    expect(res.error).toBeNull()
    expect(valueOf(calls[0].path, 'tags')).toBe('ov.{sql,rls}')
  })

  it('supports contains and containedBy on arrays and jsonb', async () => {
    const { sb, calls } = harness()
    await sb.from('posts').select().contains('tags', ['sql']).containedBy('meta', { a: 1 })
    expect(valueOf(calls[0].path, 'tags')).toBe('cs.{sql}')
    expect(valueOf(calls[0].path, 'meta')).toBe('cd.{"a":1}')
  })
})

describe('P1-11: upsert honours onConflict', () => {
  it('sends on_conflict and Prefer: resolution=merge-duplicates', async () => {
    const { sb, calls } = harness({ status: 201, body: [{ id: 1 }] })
    await sb.from('profiles').upsert({ user_id: 7, bio: 'hi' }, { onConflict: 'user_id' })
    expect(calls[0].method).toBe('POST')
    expect(valueOf(calls[0].path, 'on_conflict')).toBe('user_id')
    expect(calls[0].headers.Prefer).toContain('resolution=merge-duplicates')
  })

  it('honours ignoreDuplicates', async () => {
    const { sb, calls } = harness({ status: 201, body: [] })
    await sb.from('profiles').upsert({ user_id: 7 }, { onConflict: 'user_id', ignoreDuplicates: true })
    expect(calls[0].headers.Prefer).toContain('resolution=ignore-duplicates')
  })
})

describe('filters map one-to-one onto PostgREST operators', () => {
  it('covers the comparison set', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().neq('a', 1).gt('b', 2).gte('c', 3).lt('d', 4).lte('e', 5)
    const p = Object.fromEntries(params(calls[0].path))
    expect(p).toMatchObject({ a: 'neq.1', b: 'gt.2', c: 'gte.3', d: 'lt.4', e: 'lte.5' })
  })

  it('quotes a value containing a comma so it stays ONE filter', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().eq('title', 'a,b')
    expect(valueOf(calls[0].path, 'title')).toBe('eq."a,b"')
  })

  it('emits in.(…) for a list', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().in('status', ['draft', 'live'])
    expect(valueOf(calls[0].path, 'status')).toBe('in.(draft,live)')
  })

  it('emits is.null rather than an equality against null', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().is('deleted_at', null)
    expect(valueOf(calls[0].path, 'deleted_at')).toBe('is.null')
  })

  it('supports not() and match()', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().not('status', 'eq', 'draft').match({ a: 1, b: 2 })
    const p = Object.fromEntries(params(calls[0].path))
    expect(p.status).toBe('not.eq.draft')
    expect(p.a).toBe('eq.1')
    expect(p.b).toBe('eq.2')
  })

  it('supports full-text search', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().textSearch('body', 'postgres', { type: 'websearch' })
    expect(valueOf(calls[0].path, 'body')).toBe('wfts.postgres')
  })
})

describe('modifiers', () => {
  it('emits order with direction and nulls placement', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().order('created_at', { ascending: false, nullsFirst: false })
    expect(valueOf(calls[0].path, 'order')).toBe('created_at.desc.nullslast')
  })

  it('turns range(from,to) into limit + offset', async () => {
    const { sb, calls } = harness()
    await sb.from('t').select().range(10, 19)
    expect(valueOf(calls[0].path, 'limit')).toBe('10')
    expect(valueOf(calls[0].path, 'offset')).toBe('10')
  })

  it('reads the exact count out of Content-Range', async () => {
    const { sb } = harness({ body: [{ id: 1 }], contentRange: '0-0/573' })
    const res = await sb.from('t').select('*', { count: 'exact' })
    expect(res.count).toBe(573)
  })
})

describe('single() / maybeSingle()', () => {
  it('asks for two rows so "more than one" stays detectable', async () => {
    const { sb, calls } = harness({ body: [{ id: 1 }] })
    await sb.from('t').select().eq('id', 1).single()
    expect(valueOf(calls[0].path, 'limit')).toBe('2')
  })

  it('errors PGRST116 on zero rows for single()', async () => {
    const { sb } = harness({ body: [] })
    const res = await sb.from('t').select().eq('id', 1).single()
    expect(res.error?.code).toBe('PGRST116')
  })

  it('returns null without an error for maybeSingle() on zero rows', async () => {
    const { sb } = harness({ body: [] })
    const res = await sb.from('t').select().eq('id', 1).maybeSingle()
    expect(res.data).toBeNull()
    expect(res.error).toBeNull()
  })

  // Returning the first of several rows would be a WRONG ANSWER, not a
  // convenience — supabase-js errors here and so must this.
  it('errors when single() matches more than one row', async () => {
    const { sb } = harness({ body: [{ id: 1 }, { id: 2 }] })
    const res = await sb.from('t').select().single()
    expect(res.error?.code).toBe('PGRST116')
    expect(res.data).toBeNull()
  })
})

describe('writes', () => {
  it('PATCHes an update and requires a filter', async () => {
    const { sb, calls } = harness({ body: [{ id: 1 }] })
    const noFilter = await sb.from('t').update({ a: 1 })
    expect(noFilter.error?.code).toBe('NO_FILTER')
    expect(calls).toHaveLength(0)

    await sb.from('t').update({ a: 1 }).eq('id', 5)
    expect(calls[0].method).toBe('PATCH')
    expect(valueOf(calls[0].path, 'id')).toBe('eq.5')
    expect(calls[0].body).toBe(JSON.stringify({ a: 1 }))
  })

  it('DELETEs with a filter and refuses without one', async () => {
    const { sb, calls } = harness({ body: [] })
    expect((await sb.from('t').delete()).error?.code).toBe('NO_FILTER')
    await sb.from('t').delete().eq('id', 5)
    expect(calls[0].method).toBe('DELETE')
  })

  it('asks for the written rows back', async () => {
    const { sb, calls } = harness({ status: 201, body: [{ id: 1 }] })
    await sb.from('t').insert({ a: 1 })
    expect(calls[0].headers.Prefer).toContain('return=representation')
  })
})

describe('errors keep their PostgREST structure', () => {
  it('passes message/code/details/hint through instead of flattening them', async () => {
    const { sb } = harness({
      status: 403,
      body: { message: 'permission denied for table users', code: '42501', details: null, hint: 'check RLS' },
    })
    const res = await sb.from('users').select()
    expect(res.error).toEqual({
      message: 'permission denied for table users',
      code: '42501',
      details: null,
      hint: 'check RLS',
    })
    expect(res.status).toBe(403)
    expect(res.data).toBeNull()
  })

  it('never throws — every path resolves { data, error }', async () => {
    const { sb } = harness({ status: 500, body: {} })
    await expect(sb.from('t').select()).resolves.toMatchObject({ data: null })
  })
})

describe('rpc stays refused, and is now the ONLY refusal', () => {
  it('names the Backenly equivalent', async () => {
    const { sb } = harness()
    const res = await sb.rpc('my_fn')
    expect(res.error?.code).toBe('UNSUPPORTED')
    expect(res.error?.message).toMatch(/HTTP AI function/)
  })
})
