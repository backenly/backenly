/**
 * RUNTIME CONTRACT VERIFICATION
 * ==============================
 * Synthetic probes that exercise a project's ADVERTISED API surfaces the way a
 * real client would — over HTTP, through the same nginx→Express→(Next proxy)
 * chain production traffic takes. This is the platform noticing its own
 * breakage instead of the developer's users finding it first.
 *
 * Born from a real incident: the storage endpoints were dead in production
 * for weeks (Express catch-all intercepted them) while every internal health
 * signal stayed green — because nothing ever tested the runtime contract from
 * the outside. These probes make that class of failure self-detecting.
 *
 * Probes (all read-only except auth, which uses a synthetic `.internal` user
 * that is created, exercised, and deleted):
 *   auth       signup → signin → logout round-trip
 *   db         list first table with the project's anon key
 *   storage    list files (proves the Next-owned surface is routable)
 *   functions  dispatcher reachability (expects FUNCTION_NOT_FOUND, not a misroute)
 *   healthz    hosted health endpoint (proves the Express→Next proxy hop)
 *
 * Integrated as a workspace-observer detector: failures become
 * `contract_surface_broken` HealthFindings (dashboard "A few things to clear"
 * + Autonomy); recoveries auto-resolve previously open findings.
 */

import { prisma } from '@/lib/db'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'
import { isDataPlaneOutage } from '@/lib/core/fix-actions'
import type { RawFinding } from '@/lib/core/types'

const PROBE_TIMEOUT_MS = 8_000

export interface ProbeResult {
  surface: 'auth' | 'db' | 'storage' | 'functions' | 'healthz'
  ok: boolean
  critical: boolean
  detail: string
  /** Truncated raw response body — Details-expander evidence, never shown in the summary row. */
  response?: string
  status?: number
  durationMs: number
}

function probeOrigin(): string {
  // Probe the local Express runtime directly — same handler chain as
  // production traffic (nginx → Express → Next proxy), minus TLS.
  return (
    process.env.CONTRACT_PROBE_ORIGIN ||
    `http://127.0.0.1:${process.env.RUNTIME_PORT || '3001'}`
  ).replace(/\/+$/, '')
}

