/**
 * An upload the bucket refuses is the caller's to fix, and is answered as such.
 *
 * Both storage drivers carried their own copy of these checks and threw plain
 * Errors, so every upload route answered a blocked executable, a disallowed
 * type or an oversize file with HTTP 500 (measured on AWS staging 2026-09-29: a
 * `.bin` upload through /api/storage/upload returned 500). The checks now live
 * once in lib/storage/upload-policy.ts and throw an error that carries its
 * status.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  UploadRejectedError,
  assertFileAllowed,
  assertFileSize,
  isUploadRejected,
  uploadExtension,
} from '@/lib/storage/upload-policy'

const open = { blockExecutables: true, allowedExtensions: [] as string[], allowedMimeTypes: [] as string[] }
const refusal = (fn: () => void) => {
  try {
    fn()
  } catch (e) {
    if (isUploadRejected(e)) return { code: e.code, status: e.status, message: e.message }
    throw e
  }
  return null
}

describe('type and extension', () => {
  it('blocks executables, including a dotfile such as ".sh"', () => {
    expect(refusal(() => assertFileAllowed(open, { name: 'tool.bin', mimeType: 'application/octet-stream' })))
      .toMatchObject({ code: 'EXECUTABLE_BLOCKED', status: 400 })
    expect(refusal(() => assertFileAllowed(open, { name: '.sh' }))).toMatchObject({ code: 'EXECUTABLE_BLOCKED', status: 400 })
    expect(uploadExtension('.sh')).toBe('.sh')
    expect(uploadExtension('dir/Photo.JPG')).toBe('.jpg')
    expect(uploadExtension('README')).toBe('')
  })

  it('lets executables through only where the bucket allows them', () => {
    expect(refusal(() => assertFileAllowed({ ...open, blockExecutables: false }, { name: 'tool.bin' }))).toBeNull()
  })

  it("enforces the bucket's extension and MIME allow-lists", () => {
    expect(refusal(() => assertFileAllowed({ ...open, allowedExtensions: ['.png'] }, { name: 'a.pdf', mimeType: 'application/pdf' })))
      .toMatchObject({ code: 'EXTENSION_NOT_ALLOWED', status: 400 })
    expect(refusal(() => assertFileAllowed({ ...open, allowedMimeTypes: ['image/png'] }, { name: 'a.pdf', mimeType: 'application/pdf' })))
      .toMatchObject({ code: 'MIME_TYPE_NOT_ALLOWED', status: 400 })
  })

  it('refuses an extension that claims another type (spoofing)', () => {
    expect(refusal(() => assertFileAllowed(open, { name: 'x.png', mimeType: 'text/html' })))
      .toMatchObject({ code: 'MIME_TYPE_MISMATCH', status: 400 })
    expect(refusal(() => assertFileAllowed(open, { name: 'x.png', mimeType: 'image/png' }))).toBeNull()
    expect(refusal(() => assertFileAllowed(open, { name: 'notes.txt', mimeType: 'text/plain' }))).toBeNull()
  })
})

describe('size', () => {
  const MB = BigInt(1024 * 1024)
  it("answers 413 past the bucket's or the project's per-file limit", () => {
    expect(refusal(() => assertFileSize(BigInt(6) * MB, { bucketMaxBytes: BigInt(5) * MB })))
      .toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 })
    expect(refusal(() => assertFileSize(BigInt(6) * MB, { bucketMaxBytes: BigInt(10) * MB, projectMaxBytes: BigInt(5) * MB })))
      .toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 })
    expect(refusal(() => assertFileSize(BigInt(4) * MB, { bucketMaxBytes: BigInt(5) * MB, projectMaxBytes: null }))).toBeNull()
  })
})

describe('statuses', () => {
  it('maps every refusal to a client status, never 5xx', () => {
    for (const [code, status] of [
      ['BUCKET_NOT_FOUND', 404], ['BUCKET_NOT_IN_PROJECT', 403], ['PROJECT_NOT_FOUND', 404],
      ['FILE_EXISTS', 409], ['STORAGE_QUOTA_EXCEEDED', 413],
    ] as const) {
      expect(new UploadRejectedError(code, 'x').status).toBe(status)
    }
  })
})

describe('one copy of the checks', () => {
  const ROOT = join(__dirname, '..', '..')
  it.each(['lib/services/storage.ts', 'lib/services/s3Storage.ts'])('%s uses the shared policy', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    expect(src).toMatch(/from '@\/lib\/storage\/upload-policy'/)
    expect(src).toMatch(/assertFileAllowed\(bucket, file\)/)
    expect(src).not.toMatch(/const DANGEROUS_EXTENSIONS/)
    expect(src).not.toMatch(/extensionMimeMap/)
  })

  it.each(['app/api/storage/upload/route.ts', 'app/api/v1/[projectId]/storage/upload/route.ts'])('%s answers a refusal with its status', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    expect(src).toMatch(/isUploadRejected\(error\)/)
    expect(src).toMatch(/error\.status/)
  })
})
