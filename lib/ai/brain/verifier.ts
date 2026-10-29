/**
 * BRAIN VERIFIER
 * ==============
 * Real runtime verification — calls the generated REST endpoint and asserts
 * the response. Replaces the legacy "the table exists, therefore the API
 * works" check that was showing green when endpoints actually 500'd.
 *
 * Phase 2 baseline:
 *   - LIST verification: GET the endpoint, accept 200/401/403, fail on 404/500.
 *     Auth-required responses are PASS because they prove the endpoint is
 *     wired and enforcing security.
 *   - CREATE verification: insert a real row as a throwaway signed-in end
 *     user, and remove the row and the user again (verify-create.ts). A
 *     refusal passes only when there was no one allowed to write as: no
 *     end-user sign-up, or a table only the service role writes.
 *   - GET verification: list one row, then GET it by id, accept 200/401/403,
 *     fail on 404/500. With no row to fetch the route was not exercised,
 *     which is a fail, never a pass.
 *
 * Auth: the project's ANON key. It is public by design (Project.anonKey), so
 * using it here does not require any secret credential to be recoverable from
 * the database, and it is the same credential a real frontend would present.
 *
 * This previously read the first ApiKey row's persisted plaintext, which was
 * the last thing in the codebase depending on secret keys being stored in the
 * clear. See lib/auth/api-key-plaintext.ts.
 *
 * If no credential can be obtained, a 401/403 is NOT a pass: an unauthenticated
 * request proves nothing about whether the endpoint works, and reporting it as
 * verified is exactly the silent-success failure this module exists to end.
 *
 * Future: hook into the deployment URL once deployed; for now we hit the
 * platform-internal route at NEXT_PUBLIC_APP_URL.
 */

import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { verifyCreate } from './verify-create'

export interface EndpointTestInput {
  projectId: string
  tableName: string
  operation: 'list' | 'create' | 'get'
  sessionToken?: string
  /** How long the request may take. Defaults to REQUEST_TIMEOUT_MS; tests shorten it. */
  timeoutMs?: number
}

export interface EndpointTestResult {
  ok: boolean
  /** Human-readable summary used as the tool's `summary` field. */
  summary: string
  endpoint: string
  method: string
  statusCode: number | null
  /** Brief excerpt of the response body for the model to reason over. */
  bodyExcerpt: string
  /** For a list that answered with a row: that row's id, which get then fetches. */
  firstRowId?: string
  /** When ok=false, why. */
  failureKind?:
    | 'not_found' | 'server_error' | 'bad_request' | 'no_endpoint' | 'no_app_url' | 'no_table' | 'fetch_failed'
    | 'unauthenticated' | 'no_rows' | 'timeout'
    /** create, as a signed-in user: refused where that user should be able to insert. */
    | 'forbidden'
    /** create: no row the table accepts could be built (a reference the test does not create). */
    | 'no_valid_row'
}

const APP_URL_ENV = ['NEXT_PUBLIC_APP_URL', 'APP_URL'] as const

/**
 * How long one request to the runtime may take. run_test runs inside the agent
 * turn, which MCP caps at 90 seconds, so a connection that hangs must not be
 * able to spend it. Ten seconds is plenty for one CRUD call.
 */
const REQUEST_TIMEOUT_MS = 10_000

function resolveAppUrl(): string | null {
  for (const k of APP_URL_ENV) {
    const v = process.env[k]
    if (v && /^https?:\/\//.test(v)) return v.replace(/\/$/, '')
  }
  return null
}

async function resolveAnonKey(projectId: string): Promise<string | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { anonKey: true },
    })
    return project?.anonKey ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the project's real workspace schema name. The DB record is the
 * source of truth; fall back to the canonical generator. NEVER hand-roll
 * the transform — `sanitizeIdentifier` keeps hyphens, so a naive
 * `.replace(/-/g,'_')` produces the wrong schema and every lookup fails.
 */
async function resolveWorkspaceSchema(projectId: string): Promise<string> {
  try {
    const ws = await prisma.workspace.findFirst({
      where: { projectId },
      select: { postgresSchema: true },
    })
    if (ws?.postgresSchema) return ws.postgresSchema
  } catch {
    /* fall through to canonical generator */
  }
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  return getWorkspaceDatabaseNames(projectId).postgresSchema
}

/**
 * Load column info for a table from the workspace PostgreSQL schema.
 * The platform's prisma.Table model only stores metadata; column definitions
 * live in the workspace schema's information_schema.
 */
