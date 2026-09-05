/**
 * Project milestone flags: state the product itself reads.
 *
 * These used to live in lib/analytics/logger.ts, which was titled "Founder
 * Analytics" and is Backenly's own funnel telemetry. Filing them there made
 * them look internal. They are not, and the evidence is in who reads them:
 *
 *   isFrontendConnected  read by app/api/v1/[projectId]/bootstrap,
 *                        lib/api/v1/middleware, lib/ai/background-agent,
 *                        lib/ai/execution-cache, lib/services/connectFrontend,
 *                        lib/integrations/frontend.executor and
 *                        server/routes/bootstrap
 *   hasExternalUsers     read by lib/api/v1/middleware
 *
 * That is public product code deciding behaviour on a column. It has to keep
 * working with no Cloud overlay applied.
 *
 * So the two halves are separated rather than moved together: setting the flag
 * is product state and happens here, and reporting the funnel event is
 * Backenly's business and goes through PlatformSignals, where single-tenant
 * does nothing at all.
 *
 * Everything here is fire-and-forget and must never throw. Callers are on
 * request paths, and failing to record that a milestone happened cannot be
 * allowed to fail the request that achieved it.
 */
import { prisma } from '@/lib/db/prisma'
import { recordProductEvent } from '@/lib/platform-signals'

/** The project now has a generated backend. */
export function markBackendGenerated(projectId: string, userId: string): void {
  prisma.project
    .update({
      where: { id: projectId },
      data: { isBackendGenerated: true },
    })
    .catch((err) => {
      console.error('[Milestones] Failed to mark backend generated:', err?.message)
    })
  recordProductEvent({ type: 'backend_generated', userId, projectId })
}

/**
 * A frontend has called this project through an API key.
 *
 * The updateMany with `isFrontendConnected: false` in the where clause is doing
 * real work: it makes the write idempotent and skips it entirely once the flag
 * is set, which matters because this runs on every API request.
 */
export function markFrontendConnected(projectId: string, userId: string): void {
  prisma.project
    .updateMany({
      where: { id: projectId, isFrontendConnected: false },
      data: { isFrontendConnected: true },
    })
    .catch((err) => {
      console.error('[Milestones] Failed to mark frontend connected:', err?.message)
    })
  recordProductEvent({ type: 'frontend_connected', userId, projectId })
}

/**
 * The project went live.
 *
 * No column write: isDeployed is already set by the go-live service. This
 * exists so the caller has one place to report the milestone from.
 */
export function markDeployed(projectId: string, userId: string): void {
  recordProductEvent({ type: 'deployed', userId, projectId })
}

/** The project is serving real external users, not just dashboard traffic. */
export function markExternalUsage(projectId: string, userId: string): void {
  prisma.project
    .updateMany({
      where: { id: projectId, hasExternalUsers: false },
      data: { hasExternalUsers: true },
    })
    .catch((err) => {
      console.error('[Milestones] Failed to mark external usage:', err?.message)
    })
  recordProductEvent({ type: 'external_usage_started', userId, projectId })
}
