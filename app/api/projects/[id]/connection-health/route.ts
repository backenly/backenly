export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/connection-health
 * ─────────────────────────────────────────
 * Powers the frontend Activity card on Connect → Direct and the
 * FrontendConnectionPill (sidebar + Deploy page).
 *
 * Aggregates the last 24h of `auth_failure` and `bootstrap` SecurityEvents
 * for this project and returns:
 *
 *   {
 *     failures:    [{ origin, kind, sentKeyShape, count, lastSeen, hint, fixHint }],
 *     successes:   [{ origin, count, lastSeen }],
 *     probes:      { count, lastSeen },   // origin-less rejections — bots/curl, never a red signal
 *     totals:      { failures24h, bootstraps24h, distinctOriginsFailing },
 *     summaryText: "12 requests from my-app.vercel.app failed in the last hour — wrong API key"
 *   }
 *
 * The frontend uses this to render an at-a-glance status (green/red),
 * a per-origin failure list, and a "Copy fix prompt" button pasteable
 * into the coding agent working on the frontend.
 *
 * Auth: platform JWT via withProjectValidation (only the project owner
 * can see their connection diagnostics — it leaks frontend origins).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { isInternalOrigin } from '@/lib/security/internal-origin'

type FailureKind = 'missing' | 'placeholder' | 'malformed' | 'unknown_key' | 'expired' | 'unknown'

interface FailureGroup {
  origin: string
  kind: FailureKind
  sentKeyShape: string | null
  count: number
  lastSeen: string
  hint: string
  fixPrompt: string
}

interface SuccessGroup {
  origin: string
  count: number
  lastSeen: string
}

const HINTS_BY_KIND: Record<FailureKind, string> = {
  missing:
    'Your frontend is calling Backenly without an Authorization header at all. It is likely running an older SDK build that was initialized without an apiKey (the current SDK auto-fetches the key), or a custom fetch wrapper is stripping headers.',
  placeholder:
    'Your frontend bundle is sending the literal string "undefined" (or another placeholder) as the API key. This happens when an env var like VITE_BACKENLY_API_KEY is referenced in code but not set at build time — the bundler inlines "undefined".',
  malformed:
    "The key being sent doesn't look like a Backenly anon key. It's likely a key from another service (Stripe, Firebase) or a copy-paste error.",
  unknown_key:
    "The key being sent has the right format but doesn't match any active key for this project. Most likely cause: it belongs to a different project, or it was rotated/deleted after the frontend was built.",
  expired:
    'The key being sent has expired. Generate a new one and update your frontend.',
  unknown:
    'Authentication failed for an unknown reason. Check the request from this origin in your network tab.',
}

const FIX_PROMPTS_BY_KIND: Record<FailureKind, (projectId: string, anonKey: string | null) => string> = {
  missing: (projectId, anonKey) =>
    `The Backenly SDK is not sending an Authorization header. Initialize the client with:\n` +
    `  const backend = createClient({ projectId: "${projectId}"${anonKey ? `, apiKey: "${anonKey}"` : ''} })\n` +
    `or upgrade to the latest SDK from https://backenly.com/backenly-sdk.esm.js which auto-fetches the key.`,
  placeholder: (projectId, anonKey) =>
    `The frontend bundle is shipping "undefined" as the API key — an env var is unset at build time. Find every reference to import.meta.env.VITE_BACKENLY_API_KEY (or NEXT_PUBLIC_BACKENLY_API_KEY, or any process.env.* used as the apiKey) and replace it with the literal string:\n` +
    `  apiKey: "${anonKey ?? 'proj_live_...'}"\n` +
    `The Backenly anon key is public by design — it's safe to embed as a string literal.`,
  malformed: (projectId, anonKey) =>
    `The frontend is sending a key that isn't a Backenly anon key. Find your createClient call and replace the apiKey value with:\n` +
    `  apiKey: "${anonKey ?? 'proj_live_...'}"\n` +
    `Backenly anon keys always start with "proj_live_" and are 56 chars long.`,
  unknown_key: (projectId, anonKey) =>
    `The frontend is sending a key that doesn't match this project (${projectId}). It probably belongs to a different project, or was rotated. Update createClient with the current key:\n` +
    `  apiKey: "${anonKey ?? 'proj_live_...'}"`,
  expired: (projectId, anonKey) =>
    `The key the frontend is sending has expired. Generate a new one from Settings → API Keys and update createClient with:\n` +
    `  apiKey: "${anonKey ?? 'proj_live_...'}"`,
  unknown: (projectId, anonKey) =>
    `Update your createClient with the current anon key:\n` +
    `  apiKey: "${anonKey ?? 'proj_live_...'}"`,
}

function shortenOrigin(raw: string | null): string {
  if (!raw) return 'unknown'
  try {
    return new URL(raw).host
  } catch {
    return raw.slice(0, 64)
  }
}

