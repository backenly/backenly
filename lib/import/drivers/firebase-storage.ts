/**
 * Cloud Storage for Firebase → one private Backenly bucket, `files`.
 *
 * The project's default bucket is named by its Firebase config
 * (`<project>.firebasestorage.app` for projects made since October 2024,
 * `<project>.appspot.com` before). When the config does not say, both names
 * are tried. Objects are listed with the Cloud Storage JSON API and downloaded
 * one by one (alt=media); each keeps its path as its name in Backenly.
 * Folder placeholders (a name ending in "/", empty) are not files and are not
 * moved. Reading only: list and get.
 */

import { GoogleApiError, type GoogleClient } from '../google-http'

const GCS = 'https://storage.googleapis.com/storage/v1'
const FIREBASE = 'https://firebase.googleapis.com/v1beta1'

export interface GcsObject {
  name: string
  size: number
  contentType: string | null
}

export interface FirebaseProjectInfo {
  displayName: string | null
  /** From the project's config; may be absent on newer projects. */
  storageBucket: string | null
}

/** The project's display name and default bucket, as far as its config says. Never throws for a refusal. */
export async function readProjectInfo(client: GoogleClient, projectId: string): Promise<FirebaseProjectInfo> {
  const info: FirebaseProjectInfo = { displayName: null, storageBucket: null }
  try {
    const p = await client.json<any>('firebase', 'firebase', 'GET', `${FIREBASE}/projects/${encodeURIComponent(projectId)}`)
    if (typeof p?.displayName === 'string' && p.displayName.trim()) info.displayName = p.displayName.trim()
    if (typeof p?.resources?.storageBucket === 'string' && p.resources.storageBucket) info.storageBucket = p.resources.storageBucket
  } catch (err) {
    if (!(err instanceof GoogleApiError)) throw err
  }
  if (!info.storageBucket) {
    try {
      const c = await client.json<any>('firebase', 'firebase', 'GET', `${FIREBASE}/projects/${encodeURIComponent(projectId)}/adminSdkConfig`)
      if (typeof c?.storageBucket === 'string' && c.storageBucket) info.storageBucket = c.storageBucket
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err
    }
  }
  return info
}

/** Bucket names are lowercase letters, digits, dots, dashes and underscores. */
function validBucket(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name)
}

/** One page of a bucket's objects. */
export async function listObjectsPage(
  client: GoogleClient,
  bucket: string,
  pageToken?: string,
  pageSize = 1000,
): Promise<{ objects: GcsObject[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(pageSize), fields: 'items(name,size,contentType),nextPageToken' })
  if (pageToken) q.set('pageToken', pageToken)
  const res = await client.json<{ items?: Array<{ name?: string; size?: string; contentType?: string }>; nextPageToken?: string }>(
    'storage', 'storage', 'GET',
    `${GCS}/b/${encodeURIComponent(bucket)}/o?${q.toString()}`,
  )
  const objects: GcsObject[] = []
  for (const it of res.items ?? []) {
    if (typeof it.name !== 'string' || !it.name) continue
    const size = Number(it.size ?? 0)
    // A "folder" made in the console is an empty object named like a directory.
    if (it.name.endsWith('/') && size === 0) continue
    objects.push({ name: it.name, size: Number.isFinite(size) ? size : 0, contentType: it.contentType || null })
  }
  return { objects, nextPageToken: res.nextPageToken || undefined }
}

/** Every object, page by page. */
export async function* listObjects(client: GoogleClient, bucket: string): AsyncGenerator<GcsObject[]> {
  let token: string | undefined
  do {
    const page = await listObjectsPage(client, bucket, token)
    if (page.objects.length) yield page.objects
    token = page.nextPageToken
  } while (token)
}

export interface DefaultBucket {
  bucket: string | null
  /** Why there is none to read, in plain words. */
  problem: string | null
}

/**
 * The default bucket, checked by listing one object: the config's name first,
 * then the two names Firebase gives default buckets.
 */
export async function findDefaultBucket(client: GoogleClient, projectId: string, fromConfig: string | null): Promise<DefaultBucket> {
  const bare = projectId.includes(':') ? projectId.split(':').pop()! : projectId
  const candidates = [...new Set([fromConfig, `${bare}.firebasestorage.app`, `${bare}.appspot.com`].filter((b): b is string => !!b && validBucket(b)))]
  let denied: GoogleApiError | null = null
  for (const bucket of candidates) {
    try {
      await listObjectsPage(client, bucket, undefined, 1)
      return { bucket, problem: null }
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err
      if (err.status === 404) continue
      if (err.status === 403) {
        // Cloud Storage answers 403 for a bucket that exists and one that does
        // not when the caller may not list either. Keep looking; say it at the end.
        denied = denied ?? err
        continue
      }
      throw err
    }
  }
  if (denied) return { bucket: null, problem: denied.serviceDisabled ? denied.message : "This key can't read Cloud Storage. Give the service account the Storage Object Viewer role." }
  return { bucket: null, problem: null }
}

/** One object's bytes, refused past `maxBytes`. */
export async function downloadObject(client: GoogleClient, bucket: string, name: string, maxBytes: number): Promise<Buffer> {
  const res = await client.bytes(
    'storage', 'storage',
    `${GCS}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`,
    { maxBytes: maxBytes + 1, timeoutMs: 10 * 60_000 },
  )
  return res.body
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.json': 'application/json',
  '.heic': 'image/heic', '.avif': 'image/avif', '.zip': 'application/zip',
}

/**
 * The type a file is stored with: Cloud Storage's own, unless it says nothing
 * useful, in which case the extension's.
 */
export function mimeTypeFor(name: string, contentType: string | null): string | null {
  const base = name.split('/').pop() ?? name
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : ''
  const generic = !contentType || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream'
  if (!generic) return contentType!.split(';')[0].trim().toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? contentType ?? null
}
