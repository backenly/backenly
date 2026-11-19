/**
 * Supabase Storage → the new project's buckets.
 *
 * Read through Supabase's Storage REST API with the service_role key the person
 * pasted, GET and list calls only:
 *
 *   GET  {projectUrl}/storage/v1/bucket                     the buckets
 *   POST {projectUrl}/storage/v1/object/list/{bucket}       one folder, paged (a read: the body is the query)
 *   GET  {projectUrl}/storage/v1/object/{bucket}/{path}     one object's bytes
 *
 * Every request goes through lib/security/outbound-guard.ts safeFetch with the
 * `import` scope: the host is checked at connect time, redirects are checked
 * hop by hop, the key (Authorization and apikey both) is dropped on a
 * cross-origin redirect, and a redirect from https:// to http:// is refused.
 *
 * Each bucket keeps its name and its public / private setting. Objects keep
 * their paths as names. One object is held in memory at a time, up to the
 * bucket's size limit (never over Backenly's 100 MB per-upload ceiling), and
 * goes through the same upload checks as any other upload: quota, executable
 * types (blocked as on every Backenly bucket), type spoofing. An object those
 * checks refuse is skipped and named; the rest keep moving.
 *
 * The listing is the server's to answer, so how much of it is read is
 * Backenly's to bound (STORAGE_WALK_LIMITS): pages of at most 2 MB, and per
 * walk of every bucket a number of files, folders and list calls, waiting for
 * memory headroom before each call. A walk past one of them stops with a
 * StorageWalkLimitError naming it: the preview says files cannot move as they
 * are, and an import already moving rows finishes without the files.
 */

import type { ImportPreviewBucket } from './contract'
import type { FileUpload, UploadOutcome } from './drivers/firebase-destination'
import { ImportInputError } from './driver'
import { redactedMessage } from './redact'
import { throwIfAborted } from './pg-engine'
import { MAX_BUFFERED_UPLOAD_FILE_BYTES } from '@/lib/storage/body-limits'
import { waitForHeadroom } from './pressure'

export interface StorageSource {
  /** https://<ref>.supabase.co, checked by lib/import/net.ts checkProjectUrl. */
  origin: string
  key: string
  secrets: readonly string[]
}

export interface SupabaseBucket {
  id: string
  name: string
  public: boolean
  fileSizeLimit: number | null
  allowedMimeTypes: string[] | null
}

export interface SourceObject {
  bucket: string
  path: string
  size: number
  mimeType: string | null
}

const LIST_PAGE = 1000
/** Supabase's dashboard leaves this in every folder it creates. */
const PLACEHOLDER = '.emptyFolderPlaceholder'

const MB = 1024 * 1024

/** The most of Storage's listing one import reads, whatever the server answers. */
export const STORAGE_WALK_LIMITS = {
  /** Buckets in the source. */
  buckets: 100,
  /** Files, over every bucket. */
  files: 200_000,
  /** Folders, over every bucket. */
  folders: 20_000,
  /** List calls, over every bucket: each folder takes one more call than its pages. */
  requests: 50_000,
  /** One answer to a list call: a page of 1,000 of Supabase's entries is well under 1 MB. */
  pageBytes: 2 * MB,
  /** One path: an object's name in Storage is at most 1,024 characters. */
  pathChars: 1024,
}

export type StorageWalkLimits = typeof STORAGE_WALK_LIMITS

/** Storage's listing went past what one import reads; the message says which limit and what to do. */
export class StorageWalkLimitError extends ImportInputError {
  constructor(message: string) {
    super(message, 'projectUrl')
    this.name = 'StorageWalkLimitError'
  }
}

const LEAVE_FILES_OUT = 'Leave files out (no Project URL or service_role key) to move the rest, or contact us to move them.'
const count = (n: number) => n.toLocaleString('en-US')

/** What one walk over a source's buckets has read so far, against STORAGE_WALK_LIMITS. */
export class StorageWalk {
  files = 0
  folders = 0
  requests = 0

  constructor(readonly limits: StorageWalkLimits = STORAGE_WALK_LIMITS) {}

