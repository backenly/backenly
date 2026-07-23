/**
 * Founder Analytics Event Logger
 *
 * Non-blocking fire-and-forget event logger.
 * All functions are safe to call without await from hot paths.
 */

import { prisma } from '@/lib/db/prisma'

export type EventType =
  | 'signup'
  | 'project_created'
  | 'backend_generated'
  | 'frontend_connected'
  | 'deployed'
  | 'external_usage_started'
  | 'ai_prompt'
  | 'api_call'

/**
 * Log a product funnel event. Non-blocking — never throws.
 */
export function logEvent(
  eventType: EventType,
  userId: string,
  projectId?: string,
  metadata?: Record<string, unknown>
): void {
  // Fire and forget — must never block the caller
  prisma.productEvent
    .create({
      data: {
        eventType,
        userId,
        projectId: projectId ?? null,
        metadata: metadata ? (metadata as object) : undefined,
      },
    })
    .catch((err) => {
      console.error('[Analytics] Failed to log event:', eventType, err?.message)
    })
}

/**
 * Mark a project as having a generated backend.
 * Also logs the funnel event. Non-blocking.
 */
export function markBackendGenerated(projectId: string, userId: string): void {
  prisma.project
    .update({
      where: { id: projectId },
      data: { isBackendGenerated: true },
    })
    .catch((err) => {
      console.error('[Analytics] Failed to mark backend generated:', err?.message)
    })
  logEvent('backend_generated', userId, projectId)
}

/**
 * Mark a project as having its frontend connected (called via API key / external origin).
 * Non-blocking.
 */
export function markFrontendConnected(projectId: string, userId: string): void {
  prisma.project
    .updateMany({
      where: { id: projectId, isFrontendConnected: false },
      data: { isFrontendConnected: true },
    })
    .catch((err) => {
      console.error('[Analytics] Failed to mark frontend connected:', err?.message)
    })
  logEvent('frontend_connected', userId, projectId)
}

/**
 * Mark a project as deployed. Non-blocking.
 */
export function markDeployed(projectId: string, userId: string): void {
  // isDeployed is already updated by the go-live service; we just log the event
  logEvent('deployed', userId, projectId)
}

/**
 * Mark a project as having real external users (non-dashboard traffic via API key).
 * Non-blocking.
 */
export function markExternalUsage(projectId: string, userId: string): void {
  prisma.project
    .updateMany({
      where: { id: projectId, hasExternalUsers: false },
      data: { hasExternalUsers: true },
    })
    .catch((err) => {
      console.error('[Analytics] Failed to mark external usage:', err?.message)
    })
  logEvent('external_usage_started', userId, projectId)
}

/**
 * Increment usage metrics for a user/project (daily bucket).
 * Non-blocking.
 */
export function trackUsage(
  userId: string,
  projectId: string | undefined,
  delta: {
    apiCalls?: number
    dbReads?: number
    dbWrites?: number
    aiCalls?: number
    computeTime?: number
  }
): void {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Upsert daily bucket
  prisma.usageMetric
    .upsert({
      where: {
        // We need a unique key — use a synthetic one
        id: `${userId}:${projectId ?? 'global'}:${today.toISOString().slice(0, 10)}`,
      },
      update: {
        apiCalls: { increment: delta.apiCalls ?? 0 },
        dbReads: { increment: delta.dbReads ?? 0 },
        dbWrites: { increment: delta.dbWrites ?? 0 },
        aiCalls: { increment: delta.aiCalls ?? 0 },
        computeTime: { increment: delta.computeTime ?? 0 },
      },
      create: {
        id: `${userId}:${projectId ?? 'global'}:${today.toISOString().slice(0, 10)}`,
        userId,
        projectId: projectId ?? null,
        apiCalls: delta.apiCalls ?? 0,
        dbReads: delta.dbReads ?? 0,
        dbWrites: delta.dbWrites ?? 0,
        aiCalls: delta.aiCalls ?? 0,
        computeTime: delta.computeTime ?? 0,
        date: today,
      },
    })
    .catch((err) => {
      console.error('[Analytics] Failed to track usage:', err?.message)
    })
}
