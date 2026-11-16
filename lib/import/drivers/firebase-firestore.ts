/**
 * Reading a Firestore database over its REST API, only ever reading.
 *
 *   listCollectionIds   the top-level collections, and a document's subcollections
 *   runAggregationQuery COUNT(*) for the preview and the final check
 *   documents list      pages of documents; with `recursive`, a whole collection
 *                       and everything nested under it, in name order
 *
 * The import walks each top-level collection with one recursive listing, so a
 * subcollection is found wherever it is, including under a document that was
 * deleted (Firestore keeps its subcollections). Where a database refuses the
 * recursive listing, the walk falls back to listing each document's
 * subcollections itself: slower, never less complete.
 *
 * The preview cannot afford to walk everything, so it samples: up to 1,000
 * documents per collection for the column types, and the subcollections of a
 * handful of those documents. A subcollection the sample never met is still
 * moved, and appears in the ledger once the walk reaches it.
 */

import { GoogleApiError, GoogleResponseTooLargeError, encodePath, type GoogleClient } from '../google-http'
import { CollectionProfile, locate, type FsDocument } from './firebase-schema'
import { throwIfAborted } from '../pg-engine'

const FIRESTORE = 'https://firestore.googleapis.com/v1'
const PAGE_SIZE = 300
const MAX_PAGE_BYTES = 48 * 1024 * 1024

type Query = Record<string, string | number | boolean | undefined>

export class FirestoreReader {
  readonly root: string
  /** Set once a recursive listing was refused and the walk fell back. */
  usedFallback = false

  constructor(private readonly client: GoogleClient, readonly projectId: string, readonly database = '(default)') {
    this.root = `projects/${projectId}/databases/${database}/documents`
  }

  private url(resource: string, suffix = '', query: Query = {}): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v))
    const qs = q.toString()
    return `${FIRESTORE}/${encodePath(resource)}${suffix}${qs ? `?${qs}` : ''}`
  }

  private resource(path?: string | null): string {
    return path ? `${this.root}/${path}` : this.root
  }

  /** Collection ids at the top (no parent) or under one document. */
  async listCollectionIds(parentPath?: string | null): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const res = await this.client.json<{ collectionIds?: string[]; nextPageToken?: string }>(
        'firestore', 'firestore', 'POST',
        this.url(this.resource(parentPath), ':listCollectionIds'),
        { pageSize: 300, ...(pageToken ? { pageToken } : {}) },
      )
      for (const id of res.collectionIds ?? []) ids.push(id)
      pageToken = res.nextPageToken || undefined
    } while (pageToken)
    return ids
  }

  /**
   * COUNT(*) of one collection (under `parentPath`, or at the top), or of every
   * collection with this id anywhere (`group`).
   */
  async count(collectionId: string, opts: { parentPath?: string | null; group?: boolean } = {}): Promise<number> {
    const res = await this.client.json<any>(
      'firestore', 'firestore', 'POST',
      this.url(this.resource(opts.parentPath), ':runAggregationQuery'),
      {
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId, ...(opts.group ? { allDescendants: true } : {}) }] },
          aggregations: [{ alias: 'n', count: {} }],
        },
      },
      { timeoutMs: 90_000 },
    )
    const rows: any[] = Array.isArray(res) ? res : [res]
    for (const r of rows) {
      const n = r?.result?.aggregateFields?.n
      if (n && n.integerValue !== undefined) return Number(n.integerValue)
    }
    throw new GoogleApiError('firestore', 200, 'INVALID_RESPONSE', '', 'Firestore answered a count without a number.')
  }

  /**
   * One page of a collection (`collectionPath` like posts or posts/a/comments).
   * `recursive` includes every document nested under it; `showMissing` includes
   * deleted documents that still have subcollections (with no createTime).
   */
  async listPage(
    collectionPath: string,
    opts: { pageSize?: number; pageToken?: string; recursive?: boolean; showMissing?: boolean },
  ): Promise<{ documents: FsDocument[]; nextPageToken?: string }> {
    let pageSize = opts.pageSize ?? PAGE_SIZE
    for (;;) {
      try {
        const res = await this.client.json<{ documents?: FsDocument[]; nextPageToken?: string }>(
          'firestore', 'firestore', 'GET',
          this.url(`${this.root}/${collectionPath}`, '', {
            pageSize,
            pageToken: opts.pageToken,
            recursive: opts.recursive,
            showMissing: opts.showMissing,
          }),
          undefined,
          { maxBytes: MAX_PAGE_BYTES },
        )
        return { documents: res.documents ?? [], nextPageToken: res.nextPageToken || undefined }
      } catch (err) {
        // Documents are up to 1 MiB each: a page of large ones can outgrow the
        // limit, and a smaller page of the same documents will not.
        if (err instanceof GoogleResponseTooLargeError && pageSize > 1) {
          pageSize = Math.max(1, Math.floor(pageSize / 4))
          continue
        }
        throw err
      }
    }
  }

  /** Up to `limit` documents of one collection, in name order. */
  async sample(collectionPath: string, limit: number): Promise<FsDocument[]> {
    const out: FsDocument[] = []
    let pageToken: string | undefined
    while (out.length < limit) {
      const page = await this.listPage(collectionPath, { pageSize: Math.min(PAGE_SIZE, limit - out.length), pageToken })
      out.push(...page.documents)
      pageToken = page.nextPageToken
      if (!pageToken) break
    }
    return out.slice(0, limit)
  }

  /**
   * Every document in one top-level collection and under it, page by page.
   * Existing documents only: a deleted document's subcollections come through,
   * the deleted document itself does not.
   */
  async *walk(topCollectionId: string): AsyncGenerator<FsDocument[]> {
    let pageToken: string | undefined
    let first = true
    for (;;) {
      let page: { documents: FsDocument[]; nextPageToken?: string }
      try {
        page = await this.listPage(topCollectionId, { pageToken, recursive: true })
      } catch (err) {
        if (first && err instanceof GoogleApiError && err.status === 400) {
          this.usedFallback = true
          yield* this.walkTree(topCollectionId)
          return
        }
        throw err
      }
      first = false
      if (page.documents.length) yield page.documents
      if (!page.nextPageToken) return
      pageToken = page.nextPageToken
    }
  }

  /** The fallback walk: each page, then each of its documents' subcollections. */
  private async *walkTree(collectionPath: string): AsyncGenerator<FsDocument[]> {
    let pageToken: string | undefined
    do {
      const page = await this.listPage(collectionPath, { pageToken, showMissing: true })
      const existing = page.documents.filter((d) => !!d.createTime)
      if (existing.length) yield existing
      const children = await mapLimit(page.documents, 8, async (d) => {
        const loc = locate(d.name, this.root)
        return loc ? (await this.listCollectionIds(loc.path)).map((id) => `${loc.path}/${id}`) : []
      })
      for (const paths of children) for (const p of paths) yield* this.walkTree(p)
      pageToken = page.nextPageToken
    } while (pageToken)
  }
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ── Discovery: what the preview shows, and the import's starting plan ─────────

