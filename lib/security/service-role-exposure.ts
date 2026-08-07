/**
 * SERVICE-ROLE EXPOSURE — refuse the key that bypasses every policy when the
 * request came from a browser
 * ==========================================================================
 *
 * A service-role key bypasses RLS entirely: `internalClaimsFor` mints
 * `role: 'service_role'`, and every `serviceRoleClause` in workspace-rls.ts
 * short-circuits to true. That is correct for a trusted server. In a browser it
 * is a total breach — every row of every table, readable by anyone who opens
 * devtools, with no policy in the way and nothing in any log that looks wrong.
 *
 * It is also the single most common way a competent developer loses a database,
 * and the reason is structural rather than careless: the key works. It works in
 * the terminal, it works in the server component, and it keeps working when the
 * same module gets imported into a client component six weeks later. Nothing
 * fails, so nothing is noticed.
 *
 * ── Why this refuses rather than warns ──────────────────────────────────────
 *
 * Detection alone would report an exposure that has already happened, to an
 * owner who cannot un-ship the bundle. Refusing converts a silent breach into a
 * loud 403 on the developer's own machine, the first time they run it, while the
 * only thing at stake is their patience. Every other guarantee in this platform
 * is enforced at the point the mistake is made; this is the same rule applied to
 * the one credential that can undo all of them.
 *
 * ── The signal ──────────────────────────────────────────────────────────────
 *
 * `Sec-Fetch-Site` (and its Sec-Fetch-* siblings) are FORBIDDEN HEADER NAMES:
 * browsers set them on every fetch/XHR and page-script JavaScript cannot add,
 * remove, or forge them. Node/undici, axios, curl, Deno and Bun send none of
 * them. That asymmetry is what makes this decidable rather than a heuristic —
 * their presence is a browser's own attestation about its request.
 *
 * `Origin` alone is deliberately NOT sufficient. A server-to-server caller may
 * legitimately set it, and treating it as proof would 403 correct backend code.
 * It only counts here alongside a browser User-Agent, which is the shape a
 * pre-Sec-Fetch browser produces.
 *
 * This is a false-NEGATIVE-tolerant design and that is the right bias: a missed
 * browser call is the status quo, while a false positive breaks a working
 * backend for a developer who did nothing wrong.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'

/** Audit action recording one refused service-role request. The probe's evidence. */
export const SERVICE_ROLE_BROWSER_BLOCKED = 'SERVICE_ROLE_BROWSER_BLOCKED'

/** How far back the invariant probe looks for refused requests. */
export const EXPOSURE_WINDOW_HOURS = 24

export interface BrowserOriginVerdict {
  /** True when the request carries a browser's own attestation that it is one. */
  isBrowser: boolean
  /** Which signal decided it — recorded so a false positive is diagnosable. */
  signal: 'sec_fetch' | 'origin_with_browser_ua' | null
  /** The site the request came from, when it announced one. */
  origin: string | null
}

type HeaderBag = Record<string, string | string[] | undefined>

/**
 * Case-insensitive on the BAG's keys, not just the requested name.
 *
 * Node lower-cases incoming header names, so a direct lookup is correct for the
 * Express path this ships on. It is not correct everywhere else this function is
 * reachable — plain objects from tests, and header maps built by hand elsewhere
 * in the codebase preserve whatever case they were given. Matching only the
 * lower-cased NAME against an unnormalised bag reads `Sec-Fetch-Site` as absent,
 * and absent here means "not a browser", which means the request is served. A
 * security decision must not depend on which layer happened to normalise first.
 */
function header(headers: HeaderBag, name: string): string | null {
  const want = name.toLowerCase()
  let v = headers[want]
  if (v === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === want) {
        v = headers[key]
        break
      }
    }
  }
  if (Array.isArray(v)) return v[0] ?? null
  return typeof v === 'string' ? v : null
}

/**
 * Did this request come from a browser? Pure, so the rule is provable without a
 * server — the same discipline fix-acceptance.ts and sensor-health.ts hold to.
 */
