/**
 * How Storage says its values: sizes, file types, who sent a file, and what a
 * bucket's read rule means. Plain functions, shared by the bar, the rail, the
 * grid, the file drawer and the policy dialog, so each says it the same way.
 */

import type { StorageFile } from '@/lib/api/storage'
import { ACCESS_POLICIES, type AccessPolicy } from '@/lib/storage/access-policy'

/** A number from the API: sizes arrive as BigInt strings from the files route. */
export function toNum(v: number | string | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')

/**
 * "312.4 MB", "107.6 KB", "1 GB", "1.25 GB": 1024-based, as the quota is
 * enforced. Whole gigabytes drop the ".0", so a plan reads "1 GB".
 */
export function formatBytes(value: number | string | bigint | null | undefined): string {
  const bytes = toNum(value)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${trim(bytes / 1024 ** 3, 2)} GB`
  return `${trim(bytes / 1024 ** 4, 2)} TB`
}

/** "image/jpeg" reads as "jpeg". */
export function shortType(mimeType: string | null | undefined): string {
  if (!mimeType) return 'file'
  const sub = mimeType.split('/')[1]
  return (sub || mimeType).split(';')[0]
}

/** What a file is, for its kind icon. */
export type FileKind = 'image' | 'document' | 'data' | 'other'

export function fileKind(mimeType: string | null | undefined): FileKind {
  if (!mimeType) return 'other'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.startsWith('text/plain')) return 'document'
  if (mimeType.includes('csv') || mimeType.includes('json') || mimeType.includes('spreadsheet')) return 'data'
  return 'other'
}

// ── Who sent a file ─────────────────────────────────────────────────────────

/**
 * Who sent a file, in the grid and the drawer (lib/storage/uploader-labels.ts
 * names them on the server). The label is the uploader's own words; the title
 * says what that kind of sender is.
 */
const UPLOADER_TITLE: Record<NonNullable<StorageFile['uploader']>['kind'], string> = {
  end_user: 'A signed-in user of your app',
  anonymous: 'Sent with the public key, by no signed-in user',
  server_key: 'Sent by a server with a service key',
  console: 'Uploaded from the console',
}

export const uploaderLabel = (file: StorageFile): string => file.uploader?.label ?? '—'

export const uploaderTitle = (file: StorageFile): string =>
  `${uploaderLabel(file)}: ${file.uploader ? UPLOADER_TITLE[file.uploader.kind] : 'Not recorded for this file'}`

// ── Read rules ──────────────────────────────────────────────────────────────

/** The four read rules, in plain words (the policy dialog's options). */
export const POLICY_WORDS: Record<AccessPolicy, { title: string; means: string }> = {
  public_read: { title: 'Public', means: 'Anyone with the link.' },
  cdn_cacheable: { title: 'Public, cached by the CDN', means: 'Same, with a shorter cache for files that change.' },
  private: { title: 'Private', means: 'Your team, or a signed link your app asks for.' },
  owner_only: { title: 'Owner only', means: 'The person who uploaded it, and your team. Signed links don’t work.' },
}

/** A bucket's policy as stored, read safely: anything unknown is private (the server's own fallback). */
export function policyOf(value: string | null | undefined): AccessPolicy {
  return (ACCESS_POLICIES as readonly string[]).includes(value ?? '') ? (value as AccessPolicy) : 'private'
}

/** The policy lets a bucket's files be read by anyone. */
export function isPublicPolicy(value: string | null | undefined): boolean {
  const p = policyOf(value)
  return p === 'public_read' || p === 'cdn_cacheable'
}

/**
 * A file's own access, only where it is narrower than its bucket's: a private
 * file in a public bucket. Never the other way, since the bucket is the
 * ceiling (lib/storage/access-policy.ts).
 */
export function narrowerAccess(file: StorageFile, bucketPolicy: string | null | undefined): 'Private' | null {
  return isPublicPolicy(bucketPolicy) && !file.isPublic ? 'Private' : null
}

// ── Links ───────────────────────────────────────────────────────────────────

/** A file's address as one that works outside the console: the API answers relative paths on this origin. */
export function absoluteUrl(url: string): string {
  if (typeof window === 'undefined') return url
  try {
    return new URL(url, window.location.origin).href
  } catch {
    return url
  }
}

/** Starts a download of one file, the way an <a download> does, from a menu item. */
export function downloadFile(file: Pick<StorageFile, 'url' | 'name'>): void {
  const a = document.createElement('a')
  a.href = file.url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** "1 file", "240 files". */
export function filesWord(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`
}
