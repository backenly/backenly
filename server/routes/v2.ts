/**
 * /api/v2 — PostgREST's native grammar, exposed directly.
 *
 * ── Why a second surface instead of changing v1 ─────────────────────────────
 *
 * v1 is a CONTRACT. Clients depend on `?status=paid`, on `{data, pagination}`,
 * on the shapes lib/postgrest/translate.ts produces. Changing it would break
 * every existing caller, and the SDK, to gain a grammar. So v1 stays exactly as
 * it is and v2 is added beside it: two surfaces, one engine, one auth path, one
 * authorization gate.
 *
 * ── Why it is worth having ──────────────────────────────────────────────────
 *
 * Two reasons, and the second is the one that actually matters.
 *
 * 1. Familiarity. `?price=gte.100`, `?or=(a.eq.1,b.eq.2)`, `?order=created.desc`
 *    is what a developer fluent in PostgREST already knows, and what a model
 *    has seen in its training data. Backenly's translated dialect has to be
 *    learned — from docs, in-context, every session.
 *
 * 2. EMBEDDED RESOURCES. `?select=*,author(*)` returns a post and its author in
 *    one round trip. v1 cannot express this at all — not "expresses it awkwardly",
 *    cannot. It is the single most-used PostgREST feature and the clearest
 *    capability gap v1 leaves open.
 *
 * ── The security question embedding raises ──────────────────────────────────
 *
 * Embedding lets a caller traverse to ANOTHER table: `?select=*,users(*)` asks
 * for the auth table. The exposure gate below only checks the table in the PATH,
 * so it cannot see that. Blocking it by parsing `select=` would mean out-arguing
 * PostgREST's grammar — quoted idents, aliases, nested embeds, `!inner` hints —
 * and a parser that is wrong once is a leak.
 *
 * It is not parsed. `backenly_pgrst_revoke_internal` has already REVOKED anon
 * and authenticated on `users` and every `_`-prefixed table, so an embed of them
 * fails in Postgres on a missing privilege regardless of how it is spelled.
 * Same principle as everywhere else here: the boundary is a grant, never a
 * parser. Asserted end-to-end in tests, not assumed.
 */

import { Router, type Request, type Response } from 'express'
import {
  buildUpstreamHeaders,
  internalClaimsFor,
  mintInternalToken,
  profileForProject,
} from '@/lib/postgrest/gateway'
import { checkExposure, type Operation } from '@/lib/postgrest/exposure'
import { stripUpstreamError } from '@/lib/postgrest/translate'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { getProjectIdFromAuth } from './dynamic'
import { enforceRateLimitByKeyId } from '../lib/auth'

const router = Router()

/** HTTP verb → the operation name the exposure gate speaks. */
function operationFor(method: string, hasId: boolean): Operation | null {
  switch (method) {
    case 'GET':    return hasId ? 'get' : 'list'
    case 'POST':   return 'create'
    case 'PATCH':  return 'update'
    case 'PUT':    return 'update'
    case 'DELETE': return 'delete'
    default:       return null
  }
}