export function detectBrowserOrigin(headers: HeaderBag): BrowserOriginVerdict {
  const origin = header(headers, 'origin') ?? refererOrigin(headers)

  // Primary: a header page JavaScript is forbidden from setting. Any Sec-Fetch-*
  // member is enough — Dest and Mode are present on requests where Site is not.
  const secFetch =
    header(headers, 'sec-fetch-site') ??
    header(headers, 'sec-fetch-mode') ??
    header(headers, 'sec-fetch-dest')
  if (secFetch) return { isBrowser: true, signal: 'sec_fetch', origin }

  // Secondary: pre-Sec-Fetch browsers still announce an Origin, but so can a
  // server. Require the User-Agent to look like a browser as well, so a Node
  // client that sets Origin for its own reasons is not refused.
  const ua = header(headers, 'user-agent') ?? ''
  const looksLikeBrowser = /Mozilla\/|AppleWebKit\/|Chrome\/|Safari\/|Firefox\/|Edg\//.test(ua)
  if (origin && looksLikeBrowser) {
    return { isBrowser: true, signal: 'origin_with_browser_ua', origin }
  }

  return { isBrowser: false, signal: null, origin }
}

/**
 * The message the developer sees. It is long on purpose: this fires while they
 * are looking at their own console, which is the one moment the explanation is
 * cheap to read and the fix is cheap to make.
 */
export function serviceRoleRefusalMessage(keyName: string | null): string {
  const which = keyName ? `The key "${keyName}"` : 'This key'
  return (
    `${which} is a service-role key and this request came from a browser. ` +
    `Service-role keys bypass row-level security completely — every row of every ` +
    `table in this project would be readable by anyone who opens developer tools. ` +
    `Backenly refuses these requests rather than serving them.\n\n` +
    `Use a client key in browser code (Project → API keys → client key): it is ` +
    `subject to your RLS policies, so end-users see only their own rows. Keep the ` +
    `service-role key on a server — an API route, a server component, or a ` +
    `Backenly function — and never in code that ships to the browser.`
  )
}

/** Origin derived from Referer, for browsers that send one and not the other. */
function refererOrigin(headers: HeaderBag): string | null {
  const ref = header(headers, 'referer') ?? header(headers, 'referrer')
  if (!ref) return null
  try {
    return new URL(ref).origin
  } catch {
    return null
  }
}

/**
 * Record one refused request. Fire-and-forget: the refusal has already been sent
 * and must never depend on the ledger write succeeding.
 *
 * Written to AuditLog rather than a new table for the same reason
 * `detectPendingSchemaDrift` reads SchemaDriftEvent: the probe below needs
 * RUNTIME evidence that this actually happened, and a finding raised from
 * anything less would be speculation about a key that may sit safely on a
 * server forever.
 */
export async function recordServiceRoleBrowserBlock(input: {
  projectId: string
  apiKeyId: string
  keyName: string | null
  keyPrefix: string | null
  verdict: BrowserOriginVerdict
  method: string
  path: string
}): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        projectId: input.projectId,
        action: SERVICE_ROLE_BROWSER_BLOCKED,
        type: 'security',
        details: JSON.stringify({
          apiKeyId: input.apiKeyId,
          keyName: input.keyName,
          keyPrefix: input.keyPrefix,
          origin: input.verdict.origin,
          signal: input.verdict.signal,
          method: input.method,
          // Path only — never the query string, which routinely carries filter
          // values that are themselves user data.
          path: input.path.split('?')[0],
        }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}

interface BlockEvidence {
  apiKeyId?: unknown
  keyName?: unknown
  keyPrefix?: unknown
  origin?: unknown
  signal?: unknown
  path?: unknown
}

/**
 * INVARIANT PROBE — is a service-role key being called from a browser?
 *
 * Evidence-gated and self-resolving, per the finding policy: it reads refusals
 * the runtime actually recorded, so it cannot fire on a project whose keys are
 * all correctly server-side, and it stops firing on its own once the browser
 * calls stop — no reaper entry needed, because the window rolls off.
 *
 * One finding per KEY, not per request. A leaked key in a deployed bundle
 * generates a refusal on every page load; grouping by request would bury the
 * dashboard under thousands of rows describing one mistake.
 */