async function loadTableColumns(
  projectId: string,
  tableName: string,
): Promise<Array<{ name: string; type: string; nullable: boolean }> | null> {
  const db = await workspaceRawClient(projectId)
  try {
    const schema = await resolveWorkspaceSchema(projectId)
    const rows = await db.$queryRawUnsafe<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      schema,
      tableName,
    )
    if (!rows?.length) return null
    return rows
      .filter(r => r.column_name !== 'id' && r.column_name !== 'created_at' && r.column_name !== 'updated_at')
      .map(r => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
      }))
  } catch {
    return null
  }
}

function synthesiseSampleRow(
  columns: Array<{ name: string; type: string; nullable: boolean }>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const c of columns) {
    if (c.nullable) continue
    row[c.name] = sampleValueFor(c.type, c.name)
  }
  return row
}

function sampleValueFor(type: string, name: string): unknown {
  const t = type.toLowerCase()
  if (t.includes('int') || t.includes('numeric') || t.includes('float') || t.includes('decimal')) return 1
  if (t.includes('bool')) return true
  if (t.includes('json')) return {}
  if (t.includes('uuid')) return '00000000-0000-0000-0000-000000000000'
  if (t.includes('timestamp') || t.includes('date')) return new Date().toISOString()
  // text / varchar / default
  if (/email/i.test(name)) return 'verify@brain.local'
  if (/url/i.test(name)) return 'https://example.com'
  return `brain-verify-${name}`.slice(0, 32)
}

/**
 * Verify a single endpoint. Returns ok=true when the endpoint is reachable
 * and behaving — including auth-required responses, which prove it's wired.
 */
export async function runEndpointTest(input: EndpointTestInput): Promise<EndpointTestResult> {
  if (input.operation === 'create') return createAsTestUser(input)
  if (input.operation !== 'get') return requestEndpoint(input)

  // get is the get-by-id route, so it needs the id of a row that exists: list
  // one row, then fetch that row. A list that fails is reported as that
  // failure. A list that answers without a row to fetch leaves the route
  // unexercised, and an unexercised route is not a pass.
  const listed = await requestEndpoint({ ...input, operation: 'list' })
  if (!listed.ok) return listed
  if (listed.firstRowId === undefined) {
    return {
      ok: false,
      summary:
        `${listed.summary} The list gave no row to fetch by id, so the get route was not exercised ` +
        'and nothing about it was verified.',
      endpoint: listed.endpoint,
      method: listed.method,
      statusCode: listed.statusCode,
      bodyExcerpt: listed.bodyExcerpt,
      failureKind: 'no_rows',
    }
  }
  return requestEndpoint(input, listed.firstRowId)
}

/**
 * create inserts a real row as a signed-in test user (verify-create.ts). The
 * anon key's own refusal used to be its whole result, and that passed on every
 * table whatever its insert path did (#248). Without an address to call or a
 * key to send, there is nothing to insert with, and requestEndpoint says which;
 * a table whose columns cannot be read falls back the same way.
 */
async function createAsTestUser(input: EndpointTestInput): Promise<EndpointTestResult> {
  const appUrl = resolveAppUrl()
  const anonKey = await resolveAnonKey(input.projectId)
  if (!appUrl || !anonKey) return requestEndpoint(input)
  const created = await verifyCreate({
    projectId: input.projectId,
    tableName: input.tableName,
    schema: await resolveWorkspaceSchema(input.projectId),
    appUrl,
    anonKey,
    timeoutMs: input.timeoutMs ?? REQUEST_TIMEOUT_MS,
  })
  return created ?? requestEndpoint(input)
}

/**
 * One request to the table's endpoint, judged by its status. Given a rowId it
 * fetches that row; any other read lists a single row.
 */
