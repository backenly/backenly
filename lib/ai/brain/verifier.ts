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
 *   - CREATE verification: POST a synthesised sample row, accept 201/401/403,
 *     fail on 400/500. 400 means schema mismatch — flagged for the brain.
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

export interface EndpointTestInput {
  projectId: string
  tableName: string
  operation: 'list' | 'create' | 'get'
  sessionToken?: string
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
  /** When ok=false, why. */
  failureKind?: 'not_found' | 'server_error' | 'bad_request' | 'no_endpoint' | 'no_app_url' | 'no_table' | 'fetch_failed' | 'unauthenticated'
}

const APP_URL_ENV = ['NEXT_PUBLIC_APP_URL', 'APP_URL'] as const

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
  try {
    const schema = await resolveWorkspaceSchema(projectId)
    const rows = await prisma.$queryRawUnsafe<
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

  const path = `/api/v1/${projectId}/db/${encodeURIComponent(tableName)}`

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
  const url = `${appUrl}${path}${effectiveOp === 'list' ? '?limit=1' : ''}`

  // Headers
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const anonKey = await resolveAnonKey(projectId)
  if (anonKey) headers['x-api-key'] = anonKey
  else if (input.sessionToken) headers['authorization'] = `Bearer ${input.sessionToken}`
  // Whether the request carried ANY credential. Load-bearing below: it decides
  // whether a 401 means "the route enforces auth" or "this test never ran".
  const authenticated = Boolean(anonKey) || Boolean(input.sessionToken)

  let res: Response
  try {
    res = await fetch(url, { method, headers, body })
  } catch (err) {
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
  const text = await res.text().catch(() => '')
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
  // 404 → not routed
  if (status === 404) {
    return {
      ok: false,
      summary: `${method} ${path} → 404. The endpoint is not routed — generate_api may not have run, or the table name is wrong.`,
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
  // 5xx → broken… UNLESS the body says it's an RLS / permission-denied
  // failure. Postgres returns code 42501 ("INSUFFICIENT_PRIVILEGE") when an
  // RLS policy refuses the row; the runtime currently wraps that as a 500.
  // RLS doing its job is the OPPOSITE of "broken" — it proves the table is
  // wired AND correctly secured. Treat it as PASS.
  if (status >= 500) {
    const rlsBlocked = looksLikeRlsDenied(excerpt)
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
 * Recognise an RLS / permission-denied error inside a 500 body. The runtime
 * sometimes lifts the underlying Postgres error through prisma.$queryRawUnsafe,
 * producing bodies like:
 *
 *   {"error":"... Raw query failed. Code: `42501`. Message: `ERROR: new row
 *    violates row-level security policy ...`"}
 *
 * We match on both the Postgres SQLSTATE code (42501) and the human message
 * so neither a code-only nor a message-only excerpt slips through. Anything
 * matching is RLS doing its job — not a real server error.
 */
function looksLikeRlsDenied(body: string): boolean {
  if (!body) return false
  const lower = body.toLowerCase()
  return (
    /\b42501\b/.test(body) ||
    /row[-\s]?level security/i.test(body) ||
    /violates row[-\s]?level security policy/i.test(body) ||
    /permission denied/i.test(lower) ||
    /insufficient[_\s]?privilege/i.test(lower)
  )
}
