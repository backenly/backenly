/**
 * Reading Firestore over REST (lib/import/drivers/firebase-firestore.ts):
 * paging through collection ids and documents, COUNT aggregation, the
 * preview's discovery of subcollections, and the import's walk of a whole
 * collection tree, recursive or (where a database refuses that) document by
 * document. The fake answers with Firestore's own page tokens and shapes
 * (tests/helpers/fake-google.ts); two recorded answers are replayed verbatim.
 * Database-free.
 */

import { GoogleClient, type GoogleRequest } from '@/lib/import/google-http'
import { GoogleTokenSource, parseServiceAccount } from '@/lib/import/google-auth'
import { FirestoreReader, discoverCollections, mapLimit } from '@/lib/import/drivers/firebase-firestore'
import { locate, type FsDocument } from '@/lib/import/drivers/firebase-schema'
import { FakeGoogle, jsonResponse, makeServiceAccount } from '../../tests/helpers/fake-google'

const SA = makeServiceAccount('demo-shop')
const noSleep = async () => {}

function readerFor(google: FakeGoogle, transport = google.transport) {
  const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport, sleep: noSleep })
  return new FirestoreReader(new GoogleClient({ token: tokens.token, transport, sleep: noSleep }), SA.projectId)
}

/** posts with comments (one under a deleted post), users with a private subcollection, and a top-level `comments`. */
function shop(): FakeGoogle {
  const g = new FakeGoogle(SA)
  g.put('posts/p1', { title: { stringValue: 'One' }, likes: { integerValue: '3' } })
  g.put('posts/p1/comments/c1', { body: { stringValue: 'First' } })
  g.put('posts/p1/comments/c2', { body: { stringValue: 'Second' } })
  g.put('posts/p2', { title: { stringValue: 'Two' } })
  g.put('posts/p2/comments/c1', { body: { stringValue: 'Same id, other post' } })
  g.put('posts/p3', { title: { stringValue: 'Three' } })
  g.put('posts/ghost/comments/g1', { body: { stringValue: 'Its post was deleted' } })
  g.put('users/u1', { name: { stringValue: 'Ada' } })
  g.put('users/u1/private/settings', { theme: { stringValue: 'dark' } })
  g.put('users/u2', { name: { stringValue: 'Grace' } })
  g.put('comments/top1', { text: { stringValue: 'A top-level comment' } })
  return g
}

const paths = (docs: FsDocument[], root: string) => docs.map((d) => locate(d.name, root)!.path)

describe('Firestore paging', () => {
  it('pages through collection ids', async () => {
    const g = shop()
    const reader = readerFor(g)
    expect(await reader.listCollectionIds()).toEqual(['comments', 'posts', 'users'])
    expect(g.calls.filter((c) => c.url.endsWith(':listCollectionIds'))).toHaveLength(2) // two ids a page
    expect(await reader.listCollectionIds('posts/p1')).toEqual(['comments'])
    expect(await reader.listCollectionIds('posts/ghost')).toEqual(['comments'])
    expect(await reader.listCollectionIds('posts/p3')).toEqual([])
  })

  it('pages through documents with the page token Firestore returns', async () => {
    const g = shop()
    const reader = readerFor(g)
    const first = await reader.listPage('posts', { pageSize: 2 })
    expect(paths(first.documents, reader.root)).toEqual(['posts/p1', 'posts/p2'])
    expect(first.nextPageToken).toBeTruthy()
    const second = await reader.listPage('posts', { pageSize: 2, pageToken: first.nextPageToken })
    expect(paths(second.documents, reader.root)).toEqual(['posts/p3'])
    expect(second.nextPageToken).toBeUndefined()
    expect(paths(await reader.sample('posts', 2), reader.root)).toEqual(['posts/p1', 'posts/p2'])
  })

  it('counts a collection, and every collection with an id', async () => {
    const reader = readerFor(shop())
    expect(await reader.count('posts')).toBe(3)
    expect(await reader.count('comments', { parentPath: 'posts/p1' })).toBe(2)
    expect(await reader.count('comments', { group: true })).toBe(5)
  })

  it('reads recorded answers exactly as Google sends them', async () => {
    const g = shop()
    const recorded = async (req: GoogleRequest) => {
      if (req.url.endsWith(':runAggregationQuery')) {
        return jsonResponse(200, [{ result: { aggregateFields: { n: { integerValue: '1200345' } } }, readTime: '2026-11-16T03:04:05.678901Z' }])
      }
      if (req.url.endsWith(':listCollectionIds')) return jsonResponse(200, { collectionIds: ['orders', 'products'] })
      return g.transport(req)
    }
    const reader = readerFor(g, recorded)
    expect(await reader.count('orders')).toBe(1200345)
    expect(await reader.listCollectionIds()).toEqual(['orders', 'products'])
  })

  it('asks for smaller pages when a page of large documents is too big', async () => {
    const g = shop()
    const sizes: number[] = []
    const capped = async (req: GoogleRequest) => {
      const u = new URL(req.url)
      if (u.pathname.endsWith('/documents/posts')) {
        const size = Number(u.searchParams.get('pageSize'))
        sizes.push(size)
        if (size > 100) throw new Error('Response exceeded 50331649 bytes.')
      }
      return g.transport(req)
    }
    const page = await readerFor(g, capped).listPage('posts', {})
    expect(page.documents).toHaveLength(3)
    expect(sizes).toEqual([300, 75])
  })
})

