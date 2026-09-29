/**
 * How large a request body the web server takes, per route.
 *
 * Dependency-free on purpose: middleware.ts runs on the Edge runtime and imports
 * this, and so does lib/storage/upload-policy.ts on Node.
 *
 * ── Why the middleware has to know ─────────────────────────────────────────
 *
 * With middleware present, Next buffers each request body in memory so both the
 * middleware and the route can read it, up to `experimental.proxyClientMaxBodySize`
 * (next.config.js). Past that it keeps the first N bytes and says nothing to the
 * route, so a larger upload reached the upload route truncated,
 * `request.formData()` threw, and the caller got 500. The default was 10 MB,
 * which made the 100 MB ceiling of lib/storage/upload-policy.ts a 10 MB one.
 *
 * The buffer is one setting for every route, so it is raised to what an upload
 * needs, and the middleware refuses a body over ITS route's limit, with 413,
 * before any route runs: uploads get the upload ceiling, everything else keeps
 * the 10 MB it had. A body with no Content-Length (chunked) cannot be refused
 * up front; the upload routes answer a body they cannot parse with 400.
 */

const MB = 1024 * 1024

/** The most one file may carry through the server (upload-policy.ts). */
export const MAX_BUFFERED_UPLOAD_FILE_BYTES = 100 * MB

/**
 * A multipart upload request is the file plus its envelope: boundaries, part
 * headers and the small form fields (bucket, path, isPublic).
 */
export const UPLOAD_ENVELOPE_BYTES = 1 * MB

/** The largest upload request body. next.config.js proxyClientMaxBodySize equals it. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_BUFFERED_UPLOAD_FILE_BYTES + UPLOAD_ENVELOPE_BYTES

/** Every other route: Next's own default, which is what they always had. */
export const MAX_REQUEST_BYTES = 10 * MB

/** The routes that take a whole file through the server. */
const UPLOAD_ROUTE = /^\/api\/(?:storage\/upload|v1\/[^/]+\/storage\/upload)\/?$/

export function isUploadRoute(pathname: string): boolean {
  return UPLOAD_ROUTE.test(pathname)
}

export function requestBodyLimit(pathname: string): number {
  return isUploadRoute(pathname) ? MAX_UPLOAD_REQUEST_BYTES : MAX_REQUEST_BYTES
}

/**
 * The limit a request's declared body exceeds, or null when it may proceed.
 * Only a declared Content-Length can be judged before the body arrives.
 */
export function exceededBodyLimit(pathname: string, contentLength: string | null): number | null {
  if (!contentLength) return null
  const declared = Number(contentLength)
  if (!Number.isFinite(declared) || declared < 0) return null
  const limit = requestBodyLimit(pathname)
  return declared > limit ? limit : null
}