  request(): void {
    if (++this.requests > this.limits.requests) {
      throw new StorageWalkLimitError(`Listing Supabase Storage took more than ${count(this.limits.requests)} calls, the most one import makes. ${LEAVE_FILES_OUT}`)
    }
  }

  file(): void {
    if (++this.files > this.limits.files) {
      throw new StorageWalkLimitError(`Supabase Storage holds more than ${count(this.limits.files)} files; one import moves up to ${count(this.limits.files)}. ${LEAVE_FILES_OUT}`)
    }
  }

  folder(): void {
    if (++this.folders > this.limits.folders) {
      throw new StorageWalkLimitError(`Supabase Storage holds more than ${count(this.limits.folders)} folders; one import lists up to ${count(this.limits.folders)}. ${LEAVE_FILES_OUT}`)
    }
  }
}

async function call(
  src: StorageSource,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; maxBytes?: number; timeoutMs?: number } = {},
) {
  const { safeFetch } = await import('@/lib/security/outbound-guard')
  const maxBytes = opts.maxBytes ?? STORAGE_WALK_LIMITS.pageBytes
  try {
    return await safeFetch(`${src.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${src.key}`,
        apikey: src.key,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBytes,
      egressScope: 'import',
      refuseDowngrade: true,
    })
  } catch (err) {
    if (opts.maxBytes === undefined && /^Response exceeded \d+ bytes/.test((err as Error)?.message ?? '')) {
      throw new StorageWalkLimitError(
        `Supabase Storage answered one listing with more than ${Math.round(maxBytes / MB)} MB, more than Backenly reads at once. ${LEAVE_FILES_OUT}`,
      )
    }
    throw new ImportInputError(`Couldn't reach Storage: ${redactedMessage(err, src.secrets, 200)}`, 'projectUrl')
  }
}

function refusal(status: number): ImportInputError {
  if (status === 401 || status === 403) return new ImportInputError('Supabase refused the service_role key. Copy it again from Project Settings → API.', 'serviceRoleKey')
  if (status === 404) return new ImportInputError("That address doesn't answer as Supabase Storage. Check the Project URL.", 'projectUrl')
  return new ImportInputError(`Supabase Storage answered ${status}.`, 'projectUrl')
}

export async function listBuckets(src: StorageSource, limits: StorageWalkLimits = STORAGE_WALK_LIMITS): Promise<SupabaseBucket[]> {
  const res = await call(src, 'GET', '/storage/v1/bucket')
  if (!res.ok) throw refusal(res.status)
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body)) throw new ImportInputError("That address doesn't answer as Supabase Storage. Check the Project URL.", 'projectUrl')
  if (body.length > limits.buckets) {
    throw new StorageWalkLimitError(`Supabase Storage has more than ${count(limits.buckets)} buckets; one import moves up to ${count(limits.buckets)}. ${LEAVE_FILES_OUT}`)
  }
  return body
    .filter((b: any) => b && typeof b.name === 'string')
    .map((b: any) => ({
      id: String(b.id ?? b.name),
      name: String(b.name),
      public: b.public === true,
      fileSizeLimit: typeof b.file_size_limit === 'number' ? b.file_size_limit : null,
      allowedMimeTypes: Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types.map(String) : null,
    }))
}

/**
 * Every object of a bucket, folder by folder, page by page. `walk` counts
 * against STORAGE_WALK_LIMITS; pass one walk to every bucket of a source so the
 * limits hold for the source, not for each bucket.
 */