export async function detectServiceRoleKeyExposure(projectId: string): Promise<RawFinding[]> {
  const since = new Date(Date.now() - EXPOSURE_WINDOW_HOURS * 60 * 60 * 1000)

  type BlockRow = { details: string | null; timestamp: Date }
  const rows: BlockRow[] = await prisma.auditLog
    .findMany({
      where: { projectId, action: SERVICE_ROLE_BROWSER_BLOCKED, timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
      take: 500,
      select: { details: true, timestamp: true },
    })
    .catch(() => [] as BlockRow[])
  if (rows.length === 0) return []

  interface Group {
    apiKeyId: string
    keyName: string | null
    keyPrefix: string | null
    origins: Set<string>
    paths: Set<string>
    blocked: number
    lastAt: Date
    firstAt: Date
  }
  const byKey = new Map<string, Group>()

  for (const row of rows) {
    let d: BlockEvidence
    try {
      d = JSON.parse(row.details ?? '{}') as BlockEvidence
    } catch {
      continue
    }
    const apiKeyId = typeof d.apiKeyId === 'string' ? d.apiKeyId : null
    if (!apiKeyId) continue

    let g = byKey.get(apiKeyId)
    if (!g) {
      g = {
        apiKeyId,
        keyName: typeof d.keyName === 'string' ? d.keyName : null,
        keyPrefix: typeof d.keyPrefix === 'string' ? d.keyPrefix : null,
        origins: new Set(),
        paths: new Set(),
        blocked: 0,
        lastAt: row.timestamp,
        firstAt: row.timestamp,
      }
      byKey.set(apiKeyId, g)
    }
    g.blocked++
    if (typeof d.origin === 'string' && d.origin) g.origins.add(d.origin)
    if (typeof d.path === 'string' && d.path) g.paths.add(d.path)
    if (row.timestamp < g.firstAt) g.firstAt = row.timestamp
    if (row.timestamp > g.lastAt) g.lastAt = row.timestamp
  }

  // A key the owner already revoked or downgraded is not a live problem. Reading
  // the CURRENT key state rather than trusting the ledger is what lets the
  // finding close the moment the owner acts, instead of waiting out the window.
  // The fallback is typed rather than a bare `[]`: this project compiles with
  // `strict: false`, under which an untyped empty-array catch widens the whole
  // await to `unknown[]` and every field read below becomes an error.
  type LiveKey = { id: string; name: string; keyPrefix: string }
  const live: LiveKey[] = await prisma.apiKey
    .findMany({
      where: { id: { in: [...byKey.keys()] }, serviceRole: true },
      select: { id: true, name: true, keyPrefix: true },
    })
    .catch(() => [] as LiveKey[])
  const liveById = new Map<string, LiveKey>(live.map(k => [k.id, k]))

  const out: RawFinding[] = []
  for (const g of byKey.values()) {
    const current = liveById.get(g.apiKeyId)
    if (!current) continue // revoked, or no longer service-role — resolved by the owner

    const origins = [...g.origins]
    const originText =
      origins.length === 0
        ? 'a browser'
        : origins.length === 1
          ? origins[0]
          : `${origins.length} sites (${origins.slice(0, 3).join(', ')}…)`

    out.push({
      type: 'service_role_key_exposed',
      severity: 'critical',
      // No safe automatic repair exists — see the classifier note. Revoking a key
      // the app is actively using trades a blocked breach for a certain outage,
      // and the real fix (move it out of the bundle) is in code Backenly does not
      // own. Reported, never guessed at.
      autoFixable: false,
      details: {
        reason:
          `The service-role key "${current.name}" was called from ${originText} ` +
          `${g.blocked} time${g.blocked === 1 ? '' : 's'} in the last ${EXPOSURE_WINDOW_HOURS} hours. ` +
          `Backenly refused every one of those requests — no data was served. ` +
          `Service-role keys bypass row-level security, so if this key is in code that ` +
          `ships to the browser it is readable by anyone using your app. ` +
          `Move it to a server route and use a client key in the browser, then revoke and ` +
          `reissue this one.`,
        // Keyed by the API key, so gapIdentity() groups every refusal for one key
        // into one finding rather than one per request path.
        location: `api-key:${g.apiKeyId}`,
        apiKeyId: g.apiKeyId,
        keyName: current.name,
        keyPrefix: current.keyPrefix,
        blockedRequests: g.blocked,
        origins: origins.slice(0, 10),
        paths: [...g.paths].slice(0, 10),
        firstAt: g.firstAt.toISOString(),
        lastAt: g.lastAt.toISOString(),
        windowHours: EXPOSURE_WINDOW_HOURS,
      },
    })
  }

  return out
}