function classifyKind(detailKind: unknown): FailureKind {
  if (typeof detailKind !== 'string') return 'unknown'
  if (['missing', 'placeholder', 'malformed', 'unknown_key', 'expired'].includes(detailKind)) {
    return detailKind as FailureKind
  }
  return 'unknown'
}

function buildSummary(
  groups: FailureGroup[],
  windowLabel: string,
): string {
  if (groups.length === 0) return ''
  const top = groups[0]
  if (groups.length === 1) {
    return `${top.count} ${top.count === 1 ? 'request' : 'requests'} from ${top.origin} failed in the ${windowLabel} — ${top.kind === 'placeholder' ? 'API key is "undefined"' : top.kind === 'unknown_key' ? 'wrong API key' : top.kind === 'malformed' ? 'invalid API key format' : 'auth failure'}`
  }
  const total = groups.reduce((s, g) => s + g.count, 0)
  return `${total} requests from ${groups.length} origins failed in the ${windowLabel} — see breakdown below`
}

export async function GET(req: NextRequest) {
  return withProjectValidation(req, async ({ projectId }) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const since1h = new Date(Date.now() - 60 * 60 * 1000)

    const [events, project] = await Promise.all([
      prisma.securityEvent.findMany({
        where: {
          projectId,
          kind: { in: ['auth_failure', 'bootstrap'] },
          createdAt: { gte: since24h },
        },
        select: {
          kind: true,
          createdAt: true,
          detail: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { anonKey: true },
      }),
    ])

    // ── Bucket events by kind ────────────────────────────────────────────────
    // Drop events whose origin is the platform itself (backenly.com,
    // localhost). The v1 middleware already suppresses these at write-time,
    // but historical rows predating that fix still live in the SecurityEvent
    // table for 24h — filtering here makes the pill go green immediately
    // instead of trickling out as old rows age off.
    const customerEvents = events.filter(ev => {
      const detail = (ev.detail as Record<string, unknown> | null) ?? {}
      return !isInternalOrigin((detail.origin as string | null) ?? null)
    })

    const failureMap = new Map<string, FailureGroup>()  // key: origin|kind|sentKeyShape
    const successMap = new Map<string, SuccessGroup>()  // key: origin
    let failures1h = 0
    let attributableFailures24h = 0

    // Origin-less rejections cannot be a browser frontend: browsers always
    // attach an Origin header to cross-origin fetch/XHR, and the hosted SDK is
    // browser-first. No Origin AND no Referer means curl, a bot/scanner, or a
    // server-side script probing the public endpoint. Those are worth showing
    // — quietly — but they must never paint the "Frontend failing" pill red on
    // a healthy backend (evidence-first: a frontend finding needs a frontend).
    let probeCount = 0
    let probeLastSeen: string | null = null

    for (const ev of customerEvents) {
      const detail = (ev.detail as Record<string, unknown> | null) ?? {}
      const rawOrigin = (detail.origin as string | null) ?? null
      const origin = shortenOrigin(rawOrigin)
      const lastSeen = ev.createdAt.toISOString()

      if (ev.kind === 'auth_failure') {
        if (!rawOrigin) {
          probeCount += 1
          // Events are DESC — the first probe we touch is the most recent.
          if (!probeLastSeen) probeLastSeen = lastSeen
          continue
        }
        attributableFailures24h += 1
        if (ev.createdAt >= since1h) failures1h += 1
        const kind = classifyKind(detail.kind)
        const sentKeyShape = (detail.sentKeyShape as string | null) ?? null
        const key = `${origin}|${kind}|${sentKeyShape ?? ''}`
        const existing = failureMap.get(key)
        if (existing) {
          existing.count += 1
          // Keep the most recent lastSeen (events are in DESC order, so the
          // first time we touch a key is the most recent).
        } else {
          failureMap.set(key, {
            origin,
            kind,
            sentKeyShape,
            count: 1,
            lastSeen,
            hint: HINTS_BY_KIND[kind],
            fixPrompt: FIX_PROMPTS_BY_KIND[kind](projectId, project?.anonKey ?? null),
          })
        }
      } else if (ev.kind === 'bootstrap') {
        const existing = successMap.get(origin)
        if (existing) existing.count += 1
        else successMap.set(origin, { origin, count: 1, lastSeen })
      }
    }

    const failures = Array.from(failureMap.values()).sort((a, b) => b.count - a.count)
    const successes = Array.from(successMap.values()).sort((a, b) => b.count - a.count)

    return NextResponse.json({
      failures,
      successes,
      probes: {
        count: probeCount,
        lastSeen: probeLastSeen,
      },
      totals: {
        failures24h: attributableFailures24h,
        failures1h,
        bootstraps24h: customerEvents.filter(e => e.kind === 'bootstrap').length,
        distinctOriginsFailing: new Set(failures.map(f => f.origin)).size,
        distinctOriginsConnected: successes.length,
      },
      summaryText: buildSummary(failures, failures1h > 0 ? 'last hour' : 'last 24h'),
    })
  })
}