export async function* walkObjects(
  src: StorageSource,
  bucket: SupabaseBucket,
  signal: AbortSignal,
  walk: StorageWalk = new StorageWalk(),
): AsyncGenerator<SourceObject> {
  const folders: string[] = ['']
  while (folders.length > 0) {
    const prefix = folders.shift()!
    // A server may answer fewer entries than asked for (its own page cap), so the
    // next page starts after what came back, and only an empty page ends the folder.
    for (let offset = 0; ; ) {
      throwIfAborted(signal)
      await waitForHeadroom(signal)
      walk.request()
      const res = await call(src, 'POST', `/storage/v1/object/list/${encodeURIComponent(bucket.id)}`, {
        body: { prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } },
      })
      if (!res.ok) throw refusal(res.status)
      const page = await res.json().catch(() => null)
      if (!Array.isArray(page) || page.length === 0) break
      if (page.length > LIST_PAGE) {
        throw new StorageWalkLimitError(`Supabase Storage answered one listing with more than the ${count(LIST_PAGE)} entries asked for, so Backenly stopped reading it. ${LEAVE_FILES_OUT}`)
      }
      offset += page.length
      for (const entry of page) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) continue
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (path.length > walk.limits.pathChars) {
          throw new StorageWalkLimitError(`Supabase Storage listed a path longer than ${count(walk.limits.pathChars)} characters, which no Storage object has. ${LEAVE_FILES_OUT}`)
        }
        if (entry.id === null || entry.id === undefined) {
          walk.folder()
          folders.push(path)
          continue
        }
        if (entry.name === PLACEHOLDER) continue
        walk.file()
        const size = Number(entry.metadata?.size ?? entry.metadata?.contentLength ?? 0)
        yield { bucket: bucket.id, path, size: Number.isFinite(size) ? size : 0, mimeType: entry.metadata?.mimetype ?? null }
      }
    }
  }
}