async function probeFetch(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; raw: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const raw = await res.text()
    let body: any = null
    try { body = JSON.parse(raw) } catch { /* HTML or empty */ }
    return { status: res.status, body, raw: raw.slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
}

function pass(surface: ProbeResult['surface'], detail: string, startedAt: number, critical = true): ProbeResult {
  return { surface, ok: true, critical, detail, durationMs: Date.now() - startedAt }
}

function fail(
  surface: ProbeResult['surface'],
  detail: string,
  startedAt: number,
  status?: number,
  critical = true,
  response?: string,
): ProbeResult {
  return { surface, ok: false, critical, detail, status, response, durationMs: Date.now() - startedAt }
}

/**
 * Human sentence for a failed probe response. The finding row renders `detail`
 * verbatim, so it must never contain a serialized body — pull the handler's own
 * message out of the JSON instead, and keep the raw body as separate evidence.
 */
function describeBody(res: { body: any; raw: string }): string {
  const b = res.body
  const msg =
    (typeof b?.error?.message === 'string' && b.error.message) ||
    (typeof b?.message === 'string' && b.message) ||
    (typeof b?.error === 'string' && b.error) ||
    ''
  if (msg) return msg.slice(0, 160)
  if (b != null) return '' // JSON without a message field — status code says enough
  // HTML / plain-text body (proxy error page, empty response)
  return res.raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** `returned 404 — No API definition for "posts"` (or just `returned 502`). */
function statusLine(res: { status: number; body: any; raw: string }): string {
  const why = describeBody(res)
  return `returned ${res.status}${why ? ` — ${why}` : ''}`
}

// ── Individual probes ──────────────────────────────────────────────────────────

async function probeAuth(projectId: string, base: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  const email = `__cv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@backenly.internal`
  const password = `Cv!${Math.random().toString(36).slice(2)}Aa1`

  try {
    const signup = await probeFetch(`${base}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Contract Probe' }),
    })
    if (signup.status !== 201) {
      // 503 = auth not configured for this project — a setup state, not an
      // outage. Only report when a configured surface misbehaves.
      if (signup.status === 503) return pass('auth', 'auth not configured (skipped)', startedAt)
      return fail('auth', `signup ${statusLine(signup)}`, startedAt, signup.status, true, signup.raw)
    }

    const signin = await probeFetch(`${base}/api/v1/${projectId}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    // 403 EMAIL_NOT_VERIFIED means the surface works and is enforcing the
    // project's verification policy — that's a pass.
    const emailGate = signin.status === 403 && signin.body?.error?.details?.reason === 'EMAIL_NOT_VERIFIED'
    if (signin.status !== 200 && !emailGate) {
      return fail('auth', `signin ${statusLine(signin)}`, startedAt, signin.status, true, signin.raw)
    }

    const token = signin.body?.data?.token
    if (token) {
      await probeFetch(`${base}/api/v1/${projectId}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token }),
      }).catch(() => {})
    }

    return pass('auth', 'signup → signin → logout round-trip OK', startedAt)
  } catch (err: any) {
    return fail('auth', `probe error: ${err?.message ?? String(err)}`, startedAt)
  } finally {
    // Delete the synthetic user AND every side-effect row the signup/logout
    // round-trip created for it (email-verification token, blacklisted jti).
    // Targeted by email + service-role (users is RLS-FORCED) inside the helper.
    await purgeSyntheticAuthArtifacts(projectId, { email }).catch(() => {})
  }
}

async function probeDb(projectId: string, base: string, apiKey: string, tableName: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/db/${encodeURIComponent(tableName)}?limit=1`,
      { headers: { 'x-api-key': apiKey } },
    )
    if (res.status === 200 && (Array.isArray(res.body?.data) || res.body?.data !== undefined)) {
      return pass('db', `list ${tableName} OK`, startedAt)
    }
    return fail('db', `GET /db/${tableName} ${statusLine(res)}`, startedAt, res.status, true, res.raw)
  } catch (err: any) {
    return fail('db', `probe error: ${err?.message ?? String(err)}`, startedAt)
  }
}

async function probeStorage(projectId: string, base: string, apiKey: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/storage/files?limit=1`,
      { headers: { 'x-api-key': apiKey } },
    )
    // Any storage-shaped response (200, or a structured 4xx from the storage
    // handler) proves the surface is routable. The failure mode we're catching
    // is a misroute (catch-all "API not found" / NO_AUTH shape) or 502.
    if (res.status === 200) return pass('storage', 'file list OK', startedAt)
    const code = res.body?.error?.code ?? res.body?.code
    if (res.status < 500 && code && code !== 'API_NOT_FOUND' && code !== 'NO_AUTH_PROVIDED') {
      return pass('storage', `storage handler answered (${res.status} ${code})`, startedAt)
    }
    return fail('storage', `GET /storage/files ${statusLine(res)}`, startedAt, res.status, true, res.raw)
  } catch (err: any) {
    return fail('storage', `probe error: ${err?.message ?? String(err)}`, startedAt)
  }
}

async function probeFunctions(projectId: string, base: string, apiKey: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/fn/__contract_probe__`,
      { headers: { 'x-api-key': apiKey } },
    )
    // The dispatcher answering FUNCTION_NOT_FOUND proves /fn/* routing works.
    if (res.body?.code === 'FUNCTION_NOT_FOUND') {
      return pass('functions', 'fn dispatcher reachable', startedAt, false)
    }
    return fail(
      'functions',
      `GET /fn/… expected FUNCTION_NOT_FOUND but ${statusLine(res)}`,
      startedAt, res.status, false, res.raw,
    )
  } catch (err: any) {
    return fail('functions', `probe error: ${err?.message ?? String(err)}`, startedAt, undefined, false)
  }
}

async function probeHealthz(projectId: string, base: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(`${base}/api/v1/${projectId}/healthz`)
    // The healthz handler answers with a status body even for edge cases —
    // any JSON `status` proves the Express→Next proxy hop works.
    if (res.body?.status) return pass('healthz', `healthz answered (${res.body.status})`, startedAt, false)
    return fail('healthz', `GET /healthz ${statusLine(res)}`, startedAt, res.status, false, res.raw)
  } catch (err: any) {
    return fail('healthz', `probe error: ${err?.message ?? String(err)}`, startedAt, undefined, false)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Run every applicable probe for a project. Never throws. */
export async function runContractVerification(projectId: string): Promise<ProbeResult[]> {
  const base = probeOrigin()

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { anonKey: true, jwtSecret: true },
  })
  if (!project) return []

  // Probe a real CRUD-exposable table — NOT the auth `users` table (managed via
  // /auth/*, intentionally 404 on /db/users) nor reserved plumbing. Probing
  // users produced a permanent false "contract_surface_broken" critical.
  const { isCrudExposable } = await import('@/lib/mcp/schema-introspection')
  const candidateTables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
    take: 25,
  })
  const firstTable = candidateTables.find(t => isCrudExposable(t.name)) ?? null

  const probes: Promise<ProbeResult>[] = [probeHealthz(projectId, base)]

  // Auth probe needs a configured jwtSecret (otherwise signup 503s by design).
  if (project.jwtSecret && project.jwtSecret.length >= 32) {
    probes.push(probeAuth(projectId, base))
  }

  // Key-authed probes need the anon key.
  if (project.anonKey) {
    probes.push(probeStorage(projectId, base, project.anonKey))
    probes.push(probeFunctions(projectId, base, project.anonKey))
    if (firstTable) probes.push(probeDb(projectId, base, project.anonKey, firstTable.name))
  }

  const settled = await Promise.allSettled(probes)
  return settled
    .filter((s): s is PromiseFulfilledResult<ProbeResult> => s.status === 'fulfilled')
    .map(s => s.value)
}