describe('walking a collection and everything under it', () => {
  const expected = [
    'posts/ghost/comments/g1',
    'posts/p1',
    'posts/p1/comments/c1',
    'posts/p1/comments/c2',
    'posts/p2',
    'posts/p2/comments/c1',
    'posts/p3',
  ]

  it('lists the whole tree with one recursive listing, in name order', async () => {
    const g = shop()
    const reader = readerFor(g)
    const seen: string[] = []
    for await (const page of reader.walk('posts')) seen.push(...paths(page, reader.root))
    expect(seen).toEqual(expected)
    expect(reader.usedFallback).toBe(false)
    const lists = g.calls.filter((c) => new URL(c.url).searchParams.get('recursive') === 'true')
    expect(lists).toHaveLength(1)
  })

  it('falls back to listing subcollections document by document, and misses nothing', async () => {
    const g = shop()
    g.recursiveUnsupported = true
    const reader = readerFor(g)
    const seen: string[] = []
    for await (const page of reader.walk('posts')) seen.push(...paths(page, reader.root))
    expect(reader.usedFallback).toBe(true)
    // Every existing document, including the comment under the deleted post; the deleted post itself is not a row.
    expect([...seen].sort()).toEqual([...expected].sort())
    expect(seen).not.toContain('posts/ghost')
  })
})

describe('discovering what the preview shows', () => {
  it('finds subcollections, samples them, and counts them where the count is theirs alone', async () => {
    const reader = readerFor(shop())
    const found = await discoverCollections(reader)
    const byPattern = Object.fromEntries(found.map((c) => [c.pattern, c]))
    expect(Object.keys(byPattern).sort()).toEqual(['comments', 'posts', 'posts/*/comments', 'users', 'users/*/private'])
    expect(byPattern.posts.count).toBe(3)
    expect(byPattern.users.count).toBe(2)
    expect(byPattern.comments.count).toBe(1)
    // Every collection named comments, minus the top-level one: the comments under posts, the deleted post's included.
    expect(byPattern['posts/*/comments'].count).toBe(4)
    expect(byPattern['posts/*/comments'].profile.docs).toBe(3) // sampled from the posts that exist
    expect(byPattern['users/*/private'].count).toBe(1)
    expect([...byPattern.posts.profile.fields.keys()].sort()).toEqual(['likes', 'title'])
  })

  it('leaves a shared collection id to be counted while moving', async () => {
    const g = shop()
    g.put('users/u2/comments/x', { body: { stringValue: 'On a profile' } })
    const found = await discoverCollections(readerFor(g))
    const shared = found.filter((c) => c.pattern.endsWith('/*/comments'))
    expect(shared.map((c) => c.pattern).sort()).toEqual(['posts/*/comments', 'users/*/comments'])
    for (const c of shared) {
      expect(c.count).toBeNull()
      expect(c.countNote).toBe('Other collections are also named comments, so this one is counted while moving.')
    }
  })

  it('runs at most a few at a time and keeps order', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 2))
      running--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
  })
})
