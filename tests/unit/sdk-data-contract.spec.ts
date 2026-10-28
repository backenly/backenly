/**
 * THE SDK RETURNS WHAT ITS METHODS PROMISE, FROM WHAT THE ROUTES ANSWER
 * =====================================================================
 * Each data route answers `{ data: <result> }`, and each result carries its
 * rows under a `data` of its own (packages/sdk/src/database.ts lists them).
 * create() and update() returned the result, so `(await create(...)).id` was
 * undefined. delete() and the query builder returned the whole answer. A
 * refused storage upload threw "[object Object]", because it built its error
 * from `body.error`, which is an object in the API's error shape.
 *
 * The network here is a stub that answers each route with the body its handler
 * builds (app/api/v1/[projectId]/database/*, storage/upload). That is the
 * client's contract with the API, and nothing in it is a database.
 * tests/integration/sdk-data-routes.spec.ts drives the same methods through the
 * real routes and a real database.
 */
import '@/tests/helpers/real-web-standard'

import { BackenlyClient, BackenlyError, type TableClient } from '@backenly/sdk'

const PROJECT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const API = 'https://backenly.test'
const KEY = 'proj_live_contract_test_not_a_real_key'

interface Post {
  id: string
  title: string
  done: boolean
}

const ROW: Post = { id: '0b8c4f1e-2d3a-4b5c-9d6e-7f8091a2b3c4', title: 'Hello', done: false }
const ROW_2: Post = { id: '1c9d5a2f-3e4b-4c6d-8e7f-90a1b2c3d4e5', title: 'World', done: false }

/** A route's answer: the JSON its handler builds, or a body that is not JSON. */
interface Answer {
  status?: number
  body?: unknown
  text?: string
}

/** The bodies the routes build, as createSuccessResponse(<result>) sends them. */
const ANSWERS: Record<'insertOne' | 'insertMany' | 'update' | 'delete' | 'query' | 'queryNone', Answer> = {
  insertOne: { body: { data: { data: ROW } } },
  insertMany: { body: { data: { data: [ROW, ROW_2] } } },
  update: { body: { data: { data: { ...ROW, done: true }, updated: 1 } } },
  delete: { body: { data: { success: true, deleted: 1 } } },
  query: { body: { data: { data: [ROW, ROW_2], count: 2 }, meta: { limit: 100, page: 0, total: 2, hasMore: false } } },
  queryNone: { body: { data: { data: [], count: 0 }, meta: { limit: 1, page: 0, total: 0, hasMore: false } } },
}

interface Sent {
  path: string
  method: string
  body: unknown
}

let sent: Sent[] = []
const realFetch = globalThis.fetch