async function requestEndpoint(input: EndpointTestInput, rowId?: string): Promise<EndpointTestResult> {
  const { projectId, tableName, operation } = input

  const appUrl = resolveAppUrl()
  if (!appUrl) {
    return {
      ok: false,
      summary: 'Skipped runtime verification: no NEXT_PUBLIC_APP_URL configured to call.',
      endpoint: '',
      method: '',
      statusCode: null,
      bodyExcerpt: '',
      failureKind: 'no_app_url',
    }
  }

  const path =
    `/api/v1/${projectId}/db/${encodeURIComponent(tableName)}` +
    (rowId === undefined ? '' : `/${encodeURIComponent(rowId)}`)

  // Build payload for create. If columns can't be introspected, DON'T report
  // failure — that is a false negative that makes the agent thrash
  // (fix_backend → re-read → retry → context bloat → model timeout). Instead
  // degrade to the read-only list check, which is the real reachability proof.
  let body: string | undefined
  let degradedNote = ''
  let effectiveOp: 'list' | 'create' | 'get' = operation
  if (operation === 'create') {
    const cols = await loadTableColumns(projectId, tableName)
    if (!cols || cols.length === 0) {
      effectiveOp = 'list'
      degradedNote = ' (create payload could not be synthesised; verified reachability via list instead)'
    } else {
      body = JSON.stringify(synthesiseSampleRow(cols))
    }
  }
  const method = effectiveOp === 'create' ? 'POST' : 'GET'
  // A GET that names no row is a list, and a list asks for one row: that is
  // all a test needs, and the whole body is read into memory below.
  const listing = method === 'GET' && rowId === undefined
  const url = `${appUrl}${path}${listing ? '?limit=1' : ''}`

  // Headers
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const anonKey = await resolveAnonKey(projectId)
  if (anonKey) headers['x-api-key'] = anonKey
  else if (input.sessionToken) headers['authorization'] = `Bearer ${input.sessionToken}`
  // Whether the request carried ANY credential. Load-bearing below: it decides
  // whether a 401 means "the route enforces auth" or "this test never ran".
  const authenticated = Boolean(anonKey) || Boolean(input.sessionToken)

  // The deadline covers the whole exchange, body included, since a response
  // can stall after its status line. A request it cuts off verified nothing,
  // and that is a different failure from a connection that could not be made.
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const timedOut = (statusCode: number | null): EndpointTestResult => ({
    ok: false,
    summary:
      `${method} ${path} ${statusCode === null ? 'did not answer' : `→ ${statusCode}, but did not finish answering`} ` +
      `within ${timeoutMs / 1000}s, so nothing was verified. A slow or hung runtime says nothing about whether ` +
      'the endpoint works.',
    endpoint: path,
    method,
    statusCode,
    bodyExcerpt: '',
    failureKind: 'timeout',
  })

  let res: Response
  try {
    res = await fetch(url, { method, headers, body, signal: deadline })
  } catch (err) {
    if (deadline.aborted) return timedOut(null)
    return {
      ok: false,
      summary: `Fetch to ${path} failed: ${err instanceof Error ? err.message : 'unknown'}`,
      endpoint: path,
      method,
      statusCode: null,
      bodyExcerpt: '',
      failureKind: 'fetch_failed',
    }
  }

  const status = res.status
  const text = await res.text().catch(() => (deadline.aborted ? null : ''))
  if (text === null) return timedOut(status)
  const excerpt = text.length > 320 ? text.slice(0, 320) + '…' : text

  // 200 / 201 → endpoint works
  if (status === 200 || status === 201) {
    return {
      ok: true,
      summary: `${method} ${path} → ${status} OK. Endpoint is wired and responding.${degradedNote}`,
      endpoint: path,
      method,
      statusCode: status,
      bodyExcerpt: excerpt,
      ...(listing ? { firstRowId: firstRowIdOf(text) } : {}),
    }
  }
  // 401 / 403
  if (status === 401 || status === 403) {
    // No credential was sent, so this status is the expected answer to an
    // anonymous request and says nothing about whether the endpoint works.
    // Reporting it as verified is how a broken backend reads green.
    if (!authenticated) {
      return {
        ok: false,
        summary:
          `${method} ${path} → ${status}, but the test had no credential to send, so nothing was verified. ` +
          `The project has no anon key; generate one and re-run.${degradedNote}`,
        endpoint: path,
        method,
        statusCode: status,
        bodyExcerpt: excerpt,
        failureKind: 'unauthenticated',
      }
    }
    // Credentialed and still refused: the route is wired and enforcing access
    // control beyond the anon key, which is a correct outcome for a table whose
    // RLS requires an end-user identity.
    return {
      ok: true,
      summary: `${method} ${path} → ${status}. Endpoint is wired and enforcing access control beyond the anon key.${degradedNote}`,
      endpoint: path,
      method,
      statusCode: status,
      bodyExcerpt: excerpt,
    }
  }
  // 404 → not routed. Not for a row the list just returned, though: the list
  // answering proves the table is routed, and blaming generate_api would send
  // the agent to regenerate an API that works.
  if (status === 404) {
    return {
      ok: false,
      summary:
        rowId === undefined
          ? `${method} ${path} → 404. The endpoint is not routed — generate_api may not have run, or the table name is wrong.`
          : `${method} ${path} → 404 for a row the list had just returned: the table is routed, but fetching a row by its id does not work. Body: ${excerpt.slice(0, 120)}`,
      endpoint: path,
      method,
      statusCode: status,
      bodyExcerpt: excerpt,
      failureKind: 'not_found',
    }
  }
  // 400 → schema mismatch on create
  if (status === 400) {
    return {
      ok: false,
      summary: `${method} ${path} → 400. The endpoint rejected the sample payload — schema likely doesn\'t match what generate_api expects. Body: ${excerpt.slice(0, 120)}`,
      endpoint: path,
      method,
      statusCode: status,
      bodyExcerpt: excerpt,
      failureKind: 'bad_request',
    }
  }
  // 5xx → broken… UNLESS the body says it's an RLS policy denial.
  // Postgres returns code 42501 ("INSUFFICIENT_PRIVILEGE") for both RLS
  // denials and missing GRANTs.
  // - A missing grant (permission denied for table/schema/...) is a broken
  //   backend and must fail as server_error naming the missing grant.
  // - A true RLS policy denial proves the table is wired AND secured, so it
  //   passes.
  // - A bare 42501 with no RLS wording is treated as a server error.
  if (status >= 500) {
    const bodyToCheck = text || excerpt
    const missingGrant = extractMissingGrant(bodyToCheck)
    if (missingGrant) {
      return {
        ok: false,
        summary: `${method} ${path} → ${status}. A database grant is missing (${missingGrant}). The endpoint threw a server error because the database role lacks required permissions.${degradedNote}`,
        endpoint: path,
        method,
        statusCode: status,
        bodyExcerpt: excerpt,
        failureKind: 'server_error',
      }
    }

    const rlsBlocked = looksLikeRlsDenied(bodyToCheck)
    if (rlsBlocked) {
      return {
        ok: true,
        summary: `${method} ${path} → ${status} (RLS-denied). Endpoint exists and Row-Level Security blocked the test row — that's correct behaviour.${degradedNote}`,
        endpoint: path,
        method,
        statusCode: status,
        bodyExcerpt: excerpt,
      }
    }
    return {
      ok: false,
      summary: `${method} ${path} → ${status}. The endpoint exists but threw a server error. Body: ${excerpt.slice(0, 120)}`,
      endpoint: path,
      method,
      statusCode: status,
      bodyExcerpt: excerpt,
      failureKind: 'server_error',
    }
  }

  // Other statuses (e.g. 405) — treat as informational fail
  return {
    ok: false,
    summary: `${method} ${path} → ${status}. Unexpected status.`,
    endpoint: path,
    method,
    statusCode: status,
    bodyExcerpt: excerpt,
    failureKind: 'no_endpoint',
  }
}

