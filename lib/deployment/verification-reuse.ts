/**
 * The behavioral verifier's latest result for a project, reused by the pages
 * that show it while the backend is the one it verified.
 *
 * GET /build-status (the Overview's badge, through the deep scan) and GET
 * /readiness (the Deploy page) ran the verifier on every request. It signs a
 * test user up twice, once over HTTP back into the same web task, and writes
 * and removes rows in the project's tables: 97% of /build-status's time. The
 * Overview asks for /build-status three times per load and the Deploy page for
 * /readiness twice (production QA, 2026-11-09: 5.0–8.4 s and 3.4–4.2 s each).
 *
 * A result is reused while the project's latest governed change is still the
 * one it was taken after, and for at most five minutes. Every change to the
 * backend is a governed change, so a new one means a new run. Requests that
 * arrive together share one run. Go-live, an explicit fix and an agent's
 * readiness check still run the verifier themselves.
 */

import { prisma } from '@/lib/db/prisma'
import type { BehavioralVerificationResult } from '@/lib/ai/behavioral-verifier'

export const VERIFICATION_REUSE_MS = 5 * 60_000
/** Projects whose result is kept, oldest dropped first. */
const KEPT_PROJECTS = 500

interface Kept {
  version: string
  startedAt: number
  result: Promise<BehavioralVerificationResult>
}

const kept = new Map<string, Kept>()

/** The backend as of its latest governed change, and that change's state. */
async function backendVersion(projectId: string): Promise<string> {
  const latest = await prisma.backendChange.findFirst({
    where: { projectId },
    orderBy: { seq: 'desc' },
    select: { seq: true, status: true },
  })
  return latest ? `${latest.seq}:${latest.status}` : 'none'
}

export async function recentBehavioralVerification(projectId: string): Promise<BehavioralVerificationResult> {
  const version = await backendVersion(projectId)
  const hit = kept.get(projectId)
  if (hit && hit.version === version && Date.now() - hit.startedAt < VERIFICATION_REUSE_MS) return hit.result

  // Kept before anything else is awaited, so a request arriving meanwhile
  // shares this run instead of starting its own.
  const result = import('@/lib/ai/behavioral-verifier').then(({ runBehavioralVerification }) =>
    runBehavioralVerification(projectId),
  )
  kept.delete(projectId)
  kept.set(projectId, { version, startedAt: Date.now(), result })
  if (kept.size > KEPT_PROJECTS) {
    const oldest = kept.keys().next().value
    if (oldest !== undefined) kept.delete(oldest)
  }
  // A run that could not finish is not kept: the next read tries again.
  result.catch(() => {
    if (kept.get(projectId)?.result === result) kept.delete(projectId)
  })
  return result
}

/** For tests: forget every kept result. */
export function forgetBehavioralVerifications(): void {
  kept.clear()
}
