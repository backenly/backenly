/**
 * WALKING A SUPABASE STORAGE BUCKET (lib/import/supabase-storage.ts)
 * =================================================================
 * Supabase's list call may answer fewer entries than asked for. The walk
 * must page by what came back, not by what it asked for: the first version
 * advanced by its own page size and silently skipped every object after the
 * server's first page (found by the e2e stub, which caps pages at 7).
 *
 * A local server stands in for Storage; private egress is opened for the
 * importer's scope only, as a self-hosted deployment would.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { listBuckets, walkObjects } from '@/lib/import/supabase-storage'

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