export interface DiscoveredCollection {
  /** posts, or posts/*\/comments */
  pattern: string
  profile: CollectionProfile
  /** Exact document count, or null when it could not be counted on its own. */
  count: number | null
  /** Why `count` is null, in words, when it is. */
  countNote: string | null
}

export interface DiscoveryOptions {
  /** Documents read per collection for the column types. */
  sampleSize?: number
  /** Documents per collection whose subcollections are looked for. */
  probeDocuments?: number
  /** How deep subcollections are followed in the preview. */
  maxDepth?: number
  signal?: AbortSignal
}

/**
 * The collections of a database, each with a sample and a count. Top-level
 * counts are exact. A subcollection is counted with Firestore's collection
 * group count, which counts every collection with its id anywhere; that is its
 * own count only when no other collection shares the id, otherwise the count is
 * left to the import, which counts as it reads.
 */
export async function discoverCollections(reader: FirestoreReader, opts: DiscoveryOptions = {}): Promise<DiscoveredCollection[]> {
  const sampleSize = opts.sampleSize ?? 1000
  const probe = opts.probeDocuments ?? 12
  const maxDepth = opts.maxDepth ?? 4

  const found = new Map<string, DiscoveredCollection>()
  /** Concrete collection paths to sample from, per pattern. */
  let level: Array<{ pattern: string; paths: string[] }> = (await reader.listCollectionIds()).map((id) => ({ pattern: id, paths: [id] }))
  const topIds = new Set(level.map((l) => l.pattern))
  const groupCounts = new Map<string, Promise<number | null>>()

  for (let depth = 1; level.length > 0; depth++) {
    if (opts.signal) throwIfAborted(opts.signal)
    const next = new Map<string, string[]>()
    await mapLimit(level, 4, async ({ pattern, paths }) => {
      const profile = new CollectionProfile()
      const docs: FsDocument[] = []
      for (const p of paths) {
        if (docs.length >= sampleSize) break
        docs.push(...(await reader.sample(p, sampleSize - docs.length)))
      }
      for (const d of docs) profile.add(d)

      let count: number | null = null
      let countNote: string | null = null
      if (depth === 1) {
        try {
          count = await reader.count(pattern)
        } catch (err) {
          if (!(err instanceof GoogleApiError) || err.permissionDenied) throw err
          countNote = 'Too many documents to count quickly; the exact number shows while moving.'
        }
      }
      found.set(pattern, { pattern, profile, count, countNote })

      if (depth >= maxDepth || docs.length === 0) return
      const step = Math.max(1, Math.floor(docs.length / probe))
      const probed = docs.filter((_, i) => i % step === 0).slice(0, probe)
      const childLists = await mapLimit(probed, 5, async (d) => {
        const loc = locate(d.name, reader.root)
        return loc ? (await reader.listCollectionIds(loc.path)).map((id) => ({ id, path: `${loc.path}/${id}` })) : []
      })
      for (const list of childLists) {
        for (const { id, path } of list) {
          const childPattern = `${pattern}/*/${id}`
          const known = next.get(childPattern) ?? []
          known.push(path)
          next.set(childPattern, known)
        }
      }
    })
    level = [...next.entries()].map(([pattern, paths]) => ({ pattern, paths }))
  }

  // Subcollection counts, where Firestore's collection group count is theirs alone.
  const children = [...found.values()].filter((c) => c.pattern.includes('/*/'))
  const byId = new Map<string, DiscoveredCollection[]>()
  for (const c of children) {
    const id = c.pattern.split('/*/').pop()!
    byId.set(id, [...(byId.get(id) ?? []), c])
  }
  await mapLimit([...byId.entries()], 4, async ([id, list]) => {
    if (list.length > 1) {
      for (const c of list) c.countNote = `Other collections are also named ${id}, so this one is counted while moving.`
      return
    }
    if (!groupCounts.has(id)) {
      groupCounts.set(id, reader.count(id, { group: true }).catch((err) => {
        if (err instanceof GoogleApiError && err.permissionDenied) throw err
        return null
      }))
    }
    let n = await groupCounts.get(id)!
    if (n !== null && topIds.has(id)) {
      const top = found.get(id)?.count
      n = typeof top === 'number' ? n - top : null
    }
    if (n === null || n < list[0].profile.docs) {
      list[0].countNote = 'Counted while moving.'
    } else {
      list[0].count = n
    }
  })

  return [...found.values()]
}