/**
 * Detect a Postgres missing-grant error inside a 500 body.
 *
 * Postgres raises SQLSTATE 42501 (insufficient_privilege) for both RLS denials
 * AND missing GRANTs. But a missing grant means the runtime role cannot use the
 * table/schema at all — that is a broken backend, not a secured one.
 *
 * Matches errors like:
 *   permission denied for schema workspace_p1
 *   permission denied for table posts
 *   permission denied for sequence posts_id_seq
 *   permission denied for function my_func
 */
export function extractMissingGrant(body: string): string | null {
  if (!body) return null
  const match =
    body.match(/permission denied for (?:table|schema|sequence|function|relation|view|database|foreign table)\s+([^\s"',;\\}]+|"(?:\\.|[^"\\])*"|\\"(?:\\.|[^"\\])*\\")/i) ||
    body.match(/permission denied for (?:table|schema|sequence|function|relation|view|database|foreign table)/i)
  if (!match) return null
  return match[0].replace(/\\"/g, '"').trim()
}

/**
 * Recognise an RLS policy denial inside a 500 body. The runtime sometimes
 * lifts the underlying Postgres error through prisma.$queryRawUnsafe, producing
 * bodies like:
 *
 *   {"error":"... Raw query failed. Code: `42501`. Message: `ERROR: new row
 *    violates row-level security policy ...`"}
 *
 * Pass ONLY on RLS-specific phrasing (e.g. `violates row-level security policy`
 * or `new row violates row-level security policy`).
 *
 * Missing grants (e.g. `permission denied for schema/table`) and bare 42501
 * codes without RLS wording do NOT qualify as an RLS pass.
 */
export function looksLikeRlsDenied(body: string): boolean {
  if (!body) return false
  if (extractMissingGrant(body)) return false

  return (
    /row[-\s]?level security/i.test(body) ||
    /violates row[-\s]?level security policy/i.test(body)
  )
}

/**
 * The id of the first row in a list body (`{ data: [row, …] }`), as the path
 * segment the get-by-id route takes, or undefined when there is none to use.
 * An empty id is none: it would turn the get path back into the bare table
 * path, which is a list with no limit.
 */
function firstRowIdOf(body: string): string | undefined {
  try {
    const id = JSON.parse(body)?.data?.[0]?.id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}
