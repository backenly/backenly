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
 * hop by hop, and the key is dropped on a cross-origin redirect.
 *
 * Each bucket keeps its name and its public / private setting. Objects keep
 * their paths as names. One object is held in memory at a time, up to the
 * bucket's size limit (never over Backenly's 100 MB per-upload ceiling), and
 * goes through the same upload checks as any other upload: quota, executable
 * types (blocked as on every Backenly bucket), type spoofing. An object those
 * checks refuse is skipped and named; the rest keep moving.
 */

import type { ImportPreviewBucket } from './contract'
import { ImportInputError } from './driver'
import { redactedMessage } from './redact'
import { throwIfAborted } from './pg-engine'

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

async function call(
  src: StorageSource,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; maxBytes?: number; timeoutMs?: number } = {},
) {
  const { safeFetch } = await import('@/lib/security/outbound-guard')
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
      maxBytes: opts.maxBytes ?? 20 * 1024 * 1024,
      egressScope: 'import',
    })
  } catch (err) {
    throw new ImportInputError(`Couldn't reach Storage: ${redactedMessage(err, src.secrets, 200)}`, 'projectUrl')
  }
}

function refusal(status: number): ImportInputError {
  if (status === 401 || status === 403) return new ImportInputError('Supabase refused the service_role key. Copy it again from Project Settings → API.', 'serviceRoleKey')
  if (status === 404) return new ImportInputError("That address doesn't answer as Supabase Storage. Check the Project URL.", 'projectUrl')
  return new ImportInputError(`Supabase Storage answered ${status}.`, 'projectUrl')
}

export async function listBuckets(src: StorageSource): Promise<SupabaseBucket[]> {
  const res = await call(src, 'GET', '/storage/v1/bucket')
  if (!res.ok) throw refusal(res.status)
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body)) throw new ImportInputError("That address doesn't answer as Supabase Storage. Check the Project URL.", 'projectUrl')
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

/** Every object of a bucket, folder by folder, page by page. */
export async function* walkObjects(src: StorageSource, bucket: SupabaseBucket, signal: AbortSignal): AsyncGenerator<SourceObject> {
  const folders: string[] = ['']
  while (folders.length > 0) {
    const prefix = folders.shift()!
    // A server may answer fewer entries than asked for (its own page cap), so the
    // next page starts after what came back, and only an empty page ends the folder.
    for (let offset = 0; ; ) {
      throwIfAborted(signal)
      const res = await call(src, 'POST', `/storage/v1/object/list/${encodeURIComponent(bucket.id)}`, {
        body: { prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } },
      })
      if (!res.ok) throw refusal(res.status)
      const page = await res.json().catch(() => null)
      if (!Array.isArray(page) || page.length === 0) break
      offset += page.length
      for (const entry of page) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) continue
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.id === null || entry.id === undefined) {
          folders.push(path)
          continue
        }
        if (entry.name === PLACEHOLDER) continue
        const size = Number(entry.metadata?.size ?? entry.metadata?.contentLength ?? 0)
        yield { bucket: bucket.id, path, size: Number.isFinite(size) ? size : 0, mimeType: entry.metadata?.mimetype ?? null }
      }
    }
  }
}

/** The Review step's buckets: each one walked, its files counted and summed. */
export async function inspectStorage(src: StorageSource, signal: AbortSignal): Promise<ImportPreviewBucket[]> {
  const out: ImportPreviewBucket[] = []
  for (const b of await listBuckets(src)) {
    let files = 0
    let bytes = 0
    for await (const o of walkObjects(src, b, signal)) {
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
  userId: string
  onFile: (copied: number, copiedBytes: number) => void
}

export interface FilesResult {
  copied: number
  bytes: number
  skipped: Array<{ path: string; why: string }>
  /** Set when the plan's storage ran out: nothing after it was tried. */
  stoppedForQuota: boolean
}

/** Download each object and store it in its bucket. */
export async function copyFiles(
  src: StorageSource,
  projectId: string,
  buckets: SupabaseBucket[],
  targets: Map<string, { id: string; maxBytes: number }>,
  ctx: FilesContext,
): Promise<FilesResult> {
  const { storageService } = await import('@/lib/services/storage')
  const { isUploadRejected } = await import('@/lib/storage/upload-policy')
  const { consoleUploader } = await import('@/lib/storage/uploader')
  // uploadedBy is an end user's field; the person moving files in is recorded as the console's uploader.
  const uploader = consoleUploader(ctx.userId)
  const result: FilesResult = { copied: 0, bytes: 0, skipped: [], stoppedForQuota: false }
  ctx.onFile(0, 0)
  for (const b of buckets) {
    const target = targets.get(b.id)
    if (!target) continue
    for await (const o of walkObjects(src, b, ctx.signal)) {
      throwIfAborted(ctx.signal)
      const label = `${b.name}/${o.path}`
      if (o.size > target.maxBytes) {
        result.skipped.push({ path: label, why: `larger than ${Math.round(target.maxBytes / 1024 / 1024)} MB` })
        continue
      }
      const res = await call(src, 'GET', `/storage/v1/object/${encodeURIComponent(b.id)}/${encodePath(o.path)}`, {
        maxBytes: target.maxBytes + 1,
        timeoutMs: 5 * 60_000,
      }).catch((err) => {
        result.skipped.push({ path: label, why: err instanceof Error ? err.message : 'download failed' })
        return null
      })
      if (!res) continue
      if (!res.ok) {
        result.skipped.push({ path: label, why: `Supabase answered ${res.status}` })
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const mimeType = o.mimeType ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? undefined
      try {
        await storageService.uploadFile(
          target.id,
          { name: o.path, buffer, mimeType: mimeType || undefined },
          { projectId, uploader },
        )
      } catch (err) {
        if (isUploadRejected(err)) {
          if ((err as any).code === 'STORAGE_QUOTA_EXCEEDED') {
            result.stoppedForQuota = true
            return result
          }
          result.skipped.push({ path: label, why: SKIP_WORDS[(err as any).code as string] ?? 'refused by the upload checks' })
          continue
        }
        throw err
      }
      result.copied++
      result.bytes += buffer.length
      ctx.onFile(result.copied, result.bytes)
    }
  }
  return result
}
