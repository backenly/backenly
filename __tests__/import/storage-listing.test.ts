/**
 * WALKING A SUPABASE STORAGE BUCKET (lib/import/supabase-storage.ts)
 * =================================================================
 * Supabase's list call may answer fewer entries than asked for. The walk
 * must page by what came back, not by what it asked for: the first version
 * advanced by its own page size and silently skipped every object after the
 * server's first page (found by the e2e stub, which caps pages at 7).
 *
 * The listing is the server's to answer, so the walk bounds what it reads:
 * files, folders and list calls per source, 2 MB per page, as many entries
 * per page as it asked for. A listing that never ends stops at its limit,
 * saying which, instead of growing a queue in the web process for hours.
 *
 * A local server stands in for Storage; private egress is opened for the
 * importer's scope only, as a self-hosted deployment would.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  STORAGE_WALK_LIMITS,
  StorageWalk,
  StorageWalkLimitError,
  inspectStorage,
  listBuckets,
  walkObjects,
  type SupabaseBucket,
} from '@/lib/import/supabase-storage'

const KEY = ['test', 'service', 'key'].join('-')
const PAGE_CAP = 3
const files = Array.from({ length: 11 }, (_, i) => `photos/p${String(i).padStart(2, '0')}.png`).concat(['top.txt', 'a/b/c/deep.txt'])
let server: http.Server
let origin = ''
const seen: string[] = []

beforeAll(async () => {
  process.env.BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE = 'true'
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`)
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401)
        return res.end('{}')
      }
      if (req.url === '/storage/v1/bucket') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify([{ id: 'media', name: 'media', public: false, file_size_limit: null, allowed_mime_types: null }]))
      }
      const q = JSON.parse(body || '{}')
      const prefix = q.prefix ? `${q.prefix}/` : ''
      const names = new Map<string, any>()
      for (const f of files.filter((f) => f.startsWith(prefix))) {
        const rest = f.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) names.set(rest, { name: rest, id: `id-${f}`, metadata: { size: 10, mimetype: 'text/plain' } })
        else names.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, metadata: null })
      }
      const page = [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(q.offset, q.offset + Math.min(q.limit, PAGE_CAP))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(page))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  delete process.env.BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE
  await new Promise((r) => server.close(r))
})

it('finds every object, in every folder, past the server page cap', async () => {
  const src = { origin, key: KEY, secrets: [KEY] }
  const [bucket] = await listBuckets(src)
  const found: string[] = []
  for await (const o of walkObjects(src, bucket, new AbortController().signal)) found.push(o.path)
  expect(found.sort()).toEqual([...files].sort())
  // Reads only: the bucket list, and list calls whose body is the query.
  expect(seen.every((s) => s === 'GET /storage/v1/bucket' || s.startsWith('POST /storage/v1/object/list/'))).toBe(true)
})

it('a refused key is said under the key field', async () => {
  await expect(listBuckets({ origin, key: 'wrong', secrets: [] })).rejects.toMatchObject({ field: 'serviceRoleKey' })
})

describe('a listing the server never ends', () => {
  let endless: http.Server
  let at = ''
  const calls: Record<string, number> = {}
  const bucket = (id: string): SupabaseBucket => ({ id, name: id, public: false, fileSizeLimit: null, allowedMimeTypes: null })
  const src = () => ({ origin: at, key: KEY, secrets: [KEY] })
  const file = (name: string) => ({ name, id: `id-${name}`, metadata: { size: 1, mimetype: 'text/plain' } })

  beforeAll(async () => {
    endless = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url === '/storage/v1/bucket') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, name: `b${i}`, public: false }))))
        }
        const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
        calls[id] = (calls[id] ?? 0) + 1
        const q = JSON.parse(body || '{}')
        const page = (make: (i: number) => unknown, n = q.limit) => Array.from({ length: n }, (_, i) => make(q.offset + i))
        let answer: unknown
        if (id === 'files') answer = page((i) => file(`f${String(i).padStart(9, '0')}`)) // a new full page, every time
        else if (id === 'folders') answer = page((i) => ({ name: `d${i}`, id: null, metadata: null }))
        else if (id === 'nothing') answer = page(() => ({ name: '.emptyFolderPlaceholder', id: 'x', metadata: {} }))
        else if (id === 'huge') answer = page((i) => file(`${'x'.repeat(2500)}${i}`))
        else if (id === 'more') answer = page((i) => file(`m${i}`), q.limit + 1)
        else if (id === 'long') answer = [file('y'.repeat(1025))]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer ?? []))
      })
    })
    await new Promise<void>((r) => endless.listen(0, '127.0.0.1', () => r()))
    at = `http://127.0.0.1:${(endless.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((r) => endless.close(r))
  })

  async function walkAll(id: string, walk?: StorageWalk): Promise<{ found: number; err: unknown }> {
    let found = 0
    try {
      for await (const _ of walkObjects(src(), bucket(id), new AbortController().signal, walk)) found++
    } catch (err) {
      return { found, err }
    }
    return { found, err: null }
  }

  it('stops at the files one import moves, a few hundred calls in, and says so', async () => {
    const { found, err } = await walkAll('files')
    expect(err).toBeInstanceOf(StorageWalkLimitError)
    expect((err as StorageWalkLimitError).field).toBe('projectUrl')
    expect((err as Error).message).toBe(
      'Supabase Storage holds more than 200,000 files; one import moves up to 200,000. Leave files out (no Project URL or service_role key) to move the rest, or contact us to move them.',
    )
    expect(found).toBe(STORAGE_WALK_LIMITS.files)
    expect(calls.files).toBe(STORAGE_WALK_LIMITS.files / 1000 + 1)
  })

  it('stops at the folders one import lists, without walking into them', async () => {
    const { err } = await walkAll('folders')
    expect((err as Error).message).toMatch(/^Supabase Storage holds more than 20,000 folders; one import lists up to 20,000\./)
    expect(calls.folders).toBe(STORAGE_WALK_LIMITS.folders / 1000 + 1)
  })

  it('stops at the list calls one import makes when the pages hold nothing to move', async () => {
    const { found, err } = await walkAll('nothing', new StorageWalk({ ...STORAGE_WALK_LIMITS, requests: 30 }))
    expect(found).toBe(0)
    expect((err as Error).message).toMatch(/^Listing Supabase Storage took more than 30 calls, the most one import makes\./)
    expect(calls.nothing).toBe(30)
  })

  it('counts the limits for the whole source, not for each bucket', async () => {
    const walk = new StorageWalk({ ...STORAGE_WALK_LIMITS, files: 1500 })
    const first = await walkAll('files', walk)
    expect(first.err).toBeInstanceOf(StorageWalkLimitError)
    const second = await walkAll('files', walk)
    expect(second.found).toBe(0)
    expect(second.err).toBeInstanceOf(StorageWalkLimitError)
  })

  it('reads at most 2 MB of one page, as many entries as it asked for, and paths a Storage object can have', async () => {
    expect((await walkAll('huge')).err).toMatchObject({ message: expect.stringMatching(/^Supabase Storage answered one listing with more than 2 MB/) })
    expect((await walkAll('more')).err).toMatchObject({ message: expect.stringMatching(/more than the 1,000 entries asked for/) })
    expect((await walkAll('long')).err).toMatchObject({ message: expect.stringMatching(/a path longer than 1,024 characters/) })
  })

  it('refuses a source with more buckets than one import moves, before listing any', async () => {
    await expect(listBuckets(src())).rejects.toThrow(/^Supabase Storage has more than 100 buckets; one import moves up to 100\./)
    const before = Object.values(calls).reduce((s, n) => s + n, 0)
    await expect(inspectStorage(src(), new AbortController().signal)).rejects.toBeInstanceOf(StorageWalkLimitError)
    expect(Object.values(calls).reduce((s, n) => s + n, 0)).toBe(before)
  })
})
