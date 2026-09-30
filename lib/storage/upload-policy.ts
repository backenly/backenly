/**
 * What an upload must satisfy before any byte is stored, and how a refusal is
 * answered.
 *
 * Both storage drivers (lib/services/storage.ts, lib/services/s3Storage.ts)
 * carried their own copy of these checks, and threw plain Errors. So every
 * upload route answered a policy refusal (an executable, a disallowed type, a
 * file over the bucket's limit) with HTTP 500, as if the server had failed; the
 * end-user route only rescued some of them by matching words in the message.
 * One set of checks now, and one error type that carries its own status.
 */
import path from 'path'
import { MAX_BUFFERED_UPLOAD_FILE_BYTES } from '@/lib/storage/body-limits'

export type UploadRejectionCode =
  | 'BUCKET_NOT_FOUND'
  | 'BUCKET_NOT_IN_PROJECT'
  | 'PROJECT_NOT_FOUND'
  | 'EXECUTABLE_BLOCKED'
  | 'EXTENSION_NOT_ALLOWED'
  | 'MIME_TYPE_NOT_ALLOWED'
  | 'MIME_TYPE_MISMATCH'
  | 'FILE_TOO_LARGE'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'FILE_EXISTS'

const STATUS: Record<UploadRejectionCode, 400 | 403 | 404 | 409 | 413> = {
  BUCKET_NOT_FOUND: 404,
  BUCKET_NOT_IN_PROJECT: 403,
  PROJECT_NOT_FOUND: 404,
  EXECUTABLE_BLOCKED: 400,
  EXTENSION_NOT_ALLOWED: 400,
  MIME_TYPE_NOT_ALLOWED: 400,
  MIME_TYPE_MISMATCH: 400,
  FILE_TOO_LARGE: 413,
  STORAGE_QUOTA_EXCEEDED: 413,
  FILE_EXISTS: 409,
}

/** A refusal of the upload itself: the caller's to fix, never a server failure. */
export class UploadRejectedError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413
  constructor(readonly code: UploadRejectionCode, message: string) {
    super(message)
    this.name = 'UploadRejectedError'
    this.status = STATUS[code]
  }
}

export function isUploadRejected(err: unknown): err is UploadRejectedError {
  return err instanceof UploadRejectedError
}

export const DANGEROUS_EXTENSIONS: readonly string[] = [
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1', '.app', '.deb', '.rpm',
  '.msi', '.dmg', '.pkg', '.run', '.bin', '.jar', '.dll', '.so', '.dylib',
  '.scr', '.vbs', '.js', '.jse', '.wsf', '.wsh', '.com', '.pif', '.lnk',
]

/** The MIME types an extension may claim; a mismatch is treated as spoofing. */
const EXTENSION_MIME: Record<string, string[]> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.svg': ['image/svg+xml'],
  '.pdf': ['application/pdf'],
  '.txt': ['text/plain'],
  '.csv': ['text/csv', 'application/csv'],
  '.mp4': ['video/mp4'],
  '.webm': ['video/webm'],
  '.ogv': ['video/ogg'],
  '.mov': ['video/quicktime'],
  '.avi': ['video/x-msvideo'],
  '.mp3': ['audio/mpeg'],
  '.wav': ['audio/wav', 'audio/x-wav'],
  '.ogg': ['audio/ogg'],
  '.m4a': ['audio/mp4'],
}

export interface BucketUploadRules {
  blockExecutables: boolean
  allowedExtensions: string[]
  allowedMimeTypes: string[]
}

/**
 * The extension as the checks see it: everything from the LAST dot, lowercased.
 * Deliberately not path.extname, which returns '' for a dotfile, so a file named
 * `.sh` would pass the executable check (the S3 driver always blocked it).
 */
export function uploadExtension(name: string): string {
  const base = path.basename(name)
  return base.includes('.') ? base.substring(base.lastIndexOf('.')).toLowerCase() : ''
}

/** Type and extension checks for one file against its bucket's rules. */
export function assertFileAllowed(bucket: BucketUploadRules, file: { name: string; mimeType?: string | null }): void {
  const ext = uploadExtension(file.name)
  const mime = file.mimeType || 'application/octet-stream'

  if (bucket.blockExecutables && DANGEROUS_EXTENSIONS.includes(ext)) {
    throw new UploadRejectedError(
      'EXECUTABLE_BLOCKED',
      `Executable files are not allowed. File extension "${ext}" is blocked for security.`,
    )
  }
  if (bucket.allowedExtensions.length > 0 && !bucket.allowedExtensions.includes(ext)) {
    throw new UploadRejectedError(
      'EXTENSION_NOT_ALLOWED',
      `File extension "${ext}" is not allowed in this bucket. Allowed extensions: ${bucket.allowedExtensions.join(', ')}`,
    )
  }
  if (bucket.allowedMimeTypes.length > 0 && !bucket.allowedMimeTypes.includes(mime)) {
    throw new UploadRejectedError(
      'MIME_TYPE_NOT_ALLOWED',
      `File type "${mime}" is not allowed in this bucket. Allowed types: ${bucket.allowedMimeTypes.join(', ')}`,
    )
  }
  const expected = EXTENSION_MIME[ext]
  if (expected && !expected.includes(mime)) {
    throw new UploadRejectedError(
      'MIME_TYPE_MISMATCH',
      `File extension "${ext}" does not match MIME type "${mime}". Possible file spoofing detected.`,
    )
  }
}

/**
 * The most one upload may carry when it passes through the server, which holds
 * the whole file in memory on its way to storage. Direct-to-S3 multipart
 * uploads never pass through and are bounded by their own route. The request
 * body that carries it is sized in lib/storage/body-limits.ts, which is also
 * what the middleware and Next's body buffer are set from.
 */
export const MAX_BUFFERED_UPLOAD_BYTES = BigInt(MAX_BUFFERED_UPLOAD_FILE_BYTES)

/**
 * The per-file rule, the same for both drivers: the bucket's own limit, which
 * its owner sets, and never more than MAX_BUFFERED_UPLOAD_BYTES.
 *
 * Project.maxFileSize is deliberately not part of it. Nothing can set that
 * column (it is 10 MB on every project), and the local driver used to apply
 * it, so a bucket raised above 10 MB, and every local multipart upload over
 * 10 MB, was refused on self-host while Backenly Cloud accepted the same file.
 */
export function assertFileSize(size: bigint, limits: { bucketMaxBytes: bigint }): void {
  const mb = (b: bigint) => Number(b) / (1024 * 1024)
  if (size > limits.bucketMaxBytes) {
    throw new UploadRejectedError(
      'FILE_TOO_LARGE',
      `File size (${mb(size).toFixed(2)}MB) exceeds bucket's maximum allowed size (${mb(limits.bucketMaxBytes)}MB)`,
    )
  }
  if (size > MAX_BUFFERED_UPLOAD_BYTES) {
    throw new UploadRejectedError(
      'FILE_TOO_LARGE',
      `File size (${mb(size).toFixed(2)}MB) exceeds the ${mb(MAX_BUFFERED_UPLOAD_BYTES)}MB limit for a single upload. ` +
        'Use a multipart upload for larger files.',
    )
  }
}