/** Answer each path under /api/v1/{projectId} as its route does, and record what was sent. */
function serve(answers: Record<string, Answer>): void {
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(`/api/v1/${PROJECT}`, '')
    sent.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    const answer = answers[path]
    if (!answer) throw new Error(`no answer for ${path}`)
    return answer.text !== undefined
      ? new Response(answer.text, { status: answer.status ?? 200, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const client = () =>
  new BackenlyClient({ projectId: PROJECT, apiKey: KEY, apiUrl: API }) as BackenlyClient & { posts: TableClient<Post> }

describe('the table methods return what they promise', () => {
  it('create() returns the inserted row', async () => {
    serve({ '/database/insert': ANSWERS.insertOne })
    const row = await client().posts.create({ title: 'Hello' })
    expect(row).toEqual(ROW)
    expect(row.id).toBe(ROW.id)
    expect(sent).toEqual([
      { path: '/database/insert', method: 'POST', body: { table: 'posts', data: { title: 'Hello' } } },
    ])
  })

  it('create() with several rows returns the rows', async () => {
    serve({ '/database/insert': ANSWERS.insertMany })
    const rows = await client().posts.create([{ title: 'Hello' }, { title: 'World' }] as unknown as Partial<Post>)
    expect(rows).toEqual([ROW, ROW_2])
  })

  it('update() returns the updated row', async () => {
    serve({ '/database/update': ANSWERS.update })
    const row = await client().posts.update(ROW.id, { done: true })
    expect(row).toEqual({ ...ROW, done: true })
    expect(sent[0].body).toEqual({ table: 'posts', data: { done: true }, where: { id: ROW.id } })
  })

  it('delete() resolves success and how many rows went', async () => {
    serve({ '/database/delete': ANSWERS.delete })
    const result = await client().posts.delete(ROW.id)
    expect(result).toEqual({ success: true, deleted: 1 })
    expect(result.success).toBe(true)
  })

  it('list(), get() and count() read the rows and the count inside the query result', async () => {
    serve({ '/database/query': ANSWERS.query })
    const posts = client().posts
    expect(await posts.list()).toEqual([ROW, ROW_2])
    expect(await posts.get(ROW.id)).toEqual(ROW)
    expect(await posts.count()).toBe(2)
  })

  it('get() returns null when no row matches', async () => {
    serve({ '/database/query': ANSWERS.queryNone })
    expect(await client().posts.get(ROW.id)).toBeNull()
  })
})

describe('the query builder resolves the route result, not the whole answer', () => {
  it('a select resolves { data: rows, count }', async () => {
    serve({ '/database/query': ANSWERS.query })
    const result = await client().from<Post>('posts').select().eq('done', false)
    expect(result).toEqual({ data: [ROW, ROW_2], count: 2 })
  })

  it('an insert resolves { data: row } for one row and { data: rows } for several', async () => {
    serve({ '/database/insert': ANSWERS.insertOne })
    expect(await client().from<Post>('posts').insert({ title: 'Hello' } as Post).execute()).toEqual({ data: ROW })

    serve({ '/database/insert': ANSWERS.insertMany })
    expect(await client().from<Post>('posts').insert([{ title: 'Hello' }, { title: 'World' }] as Post[]).execute())
      .toEqual({ data: [ROW, ROW_2] })
  })

  it('an update resolves the updated row and how many', async () => {
    serve({ '/database/update': ANSWERS.update })
    const result = await client().from<Post>('posts').update({ done: true }).eq('id', ROW.id).execute()
    expect(result).toEqual({ data: { ...ROW, done: true }, updated: 1 })
  })

  it('a delete resolves success and how many rows went', async () => {
    serve({ '/database/delete': ANSWERS.delete })
    const result = await client().from<Post>('posts').delete().eq('id', ROW.id).execute()
    expect(result).toEqual({ success: true, deleted: 1 })
  })
})

describe('storage upload', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })

  it('resolves the stored file', async () => {
    serve({
      '/storage/upload': {
        body: {
          data: {
            id: 'f-1', bucket: 'avatars', path: 'u1/avatar.png', url: `/api/v1/${PROJECT}/storage/files/f-1`,
            size: 3, contentType: 'image/png', isPublic: false,
          },
        },
      },
    })
    const stored = await client().storage.upload(file(), 'u1/avatar.png', { bucket: 'avatars' })
    expect(stored).toEqual({
      id: 'f-1', path: 'u1/avatar.png', url: `/api/v1/${PROJECT}/storage/files/f-1`, size: 3, contentType: 'image/png',
    })
  })

  it("a refusal keeps the API's message, code, status and details", async () => {
    serve({
      '/storage/upload': {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: { required: ['write', 'admin'] } } },
      },
    })
    const error = await client().storage.upload(file(), 'u1/avatar.png').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackenlyError)
    expect((error as BackenlyError).message).toBe('Insufficient permissions')
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403, details: { required: ['write', 'admin'] } })
  })

  it('a failure whose body is not JSON names the status', async () => {
    serve({ '/storage/upload': { status: 502, text: '<html>Bad Gateway</html>' } })
    const error = await client().storage.upload(file(), 'u1/avatar.png').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackenlyError)
    expect(error).toMatchObject({ message: 'Upload failed with status 502', status: 502 })
  })
})

describe('a refused data call keeps the API error', () => {
  it("keeps the API's message, code, status and details", async () => {
    serve({
      '/database/insert': {
        status: 422,
        body: { error: { code: 'VALIDATION_ERROR', message: "Column 'title' is required", details: { fields: { title: ['required'] } } } },
      },
    })
    const error = await client().posts.create({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackenlyError)
    expect(error).toMatchObject({
      message: "Column 'title' is required",
      code: 'VALIDATION_ERROR',
      status: 422,
      details: { fields: { title: ['required'] } },
    })
  })

  it('reads the older { error: "<text>", code } shape', async () => {
    serve({ '/database/insert': { status: 502, body: { error: 'Upstream service unavailable', code: 'UPSTREAM_UNAVAILABLE' } } })
    const error = await client().posts.create({ title: 'Hello' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'Upstream service unavailable', code: 'UPSTREAM_UNAVAILABLE', status: 502 })
  })

  it('names the status when the body is not JSON', async () => {
    serve({ '/database/insert': { status: 502, text: '<html>Bad Gateway</html>' } })
    const error = await client().posts.create({ title: 'Hello' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'Request failed with status 502', status: 502 })
  })
})
