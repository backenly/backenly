/**
 * Uploads up to the 100 MB ceiling reach their route whole, and bigger bodies
 * are refused with 413 before any route runs.
 *
 * Next buffers each request body for the middleware up to
 * experimental.proxyClientMaxBodySize and silently truncates the rest. At its
 * 10 MB default an upload over 10 MB reached the route cut short and was
 * answered with 500, so #171's 100 MB ceiling was really 10 MB. The buffer is
 * now sized for an upload request, and the middleware holds every other route
 * to the 10 MB it had.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  exceededBodyLimit,
  isUploadRoute,
  MAX_BUFFERED_UPLOAD_FILE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  requestBodyLimit,
} from '@/lib/storage/body-limits'
import { MAX_BUFFERED_UPLOAD_BYTES } from '@/lib/storage/upload-policy'

const MB = 1024 * 1024
const PROJECT = '7e89af77-8bb1-4655-84e8-3d1c15b334b4'

describe('which routes take an upload-sized body', () => {
  it('is the two routes that carry a whole file through the server', () => {
    expect(isUploadRoute('/api/storage/upload')).toBe(true)
    expect(isUploadRoute(`/api/v1/${PROJECT}/storage/upload`)).toBe(true)
  })

  it('is nothing else: the multipart chunk route and every JSON route keep 10 MB', () => {
    for (const path of [
      `/api/v1/${PROJECT}/storage/upload-multipart`,
      `/api/v1/${PROJECT}/db/todos`,
      '/api/projects',
      '/api/storage/uploads',
      '/api/storage/upload/extra',
    ]) {
      expect(isUploadRoute(path)).toBe(false)
      expect(requestBodyLimit(path)).toBe(10 * MB)
    }
  })
})

describe('refusing a declared body over its route limit', () => {
  it('lets an upload up to the ceiling plus its multipart envelope through', () => {
    expect(exceededBodyLimit('/api/storage/upload', String(MAX_UPLOAD_REQUEST_BYTES))).toBeNull()
    expect(exceededBodyLimit('/api/storage/upload', String(12 * MB))).toBeNull()
    expect(exceededBodyLimit('/api/storage/upload', String(MAX_UPLOAD_REQUEST_BYTES + 1))).toBe(MAX_UPLOAD_REQUEST_BYTES)
  })

  it('holds every other route to 10 MB', () => {
    expect(exceededBodyLimit('/api/projects', String(10 * MB))).toBeNull()
    expect(exceededBodyLimit('/api/projects', String(10 * MB + 1))).toBe(MAX_REQUEST_BYTES)
  })

  it('cannot judge a body without a usable Content-Length', () => {
    expect(exceededBodyLimit('/api/storage/upload', null)).toBeNull()
    expect(exceededBodyLimit('/api/storage/upload', 'abc')).toBeNull()
    expect(exceededBodyLimit('/api/storage/upload', '-1')).toBeNull()
  })
})

describe('one number everywhere', () => {
  it('sizes the upload request as the file ceiling plus 1 MB of envelope', () => {
    expect(MAX_BUFFERED_UPLOAD_FILE_BYTES).toBe(100 * MB)
    expect(MAX_UPLOAD_REQUEST_BYTES).toBe(101 * MB)
    expect(MAX_BUFFERED_UPLOAD_BYTES).toBe(BigInt(MAX_BUFFERED_UPLOAD_FILE_BYTES))
  })

  it("sets Next's body buffer to exactly the upload request limit", () => {
    // Read as text: requiring next.config.js would also load its Sentry wrapper.
    const config = readFileSync(join(process.cwd(), 'next.config.js'), 'utf8')
    const m = config.match(/proxyClientMaxBodySize:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)
    expect(m).not.toBeNull()
    expect(Number(m![1]) * MB).toBe(MAX_UPLOAD_REQUEST_BYTES)
  })
})