/**
 * Workspace-observer detector: probe the runtime contract, resolve recovered
 * findings, and return RawFindings for surfaces that are broken right now.
 */
export async function detectContractViolations(projectId: string): Promise<RawFinding[]> {
  // Never return "no findings" when the probe run itself could not complete.
  // An empty result is indistinguishable from a healthy backend — that is
  // exactly how detectMissingRls stayed silently dead for months. The observer
  // calls every detector inside Promise.allSettled, so throwing here is
  // isolated to this detector and surfaces as a scan error instead of being
  // laundered into "all surfaces OK".
  const results: ProbeResult[] = await runContractVerification(projectId)

  // A genuinely empty run (project gone, no anonKey, no jwtSecret) is a
  // configuration state, not a health signal — distinct from the throw above.
  if (results.length === 0) return []

  const broken = results.filter(r => !r.ok)
  const recovered = results.filter(r => r.ok)

  // Auto-resolve open findings for surfaces that answer correctly again.
  for (const r of recovered) {
    await prisma.healthFinding.updateMany({
      where: {
        projectId,
        type: 'contract_surface_broken',
        status: { in: ['open', 'pending_approval'] },
        details: { path: ['surface'], equals: r.surface },
      },
      data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
    }).catch(() => {})
  }

  return broken.map((r): RawFinding => {
    const details = {
      surface: r.surface,
      detail: r.detail,
      response: r.response?.slice(0, 300) ?? null,
      httpStatus: r.status ?? null,
      durationMs: r.durationMs,
      probedAt: new Date().toISOString(),
      hint:
        r.surface === 'storage' || r.surface === 'healthz'
          ? 'This surface is served by the Next.js app behind the Express proxy — check that both PM2 processes are running and the proxy route is mounted.'
          : 'This surface is served by the Express runtime — check backenly-runtime logs.',
    }

    // A broken surface is usually a symptom whose cause is outside this
    // project's schema — a process down, a route unmounted, a proxy
    // misconfigured — and inventing a schema repair for it would be a guess.
    //
    // The DATA-PLANE shape is the exception, and it is not a small one: a 502
    // from /db/* means the gateway could not reach PostgREST, which is a
    // separate supervised process with a real, verifiable repair. Leaving that
    // un-healed is what put a critical "GET /db/profiles returned 502" in a
    // human approval queue while every one of that project's data endpoints
    // was down. See lib/postgrest/supervisor.ts for why the restart is safe to
    // automate; the decision to act is re-verified there against an
    // independent platform probe, never taken on this finding alone.
    const healable = isDataPlaneOutage(details)

    return {
      type: 'contract_surface_broken',
      severity: r.critical ? 'critical' : 'warning',
      autoFixable: healable,
      details,
      fix: healable
        ? async () => {
            const { healDataPlane, describeHeal } = await import('@/lib/postgrest/supervisor')
            const result = await healDataPlane(projectId)
            // Only `healthy` counts. Throwing on anything else is deliberate:
            // the observer records a non-throwing fix as auto_fixed, and a
            // data plane recorded as repaired while it is still serving 502s
            // is worse than an open finding, because the queue stops showing
            // it. Recoveries auto-resolve at the top of this function anyway.
            if (!result.healthy) throw new Error(describeHeal(result))
          }
        : undefined,
    }
  })
}
