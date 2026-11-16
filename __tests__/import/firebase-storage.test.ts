/**
 * Cloud Storage for Firebase, read for the import (lib/import/drivers/firebase-storage.ts):
 * the default bucket found from the project's config or by its two default
 * names, objects paged with the JSON API (folder placeholders are not files),
 * each object downloaded with alt=media under its full, encoded path.
 * Database-free.
 */

import { GoogleClient } from '@/lib/import/google-http'
import { GoogleTokenSource, parseServiceAccount } from '@/lib/import/google-auth'
import {
  downloadObject,
  findDefaultBucket,
  listObjects,
  listObjectsPage,
  mimeTypeFor,
  readProjectInfo,
} from '@/lib/import/drivers/firebase-storage'
import { FakeGoogle, makeServiceAccount } from '../../tests/helpers/fake-google'

const SA = makeServiceAccount('demo-shop')
const noSleep = async () => {}

function clientFor(google: FakeGoogle) {
  const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep })
  return new GoogleClient({ token: tokens.token, transport: google.transport, sleep: noSleep })
}

function bucketWithFiles(): FakeGoogle {
  const g = new FakeGoogle(SA)
  g.objects.set('avatars/', { contentType: 'application/x-www-form-urlencoded;charset=UTF-8', data: Buffer.alloc(0) })
  g.objects.set('avatars/u 1#.png', { contentType: 'image/png', data: Buffer.from('png-bytes') })
  g.objects.set('docs/report.pdf', { contentType: 'application/pdf', data: Buffer.from('%PDF-1.7') })
  g.objects.set('exports/data.csv', { contentType: null, data: Buffer.from('a,b\n1,2\n') })
  return g
}

describe('Storage', () => {
  it('pages through objects and leaves folder placeholders out', async () => {
    const g = bucketWithFiles()
    const client = clientFor(g)
    const pages: string[][] = []
    for await (const page of listObjects(client, g.bucket!)) pages.push(page.map((o) => o.name))
    expect(pages.flat()).toEqual(['avatars/u 1#.png', 'docs/report.pdf', 'exports/data.csv'])
    const lists = g.calls.filter((c) => c.url.includes('/o?'))
    expect(lists).toHaveLength(2) // two objects a page in the fake
    expect(new URL(lists[0].url).searchParams.get('fields')).toBe('items(name,size,contentType),nextPageToken')
    const first = await listObjectsPage(client, g.bucket!)
    expect(first.objects[0]).toEqual({ name: 'avatars/u 1#.png', size: 9, contentType: 'image/png' })
    expect(g.scopesIssued).toEqual(['https://www.googleapis.com/auth/devstorage.read_only'])
  })

  it('downloads each object by its full path, encoded', async () => {
    const g = bucketWithFiles()
    const bytes = await downloadObject(clientFor(g), g.bucket!, 'avatars/u 1#.png', 1024)
    expect(bytes.toString()).toBe('png-bytes')
    const get = g.calls.find((c) => c.url.includes('alt=media'))!
    expect(get.url).toBe('https://storage.googleapis.com/storage/v1/b/demo-shop.appspot.com/o/avatars%2Fu%201%23.png?alt=media')
    expect(get.method).toBe('GET')
  })

  it("finds the default bucket from the project's config", async () => {
    const g = bucketWithFiles()
    const client = clientFor(g)
    const info = await readProjectInfo(client, SA.projectId)
    expect(info).toEqual({ displayName: 'Demo Shop', storageBucket: 'demo-shop.appspot.com' })
    expect(await findDefaultBucket(client, SA.projectId, info.storageBucket)).toEqual({ bucket: 'demo-shop.appspot.com', problem: null })
  })

  it('tries both default names when the config says nothing (newer projects)', async () => {
    const g = bucketWithFiles()
    g.configBucket = null
    g.bucket = 'demo-shop.firebasestorage.app'
    const client = clientFor(g)
    const info = await readProjectInfo(client, SA.projectId)
    expect(info.storageBucket).toBeNull()
    expect(await findDefaultBucket(client, SA.projectId, null)).toEqual({ bucket: 'demo-shop.firebasestorage.app', problem: null })

    g.bucket = 'demo-shop.appspot.com'
    expect(await findDefaultBucket(client, SA.projectId, null)).toEqual({ bucket: 'demo-shop.appspot.com', problem: null })

    g.bucket = null
    expect(await findDefaultBucket(client, SA.projectId, null)).toEqual({ bucket: null, problem: null })
  })

  it('names the role when the key cannot read Storage', async () => {
    const g = bucketWithFiles()
    g.deny.add('storage')
    expect(await findDefaultBucket(clientFor(g), SA.projectId, g.configBucket)).toEqual({
      bucket: null,
      problem: "This key can't read Cloud Storage. Give the service account the Storage Object Viewer role.",
    })
  })

  it("keeps Storage's own type, and falls back to the extension's when it says nothing", () => {
    expect(mimeTypeFor('a/b.png', 'image/png')).toBe('image/png')
    expect(mimeTypeFor('a/b.png', 'application/octet-stream')).toBe('image/png')
    expect(mimeTypeFor('exports/data.csv', null)).toBe('text/csv')
    expect(mimeTypeFor('notes.txt', 'text/plain; charset=utf-8')).toBe('text/plain')
    expect(mimeTypeFor('blob', null)).toBeNull()
  })
})
