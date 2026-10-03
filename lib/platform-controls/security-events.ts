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
    await prisma.securityEvent.create({
      data: {
        kind: ev.kind,
        severity: ev.severity ?? 'info',
        userId: ev.userId ?? null,
        userEmail: ev.userEmail ?? null,
        projectId: ev.projectId ?? null,
        ip: ev.ip ?? null,
        summary: ev.summary,
        detail: ev.detail ? (ev.detail as object) : undefined,
      },
    })
  } catch (err) {
    // Never let logging break a request — but make it visible in server logs.
    console.error('[SecurityEvent] failed to record:', (err as Error)?.message)
  }
}