router.all('/:projectId/*', async (req: Request, res: Response) => {
  const projectId = req.params.projectId
  const rest = (req.params as Record<string, string>)[0] ?? ''
  const [table, maybeId] = rest.split('/').filter(Boolean)

  if (!table) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'No table in path.' })
  }

  const baseUrl = process.env.POSTGREST_URL
  const secret = process.env.POSTGREST_JWT_SECRET
  if (!baseUrl || !secret) {
    return res.status(503).json({ code: 'V2_UNAVAILABLE', message: 'PostgREST is not configured.' })
  }

  // No per-project engine gate. This check existed while two data planes
  // coexisted: answering v2 for a project still served by the legacy executor
  // would have meant two planes with different RLS contracts answering the same
  // question. Both executors were deleted on 2026-07-21 and /api/v1 now runs on
  // PostgREST unconditionally (server/routes/dynamic.ts), so gating v2 on
  // per-project state described a fork that no longer exists — same engine,
  // same data, same authorization, with one surface arbitrarily hidden.
  //
  // The env check above stays: it is about whether THIS DEPLOYMENT runs
  // PostgREST at all, which is a real question for self-hosters.

  // Accept PostgREST's own `apikey` header, not just Backenly's `x-api-key`.
  //
  // v2 exists so that someone fluent in PostgREST is fluent here with no
  // translation step. Every example in that ecosystem — and every PostgREST
  // client library — sends `apikey`, so rejecting it made the compatibility
  // claim false at the very first request: a correct PostgREST call with a valid
  // key returned 401. Normalised here rather than in getProjectIdFromAuth so
  // v1's contract is untouched.
  if (!req.headers['x-api-key'] && req.headers['apikey']) {
    req.headers['x-api-key'] = req.headers['apikey'] as string
  }

  const auth = await getProjectIdFromAuth(req)
  if (!auth.success || auth.projectId !== projectId) {
    // A service-role key refused because the request came from a browser is an
    // AUTHORIZATION decision about a valid credential, not a failed one. 401
    // would tell the developer their key is wrong and send them to re-issue it,
    // which is the opposite of the fix — the key is fine, the place it is being
    // used from is not.
    const status = auth.code === 'SERVICE_ROLE_IN_BROWSER' ? 403 : 401
    return res.status(status).json({
      code: auth.success ? 'PROJECT_MISMATCH' : (auth.code ?? 'UNAUTHORIZED'),
      message: auth.success ? 'This key does not belong to that project.' : (auth.error ?? 'Unauthorized'),
    })
  }

  // Same quota v1 enforces, on the same key. v2 authenticated through the
  // identical path but never enforced the limit, so one credential was capped
  // at /api/v1/... and uncapped at /api/v2/... — a caller who hit 429 could
  // lift it by changing one character in the URL. Rate limiting has to live on
  // every door the key opens, not on the one that happened to grow it first.
  if (auth.keyId) {
    const rl = await enforceRateLimitByKeyId(auth.keyId)
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt.getTime() / 1000)))
    if (!rl.allowed) {
      if (rl.retryAfter) res.setHeader('Retry-After', String(rl.retryAfter))
      return res.status(429).json({
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Retry in ${rl.retryAfter ?? 60}s.`,
      })
    }
  }

  const operation = operationFor(req.method, Boolean(maybeId))
  if (!operation) {
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not supported.` })
  }

  // Same gate v1 uses. Reserved and auth-managed tables are refused here; the
  // grants underneath refuse them again if this is ever bypassed.
  const exposure = await checkExposure(projectId, table, operation)
  if (!exposure.allowed) {
    return res.status(exposure.status ?? 404).json({ error: exposure.error, code: exposure.code })
  }

  const token = mintInternalToken(
    internalClaimsFor({
      projectId,
      endUserId: auth.endUserId,
      serviceRole: auth.isServiceRole,
    }),
    secret,
  )

  // The query string is forwarded UNTOUCHED — that is the entire point of v2.
  // A single-record path segment becomes PostgREST's own `id=eq.<id>` filter
  // rather than a bespoke route shape.
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : ''
  const idFilter = maybeId ? `id=eq.${encodeURIComponent(maybeId)}` : ''
  const search = [idFilter, qs].filter(Boolean).join('&')
  const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(table)}${search ? `?${search}` : ''}`

  const headers = buildUpstreamHeaders(req.headers as Record<string, string>, {
    projectId,
    internalToken: token,
    method: req.method,
  })

  const sendUpstream = () =>
    fetch(url, {
      method: req.method,
      headers,
      body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
    })

  try {
    let upstream = await sendUpstream()
    let text = await upstream.text()

    // Same PGRST106 self-heal v1 performs. Both surfaces run on one engine, so
    // a repair wired into only one of them means the same project is alive at
    // /api/v1/... and dead at /api/v2/... — precisely the kind of per-door
    // divergence that made the rate limit a bypass here once already.
    if (!upstream.ok && text.includes('PGRST106')) {
      const repair = await ensureSchemaRegistered(projectId)
      if (repair.registered) {
        upstream = await sendUpstream()
        text = await upstream.text()
      }
    }

    // SUCCESS bodies are returned AS-IS: PostgREST's JSON array, its
    // Content-Range. Wrapping them in {data, pagination} would recreate the
    // proprietary contract v2 exists to escape, and would break every client
    // that already knows how to read PostgREST.
    //
    // ERROR bodies are not. PostgREST writes those for an operator who owns the
    // whole instance: PGRST106's message enumerates every exposed schema, which
    // here is every other tenant's project id, and that body was reaching
    // callers verbatim. `stripUpstreamError` keeps the {code, message, details,
    // hint} shape PostgREST clients parse, and keeps the real text for
    // constraint errors about the caller's own data, while refusing to describe
    // the instance.
    if (!upstream.ok) {
      console.error(`[v2] upstream ${upstream.status} for ${table}:`, text.slice(0, 500))
      let parsed: unknown = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      const safe = stripUpstreamError(upstream.status, parsed)
      return res.status(safe.status).json(safe.body)
    }

    for (const h of ['content-range', 'content-location', 'preference-applied']) {
      const v = upstream.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    res.status(upstream.status)
    res.type(upstream.headers.get('content-type') ?? 'application/json')
    return res.send(text)
  } catch (err) {
    return res.status(502).json({
      code: 'UPSTREAM_UNAVAILABLE',
      message: err instanceof Error ? err.message : 'PostgREST did not respond.',
    })
  }
})

export default router
