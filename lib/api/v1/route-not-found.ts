/**
 * The JSON 404 for any /api/v1/{projectId}/… path with no handler.
 *
 * ── Why this is shared, not duplicated ───────────────────────────────────────
 *
 * A wrong runtime path used to return the MARKETING SITE:
 *
 *     GET /api/v1/{id}/storage/product-images
 *     → 404  <!DOCTYPE html><html lang="en" class="__variable_64f856">…
 *
 * Every client on this API parses JSON, so an HTML body breaks them at the
 * parse rather than the status code: the real failure ("that path does not
 * exist") arrives as `SyntaxError: Unexpected token '<'`, which points at the
 * caller's own code. An agent hitting four such 404s concluded storage had no
 * runtime at all and stopped — while `/buckets`, which happened to reach a
 * different handler, correctly returned `{"error":"Resource not found"}`. The
 * API could already answer properly; those paths never reached the answer.
 *
 * TWO runtimes can be the last thing a request touches, and both must give the
 * same answer:
 *   • Express (server/) — nginx routes ALL /api/v1/* here in production;
 *   • Next.js (app/api/v1/…) — local dev, and proxied sections.
 * The body lives here so neither can drift into its own vocabulary. That drift
 * IS the bug class: three surfaces once claimed three different CRUD paths.
 */

/**
 * The real surface, grouped by the prefix a caller was probably aiming for.
 * Data, so the hint can be scoped to the section actually attempted — dumping
 * forty routes on someone who mistyped one storage path is noise.
 */
export const V1_ROUTES: Record<string, string[]> = {
  db: [
    'GET    /db/{table}            list rows (?column=value, ?limit=, ?offset=, ?order=)',
    'POST   /db/{table}            create a row',
    'GET    /db/{table}/{id}       read one row',
    'PUT    /db/{table}/{id}       update one row',
    'DELETE /db/{table}/{id}       delete one row',
  ],
  auth: [
    'POST   /auth/signup           { email, password } → { token, user }',
    'POST   /auth/signin           { email, password } → { token, user }',
    'POST   /auth/signout',
    'GET    /auth/me               requires X-User-Token',
    'POST   /auth/refresh',
  ],
  storage: [
    'POST   /storage/upload            multipart: file, bucket, path, isPublic',
    'POST   /storage/signed-upload     { bucket, path, contentType } → direct-to-S3 URL',
    'POST   /storage/confirm-upload    { bucket, path } after a signed upload',
    'POST   /storage/upload-multipart  large files, chunked',
    'GET    /storage/files             ?bucket=&prefix=&limit=',
    'GET    /storage/files/{fileId}    metadata or download',
    'DELETE /storage/files/{fileId}',
  ],
  realtime: [
    'GET    /realtime              SSE stream (?tables=a,b)',
    'POST   /broadcast             { channel, event, payload } — ephemeral, 6KB cap',
    'GET    /presence              who is currently active',
  ],
  fn: [
    'GET|POST /fn/{name}           invoke a deployed function',
    'GET    /functions             list deployed functions with their exact URLs',
  ],
}

/**
 * Storage is guessed wrong most often, because the bucket-scoped shape
 * (`/storage/{bucket}/upload`) is what several other platforms use. A bucket is
 * a PARAMETER here, never a path segment — say it, rather than leaving the
 * caller to infer it from a route list.
 */
export const V1_SECTION_NOTES: Record<string, string> = {
  storage:
    'Buckets are a parameter, not a path segment: POST /storage/upload with `bucket` in the form body, ' +
    'and GET /storage/files?bucket=<name> to list. There is no /storage/{bucket}/… route.',
  db: 'The /db/ prefix is required. There is no bare /{table} route.',
  fn:
    'Function names are normalised to lowercase kebab-case (list_products deploys as list-products). ' +
    "GET /functions returns each one's exact URL.",
}

export interface V1NotFoundBody {
  error: string
  code: 'ROUTE_NOT_FOUND'
  hint?: string
  availableRoutes: string[]
  docs: string
}

/**
 * Build the 404 body. `segments` is the path AFTER the project id.
 *
 * Always names the routes that DO exist — a machine API's 404 should leave the
 * caller with the real vocabulary, so the next attempt is right rather than
 * another guess.
 */
export function v1NotFoundBody(projectId: string, segments: string[]): V1NotFoundBody {
  const attempted = `/api/v1/${projectId}/${segments.join('/')}`
  const section = (segments[0] ?? '').toLowerCase()
  const known = V1_ROUTES[section]

  return {
    error: `No route matches ${attempted}`,
    code: 'ROUTE_NOT_FOUND',
    ...(V1_SECTION_NOTES[section] ? { hint: V1_SECTION_NOTES[section] } : {}),
    // Scoped when the section is recognised, complete when it is not.
    availableRoutes: known ?? Object.values(V1_ROUTES).flat(),
    docs: 'https://backenly.com/llms.txt',
  }
}
