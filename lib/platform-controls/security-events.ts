/**
 * The deployment's own security audit log.
 *
 * PUBLIC on purpose. Login, tenant isolation, bootstrap, the Express auth layer
 * and the v1 middleware all record events about the deployment they are running
 * in: failed logins, isolation violations, lockdowns, kill-switch flips. That
 * is security infrastructure a self-hoster needs to see about their own box,
 * not Backenly's growth telemetry about its customers.
 *
 * Internal Backenly product analytics is a different thing entirely and goes
 * through PlatformSignals. Do not route one through the other.
 */
import { prisma } from '@/lib/db/prisma'
import { addressNetwork, pathWithoutQuery, quotesKeptHere } from '@/lib/data-plane/residency'

// ─── Security event recorder ─────────────────────────────────────────────────

export interface SecurityEventInput {
  kind: string
  severity?: 'info' | 'warn' | 'high' | 'critical'
  userId?: string | null
  userEmail?: string | null
  projectId?: string | null
  ip?: string | null
  summary: string
  detail?: Record<string, unknown>
}

export async function recordSecurityEvent(ev: SecurityEventInput): Promise<void> {
  try {
    const event = ev.projectId && !(await quotesKeptHere(ev.projectId)) ? keptOutOfTheHomeRegion(ev) : ev
    await prisma.securityEvent.create({
      data: {
        kind: event.kind,
        severity: event.severity ?? 'info',
        userId: event.userId ?? null,
        userEmail: event.userEmail ?? null,
        projectId: event.projectId ?? null,
        ip: event.ip ?? null,
        summary: event.summary,
        detail: event.detail ? (event.detail as object) : undefined,
      },
    })
  } catch (err) {
    // Never let logging break a request — but make it visible in server logs.
    console.error('[SecurityEvent] failed to record:', (err as Error)?.message)
  }
}

/**
 * An event about a project kept in another region, as the platform database in
 * the home region may keep it (lib/data-plane/residency.ts). Its end users'
 * addresses become their network (/24 or /48), request paths lose their query
 * strings, whose values can be a filter on the project's rows, and user agents
 * are dropped. What happened, to which project, from which origin and through
 * which key stays, which is what the signal is for.
 */
function keptOutOfTheHomeRegion(ev: SecurityEventInput): SecurityEventInput {
  const detail = ev.detail ? { ...ev.detail } : undefined
  if (detail) {
    for (const key of ['path', 'url'] as const) {
      if (typeof detail[key] === 'string') detail[key] = pathWithoutQuery(detail[key] as string)
    }
    delete detail.userAgent
  }
  return { ...ev, ip: addressNetwork(ev.ip), detail }
}