/** The Review step's buckets: each one walked, its files counted and summed. */
export async function inspectStorage(src: StorageSource, signal: AbortSignal, limits: StorageWalkLimits = STORAGE_WALK_LIMITS): Promise<ImportPreviewBucket[]> {
  const out: ImportPreviewBucket[] = []
  const walk = new StorageWalk(limits)
  for (const b of await listBuckets(src, limits)) {
    let files = 0
    let bytes = 0
    for await (const o of walkObjects(src, b, signal, walk)) {
      files++
      bytes += o.size
    }
    out.push({ sourceName: b.name, name: b.name, files, bytes, public: b.public })
  }
  return out
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Create each bucket with the source's name and visibility, and rules that let
 * the source's files in: any type the source allowed, up to its size limit.
 * Configuration: run inside the import's closing governed change.
 */
export async function createBuckets(projectId: string, buckets: SupabaseBucket[]): Promise<Map<string, { id: string; maxBytes: number }>> {
  const { storageService } = await import('@/lib/services/storage')
  const { governedChange } = await import('@/lib/changes/ledger')
  const { prisma } = await import('@/lib/db/prisma')
  const { MAX_BUFFERED_UPLOAD_BYTES } = await import('@/lib/storage/upload-policy')
  const ceiling = Number(MAX_BUFFERED_UPLOAD_BYTES)
  const out = new Map<string, { id: string; maxBytes: number }>()
  for (const b of buckets) {
    const existing = await prisma.storageBucket.findFirst({ where: { projectId, name: b.name }, select: { id: true } })
    // Signed-in users may upload into it, as a Supabase app's users upload
    // from the client under the policies on storage.objects, which are not
    // carried over: so the app keeps working once moved. The owner can make
    // it server_only (lib/storage/upload-access.ts).
    const id = existing?.id ?? (await storageService.createBucket(b.name, projectId, b.public, 'signed_in')).id
    const maxBytes = Math.min(ceiling, b.fileSizeLimit && b.fileSizeLimit > 0 ? b.fileSizeLimit : ceiling)
    await governedChange(projectId, `Set the rules of bucket ${b.name}`, () =>
      prisma.storageBucket.update({
        where: { id },
        data: {
          isPublic: b.public,
          accessPolicy: b.public ? 'public_read' : 'private',
          // Supabase allows any extension; types follow its own list, or any.
          allowedExtensions: [],
          allowedMimeTypes: b.allowedMimeTypes ?? [],
          maxFileSizeBytes: BigInt(maxBytes),
        },
      }),
    )
    out.set(b.id, { id, maxBytes })
  }
  return out
}

/** `objects`, ending where the listing reaches one of its limits, which `onLimit` is told. */
async function* untilLimit<T>(objects: AsyncGenerator<T>, onLimit: (why: string) => void): AsyncGenerator<T> {
  try {
    yield* objects
  } catch (err) {
    if (!(err instanceof StorageWalkLimitError)) throw err
    onLimit(err.message)
  }
}

/** Why the upload checks (lib/storage/upload-policy.ts) refused a file, in a few words. */
const SKIP_WORDS: Record<string, string> = {
  EXECUTABLE_BLOCKED: 'an executable type, which Backenly buckets refuse',
  EXTENSION_NOT_ALLOWED: 'a type the bucket does not allow',
  MIME_TYPE_NOT_ALLOWED: 'a type the bucket does not allow',
  MIME_TYPE_MISMATCH: "its type does not match its extension",
  FILE_TOO_LARGE: 'larger than the bucket allows',
  FILE_EXISTS: 'already there',
}

export interface FilesContext {
  signal: AbortSignal
  onFile: (copied: number, copiedBytes: number) => void
  /** Store one file in one of the import's buckets (PgDestination.uploadFile). */
  upload: (bucketId: string, file: FileUpload) => Promise<UploadOutcome>
}

export interface FilesResult {
  copied: number
  bytes: number
  /** The first few files that did not move, to name in the warning; `skippedCount` says how many there were. */
  skipped: Array<{ path: string; why: string }>
  skippedCount: number
  /** Set when the plan's storage ran out: nothing after it was tried. */
  stoppedForQuota: boolean
  /** Why the listing stopped (StorageWalkLimitError), when it did: nothing after it was tried. */
  stopped?: string
}

/** Files named in the warning about those that did not move; the rest are counted, not kept. */
const SKIPPED_NAMED = 3

/** Download each object and store it in its bucket. */
export async function copyFiles(
  src: StorageSource,
  buckets: SupabaseBucket[],
  targets: Map<string, { id: string; maxBytes: number }>,
  ctx: FilesContext,
): Promise<FilesResult> {
  const result: FilesResult = { copied: 0, bytes: 0, skipped: [], skippedCount: 0, stoppedForQuota: false }
  const skip = (path: string, why: string) => {
    result.skippedCount++
    if (result.skipped.length < SKIPPED_NAMED) result.skipped.push({ path, why })
  }
  ctx.onFile(0, 0)
  const walk = new StorageWalk()
  for (const b of buckets) {
    if (result.stopped) break
    const target = targets.get(b.id)
    if (!target) continue
    for await (const o of untilLimit(walkObjects(src, b, ctx.signal, walk), (why) => (result.stopped = why))) {
      throwIfAborted(ctx.signal)
      const label = `${b.name}/${o.path}`
      // One file at a time, never more than an upload may carry through the server (lib/storage/body-limits.ts).
      const maxBytes = Math.min(target.maxBytes, MAX_BUFFERED_UPLOAD_FILE_BYTES)
      if (o.size > maxBytes) {
        skip(label, `larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
        continue
      }
      await waitForHeadroom(ctx.signal)
      const res = await call(src, 'GET', `/storage/v1/object/${encodeURIComponent(b.id)}/${encodePath(o.path)}`, {
        maxBytes: maxBytes + 1,
        timeoutMs: 5 * 60_000,
      }).catch((err) => {
        skip(label, err instanceof Error ? err.message : 'download failed')
        return null
      })
      if (!res) continue
      if (!res.ok) {
        skip(label, `Supabase answered ${res.status}`)
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const mimeType = o.mimeType ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? undefined
      const outcome = await ctx.upload(target.id, { name: o.path, buffer, mimeType: mimeType || null })
      if (!outcome.ok) {
        if (outcome.code === 'STORAGE_QUOTA_EXCEEDED') {
          result.stoppedForQuota = true
          return result
        }
        if (outcome.stop) {
          result.stopped = outcome.message ?? 'the bucket could not take more files'
          return result
        }
        skip(label, SKIP_WORDS[outcome.code ?? ''] ?? 'refused by the upload checks')
        continue
      }
      result.copied++
      result.bytes += buffer.length
      ctx.onFile(result.copied, result.bytes)
    }
  }
  return result
}
