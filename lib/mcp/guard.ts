/**
 * MCP guard — the shared pre-flight + post-flight wrapper every /api/mcp/*
 * route runs through.
 *
 * Why a single guard (and not a Next.js middleware): Next middleware runs on
 * the Edge, but we need Prisma + node-only crypto. A small handler-side
 * wrapper keeps the routes thin without losing Node features.
 *
 * Responsibilities:
 *
 *   1. Authenticate (delegates to `authenticateMcp`).
 *   2. Plan-level quota — `enforceAndTrackApiRequest`. A Free user who has
 *      blown their lifetime cap cannot grind through their quota over MCP.
 *   3. Per-key rate limit — ApiKey.rateLimit / rateLimitWindow. Sliding
 *      window using the existing `requestCount` + `resetAt` columns. Prevents
 *      a runaway host-LLM loop from DOSing the brain.
 *   4. Post-call usage log — write an ApiKeyUsage row so the dashboard can
 *      show per-key activity AND so we can debug misbehaving hosts.
 *   5. Audit log on every MUTATION through MCP. Reads are excluded — they'd
 *      flood the audit trail with low-signal noise.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import {
  authenticateMcp,
  mcpAuthFailureResponse,
  type McpAuthResult,
} from './auth'
import { enforceAndTrackApiRequest } from '@/lib/billing/quota-kernel'

export interface McpGuardAuth {
  keyId: string
  projectId: string
  userId: string
  scope: string
}

/**
 * Guard result: when `response` is set, the route MUST return it (auth failed
 * / quota exceeded / rate limited). Otherwise `auth` is populated and the
 * route may proceed.
 *
 * We use plain optional fields rather than a discriminated union so the
 * Next.js strict TS build narrows reliably without needing helper predicates.
 */
export interface McpGuardResult {
  response: NextResponse | null
  auth: McpGuardAuth | null
}

/** Pre-flight: auth + quota + rate limit. Returns either a green-light or an HTTP response. */
export async function mcpGuard(request: NextRequest): Promise<McpGuardResult> {
  const auth = await authenticateMcp(request)
  const failure = mcpAuthFailureResponse(auth)
  if (failure) return { response: failure, auth: null }

  // Plan-level lifetime / monthly quota (fail-open on infra error inside the
  // kernel itself — that lib already swallows DB failures to ALLOW).
  const quota = await enforceAndTrackApiRequest(auth.userId!)
  if (!quota.allowed) {
    return {
      auth: null,
      response: NextResponse.json(
        {
          ok: false,
          error: quota.message ?? 'API quota exceeded for your plan.',
          code: quota.code ?? 'PLAN_LIMIT_EXCEEDED',
          plan: quota.plan,
          used: quota.used,
          max: quota.max,
        },
        { status: 429 },
      ),
    }
  }

  // Per-key sliding-window rate limit. Uses the existing requestCount +
  // resetAt columns on ApiKey. We do NOT block on a transactional contention
  // — if the increment races with another request, both go through. We are
  // protecting against runaway loops, not adversarial floods.
  const rate = await checkRateLimit(auth.keyId!)
  if (!rate.allowed) {
    return {
      auth: null,
      response: NextResponse.json(
        {
          ok: false,
          error: `Rate limit exceeded: ${rate.used}/${rate.limit} requests in the current window. Resets at ${rate.resetAt.toISOString()}.`,
          code: 'RATE_LIMITED',
          limit: rate.limit,
          used: rate.used,
          resetAt: rate.resetAt.toISOString(),
        },
        {
          status: 429,
          headers: {
            'retry-after': String(Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000))),
            'x-ratelimit-limit': String(rate.limit),
            'x-ratelimit-remaining': String(Math.max(0, rate.limit - rate.used)),
            'x-ratelimit-reset': rate.resetAt.toISOString(),
          },
        },
      ),
    }
  }

  return {
    response: null,
    auth: {
      keyId: auth.keyId!,
      projectId: auth.projectId!,
      userId: auth.userId!,
      scope: auth.scope ?? 'mcp',
    },
  }
}

interface RateCheckResult {
  allowed: boolean
  used: number
  limit: number
  resetAt: Date
}

async function checkRateLimit(keyId: string): Promise<RateCheckResult> {
  try {
    const key = await prisma.apiKey.findUnique({
      where: { id: keyId },
      select: { rateLimit: true, rateLimitWindow: true, requestCount: true, resetAt: true },
    })
    if (!key) return { allowed: true, used: 0, limit: 0, resetAt: new Date() }

    const limit = key.rateLimit || 600
    const windowSec = key.rateLimitWindow || 60
    const now = new Date()

    const expired = !key.resetAt || key.resetAt < now
    if (expired) {
      const nextReset = new Date(now.getTime() + windowSec * 1000)
      await prisma.apiKey.update({
        where: { id: keyId },
        data: { requestCount: 1, resetAt: nextReset },
      })
      return { allowed: true, used: 1, limit, resetAt: nextReset }
    }

    if (key.requestCount >= limit) {
      return { allowed: false, used: key.requestCount, limit, resetAt: key.resetAt! }
    }

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { requestCount: { increment: 1 } },
    })
    return { allowed: true, used: key.requestCount + 1, limit, resetAt: key.resetAt! }
  } catch {
    // Fail-open. A bug in rate limiting must not take down a customer's host.
    return { allowed: true, used: 0, limit: 0, resetAt: new Date() }
  }
}

export interface McpCallContext {
  keyId: string
  projectId: string
  userId: string
  endpoint: string
  startedAt: number
}

/**
 * Post-flight: write usage log + (for mutations) audit log. Fire-and-forget —
 * never block the response on telemetry writes.
 */
export function recordMcpCall(
  ctx: McpCallContext,
  result: {
    statusCode: number
    tool?: string
    mutation?: boolean
    summary?: string
    error?: string
  },
): void {
  const responseTime = Date.now() - ctx.startedAt

  prisma.apiKeyUsage
    .create({
      data: {
        apiKeyId: ctx.keyId,
        endpoint: ctx.endpoint,
        method: 'POST',
        statusCode: result.statusCode,
        responseTime,
        metadata: {
          tool: result.tool,
          mutation: !!result.mutation,
          summary: result.summary?.slice(0, 200),
          error: result.error?.slice(0, 200),
        },
      },
    })
    .catch(() => {})

  if (result.mutation && result.statusCode >= 200 && result.statusCode < 300) {
    prisma.auditLog
      .create({
        data: {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: 'MCP_TOOL_CALL',
          type: 'mcp',
          details: JSON.stringify({
            tool: result.tool,
            endpoint: ctx.endpoint,
            summary: result.summary?.slice(0, 240),
            ms: responseTime,
            at: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      })
      .catch(() => {})
  }
}
